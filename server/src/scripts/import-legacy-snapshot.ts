import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getDb, initDb } from '../db/index.js'
import { decrypt, initEncryptionKey } from '../lib/crypto.js'
import { importCredentialEntriesIntoDatabase } from '../lib/credential-import.js'
import type { CredentialBundleEntry } from '../lib/vault-bundle.js'

interface LegacyCredentialRow {
  platform: string
  label: string
  encrypted_key: string
  iv: string
  auth_tag: string
}

function requireExternalSnapshot(): string {
  const configured = process.env.GLORYAPI_LEGACY_SNAPSHOT_PATH?.trim()
  if (!configured) throw new Error('GLORYAPI_LEGACY_SNAPSHOT_PATH is required')
  const snapshotPath = path.resolve(configured)
  const repositoryRoot = path.resolve(process.cwd())
  const relative = path.relative(repositoryRoot, snapshotPath)
  if (!path.isAbsolute(relative) && !relative.startsWith('..')) {
    throw new Error('Legacy snapshot must be outside the GloryAPI repository')
  }
  if (!fs.existsSync(snapshotPath)) throw new Error('Legacy snapshot does not exist')
  return snapshotPath
}

function hashFingerprintSet(credentials: CredentialBundleEntry[]): string {
  return crypto.createHash('sha256')
    .update(credentials.map(credential => {
      const fingerprint = crypto.createHash('sha256').update(credential.secret, 'utf8').digest('hex')
      return `${credential.platform}:${fingerprint}`
    }).sort().join('\n'))
    .digest('hex')
}

function readLegacyEncryptionKey(): string | undefined {
  const envPath = process.env.GLORYAPI_LEGACY_ENV_PATH?.trim()
  if (!envPath) return undefined
  const absolutePath = path.resolve(envPath)
  const line = fs.readFileSync(absolutePath, 'utf8')
    .split(/\r?\n/)
    .find(value => value.startsWith('ENCRYPTION_KEY='))
  const value = line?.slice('ENCRYPTION_KEY='.length).trim().replace(/^['"]|['"]$/g, '')
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('Legacy env has no valid ENCRYPTION_KEY')
  return value
}

function readLegacyCredentials(snapshotPath: string): CredentialBundleEntry[] {
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true })
  const previousEncryptionKey = process.env.ENCRYPTION_KEY
  delete process.env.ENCRYPTION_KEY
  try {
    const legacyEnvKey = readLegacyEncryptionKey()
    if (legacyEnvKey) process.env.ENCRYPTION_KEY = legacyEnvKey
    initEncryptionKey(snapshot)
    const rows = snapshot.prepare(`
      SELECT platform, label, encrypted_key, iv, auth_tag
      FROM api_keys
      ORDER BY id ASC
    `).all() as LegacyCredentialRow[]
    return rows.map(row => {
      const secret = decrypt(row.encrypted_key, row.iv, row.auth_tag)
      return {
        platform: row.platform,
        label: row.label,
        secret,
        fingerprint: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
      }
    })
  } finally {
    snapshot.close()
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = previousEncryptionKey
  }
}

const snapshotPath = requireExternalSnapshot()
const snapshotSha256 = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex')
const legacyEnvPath = process.env.GLORYAPI_LEGACY_ENV_PATH?.trim()
if (legacyEnvPath && !fs.existsSync(path.resolve(legacyEnvPath))) throw new Error('Legacy env path does not exist')
const credentials = readLegacyCredentials(snapshotPath)
const fingerprintSetSha256 = hashFingerprintSet(credentials)
const target = initDb()
const report = importCredentialEntriesIntoDatabase(getDb(), credentials)

console.log(JSON.stringify({
  snapshotPath,
  snapshotSha256,
  sourceCredentialCount: credentials.length,
  fingerprintSetSha256,
  ...report,
  targetCredentialCount: (target.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as { count: number }).count,
}, null, 2))
