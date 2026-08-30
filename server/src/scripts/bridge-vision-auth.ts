import Database from 'better-sqlite3'
import { credentialVault, DPAPI_ENCRYPTION_SCHEME } from '../lib/dpapi-vault.js'
import { resolveDatabasePath } from '../config/database-path.js'

const dbPath = resolveDatabasePath()
const DEFAULT_VISION_PLATFORM = 'opencode-go'
const ALLOWED_VISION_PLATFORMS = new Set(['opencode-go', 'opencode-zen'])

function readVisionKey(platform = DEFAULT_VISION_PLATFORM): string {
  if (!ALLOWED_VISION_PLATFORMS.has(platform)) throw new Error('unsupported vision platform')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT encrypted_key, fingerprint, encryption_scheme, enabled
      FROM api_keys
      WHERE platform = ? AND enabled = 1 AND status != 'invalid'
      ORDER BY CASE status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END,
               COALESCE(last_checked_at, '') DESC, id DESC
      LIMIT 1
    `).get(platform) as {
      encrypted_key?: unknown; fingerprint?: unknown; encryption_scheme?: unknown; enabled?: number;
    } | undefined
    if (!row || row.enabled !== 1 || row.encryption_scheme !== DPAPI_ENCRYPTION_SCHEME
      || typeof row.encrypted_key !== 'string' || typeof row.fingerprint !== 'string') {
      throw new Error('vision key unavailable')
    }
    return credentialVault.resolve({ ciphertext: row.encrypted_key, fingerprint: row.fingerprint })
  } finally {
    db.close()
  }
}

function parseArguments(): { command: '--print' | '--check'; platform: string } {
  let command: '--print' | '--check' = '--check'
  let platform = DEFAULT_VISION_PLATFORM
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--print' || argument === '--check') {
      command = argument
      continue
    }
    if (argument === '--platform' && process.argv[index + 1]) {
      platform = process.argv[index + 1]
      index += 1
      continue
    }
    throw new Error('unsupported command')
  }
  if (!ALLOWED_VISION_PLATFORMS.has(platform)) throw new Error('unsupported vision platform')
  return { command, platform }
}

try {
  const { command, platform } = parseArguments()
  const key = readVisionKey(platform)
  if (command === '--print') {
    process.stdout.write(`${key}\n`)
  } else if (command === '--check') {
    process.stdout.write('ok\n')
  } else {
    throw new Error('unsupported command')
  }
} catch {
  process.stderr.write('bridge-vision-auth failed: local vision key unavailable\n')
  process.exitCode = 1
}
