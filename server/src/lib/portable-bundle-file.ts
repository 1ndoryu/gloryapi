import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { exportCredentialBundle, importCredentialBundle, type CredentialBundleEntry, type CredentialBundleInput } from './vault-bundle.js'

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024
const ACL_TIMEOUT_MS = 5_000

function currentWindowsIdentity(): string {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || '.'
  const username = process.env.USERNAME
  if (!username) throw new Error('Windows user identity is unavailable')
  return `${domain}\\${username}`
}

function applyUserOnlyAcl(filePath: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600)
    return
  }

  const result = spawnSync(
    'icacls.exe',
    [filePath, '/inheritance:r', '/grant:r', `${currentWindowsIdentity()}:(R,W)`],
    { encoding: 'utf8', timeout: ACL_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
  )
  if (result.error || result.status !== 0) {
    throw new Error('Unable to restrict credential bundle ACL to the current user')
  }
}

function assertBundleSize(serialized: string): void {
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes === 0 || bytes > MAX_BUNDLE_BYTES) {
    throw new Error('Credential bundle file exceeds the bounded file size')
  }
}

function assertRegularBundleFile(filePath: string): void {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BUNDLE_BYTES) {
    throw new Error('Credential bundle file is invalid or exceeds the bounded file size')
  }
}

/**
 * Writes an already encrypted bundle atomically. Plaintext credentials and the
 * passphrase never enter this module's filesystem path or diagnostics.
 */
export function writeCredentialBundleFile(filePath: string, serialized: string): string {
  assertBundleSize(serialized)
  const destination = path.resolve(filePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, serialized, { encoding: 'utf8' })
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    applyUserOnlyAcl(temporary)
    fs.renameSync(temporary, destination)
    return destination
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* already renamed or cleaned */ }
  }
}

export function exportCredentialBundleFile(
  filePath: string,
  credentials: CredentialBundleInput[],
  passphrase: string,
): string {
  return writeCredentialBundleFile(filePath, exportCredentialBundle(credentials, passphrase))
}

export function importCredentialBundleFile(filePath: string, passphrase: string): CredentialBundleEntry[] {
  const source = path.resolve(filePath)
  assertRegularBundleFile(source)
  const serialized = fs.readFileSync(source, 'utf8')
  assertBundleSize(serialized)
  return importCredentialBundle(serialized, passphrase)
}
