import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { decrypt } from './crypto.js'

const DPAPI_COMMAND = 'powershell.exe'
const DPAPI_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 30_000
const MAX_SECRET_BYTES = 1_048_576
const MAX_PROTECTED_BYTES = 2 * 1_048_576
export const DPAPI_ENCRYPTION_SCHEME = 'dpapi-current-user' as const

export interface ProtectedCredential {
  fingerprint: string
  ciphertext: string
}

export interface CredentialVault {
  protect(secret: string): ProtectedCredential
  resolve(credential: ProtectedCredential): string
}

export interface StoredCredentialRow {
  encrypted_key: string
  iv: string
  auth_tag: string
  encryption_scheme?: string
  fingerprint?: string | null
}

interface DpapiResponse {
  ok: boolean
  data?: string
  error?: string
}

interface JsonRecord {
  [key: string]: unknown
}

interface CachedSecret {
  fingerprint: string
  secret: string
  expiresAt: number
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GloryDpapi {
  [StructLayout(LayoutKind.Sequential)]
  public struct DataBlob { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  public static extern bool CryptProtectData(ref DataBlob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DataBlob output);
  [DllImport("Crypt32.dll", SetLastError=true)]
  public static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DataBlob output);
  [DllImport("Kernel32.dll", SetLastError=true)]
  public static extern IntPtr LocalFree(IntPtr handle);
}
'@
function Invoke-Dpapi([byte[]] $bytes, [bool] $protect) {
  $inputPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $inputPtr, $bytes.Length)
    $inputBlob = New-Object GloryDpapi+DataBlob
    $inputBlob.cbData = $bytes.Length
    $inputBlob.pbData = $inputPtr
    $outputBlob = New-Object GloryDpapi+DataBlob
    $success = if ($protect) {
      [GloryDpapi]::CryptProtectData([ref] $inputBlob, 'GloryAPI credential', [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref] $outputBlob)
    } else {
      [GloryDpapi]::CryptUnprotectData([ref] $inputBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref] $outputBlob)
    }
    if (-not $success) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    try {
      $result = New-Object byte[] $outputBlob.cbData
      [Runtime.InteropServices.Marshal]::Copy($outputBlob.pbData, $result, 0, $outputBlob.cbData)
      return $result
    } finally {
      [GloryDpapi]::LocalFree($outputBlob.pbData) | Out-Null
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($inputPtr)
  }
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String([string] $request.payload)
  $result = Invoke-Dpapi $bytes ([string] $request.operation -eq 'protect')
  [Console]::Out.Write((@{ ok = $true; data = [Convert]::ToBase64String($result) } | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDpapiResponse(stdout: string): DpapiResponse {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('DPAPI helper returned an invalid response')
  }
  if (!isRecord(value) || value.ok !== true || typeof value.data !== 'string') {
    throw new Error('DPAPI helper returned an invalid response')
  }
  return { ok: true, data: value.data }
}

function runDpapi(operation: 'protect' | 'unprotect', payload: Buffer): Buffer {
  if (process.platform !== 'win32') {
    throw new Error('Windows DPAPI vault requires Windows')
  }
  if (payload.length === 0 || payload.length > MAX_SECRET_BYTES) {
    throw new Error('Credential payload exceeds the DPAPI vault limit')
  }
  const result = spawnSync(
    DPAPI_COMMAND,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')],
    {
      input: JSON.stringify({ operation, payload: payload.toString('base64') }),
      encoding: 'utf8',
      timeout: DPAPI_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (result.error || result.status !== 0) {
    throw new Error('Windows DPAPI operation failed')
  }
  const response = readDpapiResponse(result.stdout)
  const decoded = Buffer.from(response.data ?? '', 'base64')
  if (decoded.length === 0 || decoded.length > MAX_PROTECTED_BYTES) {
    throw new Error('DPAPI helper returned an invalid payload size')
  }
  return decoded
}

function fingerprint(secret: Buffer): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

function parseFingerprint(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('Invalid credential fingerprint')
  return Buffer.from(value, 'hex')
}

function parseCiphertext(value: string): Buffer {
  const ciphertext = Buffer.from(value, 'base64')
  if (ciphertext.length === 0 || ciphertext.length > MAX_PROTECTED_BYTES || ciphertext.toString('base64') !== value) {
    throw new Error('Invalid protected credential')
  }
  return ciphertext
}

export class WindowsDpapiVault implements CredentialVault {
  private readonly cache = new Map<string, CachedSecret>()

  protect(secret: string): ProtectedCredential {
    const plaintext = Buffer.from(secret, 'utf8')
    if (plaintext.length === 0 || plaintext.length > MAX_SECRET_BYTES) {
      throw new Error('Credential secret exceeds the DPAPI vault limit')
    }
    const protectedCredential = {
      fingerprint: fingerprint(plaintext),
      ciphertext: runDpapi('protect', plaintext).toString('base64'),
    }
    this.cache.set(protectedCredential.ciphertext, {
      ...protectedCredential,
      secret,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return protectedCredential
  }

  resolve(credential: ProtectedCredential): string {
    const expectedFingerprint = parseFingerprint(credential.fingerprint)
    const cached = this.cache.get(credential.ciphertext)
    if (cached && cached.expiresAt > Date.now()) {
      const cachedFingerprint = parseFingerprint(cached.fingerprint)
      if (crypto.timingSafeEqual(expectedFingerprint, cachedFingerprint)) return cached.secret
    } else if (cached) {
      this.cache.delete(credential.ciphertext)
    }

    const plaintext = runDpapi('unprotect', parseCiphertext(credential.ciphertext))
    const actualFingerprint = Buffer.from(fingerprint(plaintext), 'hex')
    if (!crypto.timingSafeEqual(expectedFingerprint, actualFingerprint)) {
      throw new Error('Credential fingerprint mismatch')
    }
    const secret = plaintext.toString('utf8')
    this.cache.set(credential.ciphertext, {
      fingerprint: credential.fingerprint,
      secret,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return secret
  }
}

export const credentialVault: CredentialVault = new WindowsDpapiVault()

/**
 * Transitional reader for rows created before DPAPI integration. New writes use
 * DPAPI and the legacy AES path remains only so an explicit migration can read
 * an isolated pre-DPAPI snapshot without opening the legacy installation.
 */
export function resolveStoredCredential(row: StoredCredentialRow): string {
  if (row.encryption_scheme === DPAPI_ENCRYPTION_SCHEME) {
    if (!row.fingerprint) throw new Error('DPAPI credential is missing its fingerprint')
    return credentialVault.resolve({ fingerprint: row.fingerprint, ciphertext: row.encrypted_key })
  }
  return decrypt(row.encrypted_key, row.iv, row.auth_tag)
}
