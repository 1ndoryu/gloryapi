import crypto from 'node:crypto'
import { getDb } from '../db/index.js'
import { credentialVault, DPAPI_ENCRYPTION_SCHEME } from './dpapi-vault.js'

const TOKEN_BYTES = 32
const DEFAULT_TOKEN_NAME = 'codex-bridge'

interface LocalAuthTokenRow {
  encrypted_token: string
  fingerprint: string
  encryption_scheme: string
  enabled: number
}

export interface LocalAuthTokenMetadata {
  name: string
  fingerprint: string
  encryptionScheme: typeof DPAPI_ENCRYPTION_SCHEME
  enabled: boolean
  createdAt: string
  rotatedAt: string | null
}

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
}

function storeToken(name: string, token: string): void {
  const protectedToken = credentialVault.protect(token)
  getDb().prepare(`
    INSERT INTO local_auth_tokens (
      name, encrypted_token, fingerprint, encryption_scheme, enabled, created_at, rotated_at
    ) VALUES (?, ?, ?, ?, 1, datetime('now'), NULL)
    ON CONFLICT(name) DO UPDATE SET
      encrypted_token = excluded.encrypted_token,
      fingerprint = excluded.fingerprint,
      encryption_scheme = excluded.encryption_scheme,
      enabled = 1,
      rotated_at = datetime('now')
  `).run(
    name,
    protectedToken.ciphertext,
    protectedToken.fingerprint,
    DPAPI_ENCRYPTION_SCHEME,
  )
}

export function createLocalAuthToken(name = DEFAULT_TOKEN_NAME): string {
  const token = generateToken()
  storeToken(name, token)
  return token
}

export function rotateLocalAuthToken(name = DEFAULT_TOKEN_NAME): string {
  return createLocalAuthToken(name)
}

export function resolveLocalAuthToken(name = DEFAULT_TOKEN_NAME): string {
  const row = getDb().prepare(`
    SELECT encrypted_token, fingerprint, encryption_scheme, enabled
    FROM local_auth_tokens
    WHERE name = ?
  `).get(name) as LocalAuthTokenRow | undefined
  if (!row || row.enabled !== 1) throw new Error('Local auth token is not configured')
  if (row.encryption_scheme !== DPAPI_ENCRYPTION_SCHEME) {
    throw new Error('Local auth token uses an unsupported encryption scheme')
  }
  return credentialVault.resolve({ ciphertext: row.encrypted_token, fingerprint: row.fingerprint })
}

export function getLocalAuthTokenMetadata(name = DEFAULT_TOKEN_NAME): LocalAuthTokenMetadata | null {
  const row = getDb().prepare(`
    SELECT name, fingerprint, encryption_scheme, enabled, created_at, rotated_at
    FROM local_auth_tokens
    WHERE name = ?
  `).get(name) as {
    name: string
    fingerprint: string
    encryption_scheme: string
    enabled: number
    created_at: string
    rotated_at: string | null
  } | undefined
  if (!row) return null
  if (row.encryption_scheme !== DPAPI_ENCRYPTION_SCHEME) {
    throw new Error('Local auth token uses an unsupported encryption scheme')
  }
  return {
    name: row.name,
    fingerprint: row.fingerprint,
    encryptionScheme: DPAPI_ENCRYPTION_SCHEME,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  }
}

export { DEFAULT_TOKEN_NAME }
