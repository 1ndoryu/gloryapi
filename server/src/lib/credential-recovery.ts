import type Database from 'better-sqlite3'
import type { KeyStatus } from '@gloryapi/shared/types.js'
import { importCredentialBundleFile } from './portable-bundle-file.js'
import {
  importCredentialEntriesIntoDatabase,
  validateCredentialEntries,
  type CredentialImportReport,
} from './credential-import.js'

export interface CredentialHealthResult {
  id: number
  platform: string
  fingerprint: string
  status: KeyStatus
}

export interface CredentialRecoveryReport extends CredentialImportReport {
  dryRun: boolean
  healthCheckRequested: boolean
  health: CredentialHealthResult[]
}

interface StoredCredentialIdentity {
  id: number
  platform: string
  fingerprint: string
}

export async function recoverCredentialBundleFile(
  db: Database.Database,
  filePath: string,
  passphrase: string,
  options: { checkKeyHealth?: (keyId: number) => Promise<KeyStatus>; dryRun?: boolean } = {},
): Promise<CredentialRecoveryReport> {
  const credentials = importCredentialBundleFile(filePath, passphrase)
  if (options.dryRun) {
    validateCredentialEntries(credentials)
    return {
      imported: 0,
      unchanged: 0,
      dryRun: true,
      healthCheckRequested: false,
      health: [],
    }
  }
  const report = importCredentialEntriesIntoDatabase(db, credentials)
  const health: CredentialHealthResult[] = []
  const checkKeyHealth = options.checkKeyHealth

  if (!checkKeyHealth) {
    return { ...report, dryRun: false, healthCheckRequested: false, health }
  }

  const findIdentity = db.prepare(
    'SELECT id, platform, fingerprint FROM api_keys WHERE platform = ? AND fingerprint = ? LIMIT 1',
  )
  for (const credential of credentials) {
    const identity = findIdentity.get(credential.platform, credential.fingerprint) as StoredCredentialIdentity | undefined
    if (!identity) {
      health.push({
        id: -1,
        platform: credential.platform,
        fingerprint: credential.fingerprint,
        status: 'error',
      })
      continue
    }
    health.push({
      id: identity.id,
      platform: identity.platform,
      fingerprint: identity.fingerprint,
      status: await checkKeyHealth(identity.id),
    })
  }

  return { ...report, dryRun: false, healthCheckRequested: true, health }
}
