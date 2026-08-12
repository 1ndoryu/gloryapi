import Database from 'better-sqlite3'
import { credentialVault, DPAPI_ENCRYPTION_SCHEME } from '../lib/dpapi-vault.js'
import { resolveDatabasePath } from '../config/database-path.js'

const dbPath = resolveDatabasePath()
const visionPlatform = 'opencode-go'

function readVisionKey(): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT encrypted_key, fingerprint, encryption_scheme, enabled
      FROM api_keys
      WHERE platform = ? AND enabled = 1 AND status != 'invalid'
      ORDER BY CASE status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END,
               COALESCE(last_checked_at, '') DESC, id DESC
      LIMIT 1
    `).get(visionPlatform) as {
      encrypted_key?: unknown; fingerprint?: unknown; encryption_scheme?: unknown; enabled?: number;
    } | undefined
    if (!row || row.enabled !== 1 || row.encryption_scheme !== DPAPI_ENCRYPTION_SCHEME
      || typeof row.encrypted_key !== 'string' || typeof row.fingerprint !== 'string') {
      throw new Error('opencode-go vision key unavailable')
    }
    return credentialVault.resolve({ ciphertext: row.encrypted_key, fingerprint: row.fingerprint })
  } finally {
    db.close()
  }
}

try {
  const command = process.argv[2] ?? '--check'
  const key = readVisionKey()
  if (command === '--print') {
    process.stdout.write(`${key}\n`)
  } else if (command === '--check') {
    process.stdout.write('ok\n')
  } else {
    throw new Error('unsupported command')
  }
} catch {
  process.stderr.write('bridge-vision-auth failed: local opencode-go key unavailable\n')
  process.exitCode = 1
}
