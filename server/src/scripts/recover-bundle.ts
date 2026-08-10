import fs from 'node:fs'
import path from 'node:path'
import { getDb, initDb } from '../db/index.js'
import { checkKeyHealth } from '../services/health.js'
import { recoverCredentialBundleFile } from '../lib/credential-recovery.js'

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]?.trim()
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function requireExternalBundle(): string {
  const configured = argumentValue('--bundle')
  if (!configured) throw new Error('Usage: recover-bundle --bundle <external-file> [--dry-run | --health-check]')
  const bundlePath = path.resolve(configured)
  const repositoryRoot = path.resolve(process.cwd())
  const relative = path.relative(repositoryRoot, bundlePath)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Credential bundle must be outside the GloryAPI repository')
  }
  if (!fs.existsSync(bundlePath)) throw new Error('Credential bundle does not exist')
  return bundlePath
}

function openDatabaseQuietly(): void {
  const originalLog = console.log
  console.log = () => undefined
  try {
    initDb()
  } finally {
    console.log = originalLog
  }
}

async function main(): Promise<void> {
  const bundlePath = requireExternalBundle()
  const passphrase = process.env.GLORYAPI_BUNDLE_PASSPHRASE
  if (!passphrase) throw new Error('GLORYAPI_BUNDLE_PASSPHRASE is required')
  const healthCheckRequested = process.argv.includes('--health-check')
  const dryRun = process.argv.includes('--dry-run')
  if (healthCheckRequested && dryRun) throw new Error('--health-check cannot be combined with --dry-run')

  openDatabaseQuietly()
  const report = await recoverCredentialBundleFile(
    getDb(),
    bundlePath,
    passphrase,
    { checkKeyHealth: healthCheckRequested ? checkKeyHealth : undefined, dryRun },
  )
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

try {
  await main()
} catch {
  process.stderr.write('recover-bundle failed: recovery aborted\n')
  process.exitCode = 1
} finally {
  try { getDb().close() } catch { /* database may not have opened */ }
}
