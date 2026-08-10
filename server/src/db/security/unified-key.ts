import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { credentialVault, DPAPI_ENCRYPTION_SCHEME } from '../../lib/dpapi-vault.js'

const TOKEN_NAME = 'gloryapi-unified-api-key'

type LocalTokenRow = {
  encrypted_token: string
  fingerprint: string
  encryption_scheme: string
  enabled: number
}

function readProtectedToken(db: Database.Database): LocalTokenRow | undefined {
  return db.prepare(`
    SELECT encrypted_token, fingerprint, encryption_scheme, enabled
    FROM local_auth_tokens WHERE name = ?
  `).get(TOKEN_NAME) as LocalTokenRow | undefined
}

function assertValidToken(row: LocalTokenRow): void {
  if (row.encryption_scheme !== DPAPI_ENCRYPTION_SCHEME || row.enabled !== 1) {
    throw new Error('Unified API key local token is not a valid DPAPI credential')
  }
}

export function ensureUnifiedKey(db: Database.Database): void {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined
  if (db.name === ':memory:') {
    if (!existing) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(`gloryapi-${crypto.randomBytes(24).toString('hex')}`)
    }
    return
  }

  const protectedRow = readProtectedToken(db)
  if (!protectedRow) {
    const key = existing?.value ?? `gloryapi-${crypto.randomBytes(24).toString('hex')}`
    const protectedToken = credentialVault.protect(key)
    db.prepare(`
      INSERT INTO local_auth_tokens
        (name, encrypted_token, fingerprint, encryption_scheme, enabled, created_at, rotated_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'), NULL)
    `).run(TOKEN_NAME, protectedToken.ciphertext, protectedToken.fingerprint, DPAPI_ENCRYPTION_SCHEME)
    db.prepare("DELETE FROM settings WHERE key = 'unified_api_key'").run()
    console.log('Unified API key migrated to the DPAPI local token vault.')
    return
  }

  assertValidToken(protectedRow)
  if (existing) {
    const resolved = credentialVault.resolve({ ciphertext: protectedRow.encrypted_token, fingerprint: protectedRow.fingerprint })
    if (resolved !== existing.value) throw new Error('Unified API key migration fingerprint mismatch')
    db.prepare("DELETE FROM settings WHERE key = 'unified_api_key'").run()
  }
}

export function getUnifiedApiKey(db: Database.Database): string {
  const token = readProtectedToken(db)
  if (token) {
    assertValidToken(token)
    return credentialVault.resolve({ ciphertext: token.encrypted_token, fingerprint: token.fingerprint })
  }
  if (db.name !== ':memory:') {
    throw new Error('Unified API key DPAPI token is missing from persistent database')
  }
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined
  if (!legacy?.value) throw new Error('Unified API key is not configured')
  return legacy.value
}

export function regenerateUnifiedKey(db: Database.Database): string {
  const key = `gloryapi-${crypto.randomBytes(24).toString('hex')}`
  if (db.name === ':memory:') {
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key)
    return key
  }
  const protectedToken = credentialVault.protect(key)
  db.prepare(`
    INSERT INTO local_auth_tokens
      (name, encrypted_token, fingerprint, encryption_scheme, enabled, created_at, rotated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      encrypted_token = excluded.encrypted_token,
      fingerprint = excluded.fingerprint,
      encryption_scheme = excluded.encryption_scheme,
      enabled = 1,
      rotated_at = datetime('now')
  `).run(TOKEN_NAME, protectedToken.ciphertext, protectedToken.fingerprint, DPAPI_ENCRYPTION_SCHEME)
  db.prepare("DELETE FROM settings WHERE key = 'unified_api_key'").run()
  return key
}
