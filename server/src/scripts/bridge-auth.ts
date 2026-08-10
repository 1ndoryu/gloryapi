import { getDb, initDb } from '../db/index.js'
import {
  DEFAULT_TOKEN_NAME,
  createLocalAuthToken,
  getLocalAuthTokenMetadata,
  resolveLocalAuthToken,
  rotateLocalAuthToken,
} from '../lib/local-auth-token.js'

function openDatabaseQuietly(): void {
  const originalLog = console.log
  console.log = () => undefined
  try {
    initDb()
  } finally {
    console.log = originalLog
  }
}

function printToken(token: string): void {
  // stdout is the command contract consumed by Codex/PowerShell; no diagnostics
  // or metadata may share this stream.
  process.stdout.write(`${token}\n`)
}

function main(): void {
  const command = process.argv[2] ?? '--print'
  const name = process.env.GLORYAPI_AUTH_TOKEN_NAME?.trim() || DEFAULT_TOKEN_NAME
  openDatabaseQuietly()

  if (command === '--print') {
    printToken(resolveLocalAuthToken(name))
    return
  }
  if (command === '--rotate') {
    printToken(rotateLocalAuthToken(name))
    return
  }
  if (command === '--metadata') {
    const metadata = getLocalAuthTokenMetadata(name)
    if (!metadata) throw new Error('Local auth token is not configured')
    process.stdout.write(`${JSON.stringify(metadata)}\n`)
    return
  }
  throw new Error('Usage: bridge-auth [--print|--rotate|--metadata]')
}

try {
  main()
} catch {
  process.stderr.write('bridge-auth failed: token unavailable\n')
  process.exitCode = 1
} finally {
  // Keep the process short-lived and do not leave a database handle holding the
  // local file while Codex starts the sidecar.
  try { getDb().close() } catch { /* database may not have opened */ }
}
