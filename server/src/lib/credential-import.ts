import type Database from 'better-sqlite3'
import { credentialVault, DPAPI_ENCRYPTION_SCHEME } from './dpapi-vault.js'
import { importCredentialBundleFile } from './portable-bundle-file.js'
import { importCredentialBundle, type CredentialBundleEntry } from './vault-bundle.js'

export interface CredentialImportReport {
  imported: number
  unchanged: number
}

interface ExistingCredentialRow {
  id: number
}

interface PreparedCredential {
  platform: string
  label: string
  fingerprint: string
  ciphertext: string
}

function assertUniqueCredentials(credentials: CredentialBundleEntry[]): void {
  const seen = new Set<string>()
  for (const credential of credentials) {
    const identity = `${credential.platform}:${credential.fingerprint}`
    if (seen.has(identity)) throw new Error('Credential bundle contains duplicate identities')
    seen.add(identity)
  }
}

/**
 * Imports an encrypted portable bundle into a GloryAPI database. DPAPI work is
 * completed before the transaction so a failed protection operation cannot leave
 * a partially imported database behind.
 */
export function importCredentialEntriesIntoDatabase(
  db: Database.Database,
  credentials: CredentialBundleEntry[],
): CredentialImportReport {
  assertUniqueCredentials(credentials)

  const findExisting = db.prepare(
    'SELECT id FROM api_keys WHERE platform = ? AND fingerprint = ? LIMIT 1',
  )
  const prepared: PreparedCredential[] = []
  let unchanged = 0

  for (const credential of credentials) {
    const existing = findExisting.get(credential.platform, credential.fingerprint) as ExistingCredentialRow | undefined
    if (existing) {
      unchanged++
      continue
    }
    const protectedCredential = credentialVault.protect(credential.secret)
    if (protectedCredential.fingerprint !== credential.fingerprint) {
      throw new Error('Credential fingerprint changed during import')
    }
    prepared.push({
      platform: credential.platform,
      label: credential.label,
      fingerprint: credential.fingerprint,
      ciphertext: protectedCredential.ciphertext,
    })
  }

  if (prepared.length > 0) {
    const insert = db.prepare(`
      INSERT INTO api_keys (
        platform, label, encrypted_key, iv, auth_tag, encryption_scheme, fingerprint, status, enabled
      ) VALUES (?, ?, ?, '', '', ?, ?, 'unknown', 1)
    `)
    db.transaction(() => {
      for (const credential of prepared) {
        insert.run(
          credential.platform,
          credential.label,
          credential.ciphertext,
          DPAPI_ENCRYPTION_SCHEME,
          credential.fingerprint,
        )
      }
    })()
  }

  return { imported: prepared.length, unchanged }
}

export function importCredentialBundleIntoDatabase(
  db: Database.Database,
  serializedBundle: string,
  passphrase: string,
): CredentialImportReport {
  return importCredentialEntriesIntoDatabase(db, importCredentialBundle(serializedBundle, passphrase))
}

export function importCredentialBundleFileIntoDatabase(
  db: Database.Database,
  filePath: string,
  passphrase: string,
): CredentialImportReport {
  return importCredentialEntriesIntoDatabase(db, importCredentialBundleFile(filePath, passphrase))
}
