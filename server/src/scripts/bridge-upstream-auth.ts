import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialVault, DPAPI_ENCRYPTION_SCHEME } from '../lib/dpapi-vault.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultDbPath = path.resolve(__dirname, '../../data/gloryapi.db')
const dbPath = path.resolve(process.env.GLORYAPI_DB_PATH?.trim() || defaultDbPath)
// The legacy settings key `unified_api_key` is migrated to this DPAPI token.
const tokenName = 'gloryapi-unified-api-key'

function readUnifiedKey(): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT encrypted_token, fingerprint, encryption_scheme, enabled
      FROM local_auth_tokens WHERE name = ?
    `).get(tokenName) as {
      encrypted_token?: unknown; fingerprint?: unknown; encryption_scheme?: unknown; enabled?: number;
    } | undefined
    if (!row || row.enabled !== 1 || row.encryption_scheme !== DPAPI_ENCRYPTION_SCHEME
      || typeof row.encrypted_token !== 'string' || typeof row.fingerprint !== 'string') {
      throw new Error('unified key DPAPI token unavailable')
    }
    return credentialVault.resolve({ ciphertext: row.encrypted_token, fingerprint: row.fingerprint })
  } finally {
    db.close()
  }
}

try {
  const command = process.argv[2] ?? '--check'
  const key = readUnifiedKey()
  if (command === '--print') {
    process.stdout.write(`${key}\n`)
  } else if (command === '--check') {
    process.stdout.write('ok\n')
  } else {
    throw new Error('unsupported command')
  }
} catch {
  process.stderr.write('bridge-upstream-auth failed: local key unavailable\n')
  process.exitCode = 1
}
