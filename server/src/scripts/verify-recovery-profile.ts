import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { initDb } from '../db/index.js'
import { credentialVault, type StoredCredentialRow } from '../lib/dpapi-vault.js'
import { recoverCredentialBundleFile } from '../lib/credential-recovery.js'
import { exportCredentialBundleFile } from '../lib/portable-bundle-file.js'

const FIXTURE_PASSPHRASE_MIN_LENGTH = 12

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]?.trim()
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function externalPath(value: string, label: string): string {
  const resolved = path.resolve(value)
  const repositoryRoot = path.resolve(process.cwd())
  const repositoryRealRoot = fs.realpathSync.native(repositoryRoot)
  const relative = path.relative(repositoryRoot, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the GloryAPI repository`)
  }
  const root = path.parse(resolved).root
  let cursor = root
  for (const component of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    try {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symlink or junction`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  let ancestor = resolved
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const physicalAncestor = fs.realpathSync.native(ancestor)
  const physicalRelative = path.relative(repositoryRealRoot, physicalAncestor)
  if (physicalRelative === '' || (!physicalRelative.startsWith('..') && !path.isAbsolute(physicalRelative))) {
    throw new Error(`${label} must resolve outside the physical GloryAPI repository`)
  }
  return resolved
}

function rejectExistingDestination(filePath: string, label: string): void {
  try {
    const stat = fs.lstatSync(filePath)
    throw new Error(`${label} already exists (${stat.isSymbolicLink() ? 'symlink' : 'destination'}); choose a new path`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function requireRegularFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
}

function fixtureCredentials(): Array<{ platform: string; label: string; secret: string }> {
  return Array.from({ length: 22 }, (_, index) => ({
    platform: index % 2 === 0 ? 'google' : 'groq',
    label: `cross-profile-${index}`,
    secret: `cross-profile-fixture-secret-${index}`,
  }))
}

function expectedFingerprints(): Set<string> {
  return new Set(fixtureCredentials().map(({ secret }) => crypto.createHash('sha256').update(secret).digest('hex')))
}

function requirePassphrase(): string {
  const passphrase = process.env.GLORYAPI_BUNDLE_PASSPHRASE ?? ''
  if (passphrase.length < FIXTURE_PASSPHRASE_MIN_LENGTH) {
    throw new Error('GLORYAPI_BUNDLE_PASSPHRASE is missing or too short')
  }
  return passphrase
}

function createFixture(bundlePath: string, passphrase: string): void {
  rejectExistingDestination(bundlePath, 'Bundle')
  exportCredentialBundleFile(bundlePath, fixtureCredentials(), passphrase)
  process.stdout.write(JSON.stringify({ fixture: 'created', credentials: 22 }) + '\n')
}

async function verifyRecovery(bundlePath: string, databasePath: string, passphrase: string): Promise<void> {
  requireRegularFile(bundlePath, 'Bundle')
  rejectExistingDestination(databasePath, 'Database')
  const db = initDb(databasePath, { catalogMode: 'operational' })
  try {
    const dryRun = await recoverCredentialBundleFile(db, bundlePath, passphrase, { dryRun: true })
    const dryRunRows = (db.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as { count: number }).count
    const recovery = await recoverCredentialBundleFile(db, bundlePath, passphrase)
    const repeated = await recoverCredentialBundleFile(db, bundlePath, passphrase)
    const rows = db.prepare(
      'SELECT encrypted_key, iv, auth_tag, encryption_scheme, fingerprint FROM api_keys ORDER BY id',
    ).all() as StoredCredentialRow[]
    const fingerprints = new Set<string>()
    for (const row of rows) {
      if (row.encryption_scheme !== 'dpapi-current-user' || !row.fingerprint) throw new Error('Recovery did not produce DPAPI rows')
      const secret = credentialVault.resolve({ fingerprint: row.fingerprint, ciphertext: row.encrypted_key })
      fingerprints.add(crypto.createHash('sha256').update(secret).digest('hex'))
    }
    const expected = expectedFingerprints()
    const sameFingerprints = rows.length === expected.size && [...expected].every((fingerprint) => fingerprints.has(fingerprint))
    if (!dryRun.dryRun || dryRun.healthCheckRequested || dryRunRows !== 0 || recovery.imported !== 22 ||
        recovery.healthCheckRequested || repeated.unchanged !== 22 || !sameFingerprints) {
      throw new Error('Cross-profile recovery invariants failed')
    }
    process.stdout.write(JSON.stringify({
      fixture: 'verified',
      dryRun: true,
      dryRunRows,
      imported: recovery.imported,
      repeatedUnchanged: repeated.unchanged,
      dpapiRoundTrip: sameFingerprints,
      healthCheckRequested: false,
    }) + '\n')
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const mode = argumentValue('--mode')
  const bundlePath = externalPath(argumentValue('--bundle'), 'Bundle')
  const passphrase = requirePassphrase()
  if (mode === 'create') {
    createFixture(bundlePath, passphrase)
    return
  }
  if (mode !== 'verify') throw new Error('--mode must be create or verify')
  const databasePath = externalPath(argumentValue('--db'), 'Database')
  await verifyRecovery(bundlePath, databasePath, passphrase)
}

try {
  await main()
} catch {
  process.stderr.write('cross-profile recovery verification failed\n')
  process.exitCode = 1
}
