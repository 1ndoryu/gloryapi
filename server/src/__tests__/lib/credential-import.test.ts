import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, initDb } from '../../db/index.js'
import { credentialVault } from '../../lib/dpapi-vault.js'
import { importCredentialBundleIntoDatabase } from '../../lib/credential-import.js'
import { recoverCredentialBundleFile } from '../../lib/credential-recovery.js'
import { exportCredentialBundleFile } from '../../lib/portable-bundle-file.js'
import { exportCredentialBundle } from '../../lib/vault-bundle.js'

const passphrase = 'correct-horse-battery-staple'

function migrationCredentials() {
  return Array.from({ length: 22 }, (_, index) => ({
    platform: index % 2 === 0 ? 'google' : 'groq',
    label: `snapshot-${index}`,
    secret: `snapshot-fixture-secret-${index}`,
  }))
}

describe('credential bundle importer', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  beforeEach(() => {
    initDb(':memory:')
    vi.spyOn(credentialVault, 'protect').mockImplementation((secret) => ({
      fingerprint: crypto.createHash('sha256').update(secret).digest('hex'),
      ciphertext: crypto.createHash('sha256').update(`protected:${secret}`).digest('base64'),
    }))
  })

  it('imports 22 credentials and is idempotent on repetition', () => {
    const bundle = exportCredentialBundle(migrationCredentials(), passphrase)
    const db = getDb()

    expect(importCredentialBundleIntoDatabase(db, bundle, passphrase)).toEqual({ imported: 22, unchanged: 0 })
    expect(importCredentialBundleIntoDatabase(db, bundle, passphrase)).toEqual({ imported: 0, unchanged: 22 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 22 })
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM api_keys WHERE encryption_scheme = 'dpapi-current-user' AND fingerprint IS NOT NULL",
    ).get()).toEqual({ count: 22 })
  })

  it('imports 22 credentials from an encrypted bundle file and is idempotent without health checks', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-recovery-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'credentials.glorybundle')
    exportCredentialBundleFile(filePath, migrationCredentials(), passphrase)
    const db = getDb()

    await expect(recoverCredentialBundleFile(db, filePath, passphrase)).resolves.toMatchObject({
      imported: 22,
      unchanged: 0,
      healthCheckRequested: false,
      health: [],
    })
    await expect(recoverCredentialBundleFile(db, filePath, passphrase)).resolves.toMatchObject({
      imported: 0,
      unchanged: 22,
      healthCheckRequested: false,
      health: [],
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 22 })
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('snapshot-fixture-secret-0')
  })

  it('validates a dry run without writing or performing health checks', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-recovery-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'credentials.glorybundle')
    exportCredentialBundleFile(filePath, migrationCredentials(), passphrase)
    const checkKeyHealth = vi.fn(async () => 'healthy' as const)

    await expect(recoverCredentialBundleFile(getDb(), filePath, passphrase, {
      dryRun: true,
      checkKeyHealth,
    })).resolves.toMatchObject({
      imported: 0,
      unchanged: 0,
      dryRun: true,
      healthCheckRequested: false,
      health: [],
    })
    expect(checkKeyHealth).not.toHaveBeenCalled()
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 0 })
  })

  it('performs health checks only when the caller opts in', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-recovery-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'credentials.glorybundle')
    exportCredentialBundleFile(filePath, migrationCredentials(), passphrase)
    const checkedIds: number[] = []

    const report = await recoverCredentialBundleFile(getDb(), filePath, passphrase, {
      checkKeyHealth: async (id) => {
        checkedIds.push(id)
        return 'healthy'
      },
    })

    expect(report.healthCheckRequested).toBe(true)
    expect(report.health).toHaveLength(22)
    expect(report.health.every(entry => entry.status === 'healthy')).toBe(true)
    expect(checkedIds).toHaveLength(22)
  })

  it('rejects duplicate platform/fingerprint identities before writing', () => {
    const credentials = migrationCredentials()
    const duplicateBundle = exportCredentialBundle([credentials[0], { ...credentials[0] }], passphrase)

    expect(() => importCredentialBundleIntoDatabase(getDb(), duplicateBundle, passphrase)).toThrow(
      'Credential bundle contains duplicate identities',
    )
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 0 })
  })

  it('does not alter an existing credential when only the label differs', () => {
    const credentials = migrationCredentials()
    const db = getDb()
    const first = exportCredentialBundle([credentials[0]], passphrase)
    const relabeled = exportCredentialBundle([{ ...credentials[0], label: 'new-label' }], passphrase)

    expect(importCredentialBundleIntoDatabase(db, first, passphrase)).toEqual({ imported: 1, unchanged: 0 })
    expect(importCredentialBundleIntoDatabase(db, relabeled, passphrase)).toEqual({ imported: 0, unchanged: 1 })
    expect(db.prepare('SELECT label FROM api_keys').get()).toEqual({ label: 'snapshot-0' })
  })
})
