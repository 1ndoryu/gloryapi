import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getDb, initDb } from '../../db/index.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import {
  exportCredentialBundle,
  importCredentialBundle,
  type CredentialBundleInput,
} from '../../lib/vault-bundle.js'

const passphrase = 'correct-horse-battery-staple'
const credentials: CredentialBundleInput[] = [
  { platform: 'google', label: 'primary', secret: 'fixture-secret-one' },
  { platform: 'groq', label: 'backup', secret: 'fixture-secret-two' },
]

describe('portable credential bundle', () => {
  it('round-trips credentials while keeping plaintext out of the envelope', () => {
    const bundle = exportCredentialBundle(credentials, passphrase)

    expect(bundle).not.toContain('fixture-secret-one')
    expect(bundle).not.toContain('fixture-secret-two')
    expect(importCredentialBundle(bundle, passphrase)).toEqual([
      {
        platform: 'google',
        label: 'primary',
        fingerprint: 'f2e282393217e863cb3ee7fd57807463a39edc7d852c418fc74ec0b60d2d0d69',
        secret: 'fixture-secret-one',
      },
      {
        platform: 'groq',
        label: 'backup',
        fingerprint: '2d2533c744930e4bcc04013d1a26dcd2ef506d81c8242655612586ff5bca4181',
        secret: 'fixture-secret-two',
      },
    ])
  })

  it('preserves 22 credential fingerprints for a migration-sized bundle', () => {
    const migrationCredentials = Array.from({ length: 22 }, (_, index) => ({
      platform: index % 2 === 0 ? 'google' : 'groq',
      label: `fixture-${index}`,
      secret: `migration-fixture-secret-${index}`,
    }))

    const imported = importCredentialBundle(
      exportCredentialBundle(migrationCredentials, passphrase),
      passphrase,
    )

    expect(imported).toHaveLength(22)
    expect(imported.map((credential) => credential.fingerprint)).toEqual(
      migrationCredentials.map((credential) => crypto.createHash('sha256').update(credential.secret).digest('hex')),
    )
  })

  it('restores a migration-sized bundle into a temporary SQLite vault', () => {
    const migrationCredentials = Array.from({ length: 22 }, (_, index) => ({
      platform: index % 2 === 0 ? 'google' : 'groq',
      label: `fixture-${index}`,
      secret: `sqlite-migration-fixture-${index}`,
    }))
    const imported = importCredentialBundle(
      exportCredentialBundle(migrationCredentials, passphrase),
      passphrase,
    )
    const db = initDb(':memory:')
    const insert = db.prepare(
      'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?)',
    )
    db.transaction(() => {
      for (const credential of imported) {
        const encrypted = encrypt(credential.secret)
        insert.run(credential.platform, credential.label, encrypted.encrypted, encrypted.iv, encrypted.authTag)
      }
    })()

    const rows = getDb().prepare(
      'SELECT encrypted_key, iv, auth_tag FROM api_keys ORDER BY id',
    ).all() as Array<{ encrypted_key: string; iv: string; auth_tag: string }>
    expect(rows).toHaveLength(22)
    expect(rows.map((row) => decrypt(row.encrypted_key, row.iv, row.auth_tag))).toEqual(
      migrationCredentials.map((credential) => credential.secret),
    )
  })

  it('uses a fresh salt and nonce for every export', () => {
    expect(exportCredentialBundle(credentials, passphrase)).not.toBe(
      exportCredentialBundle(credentials, passphrase),
    )
  })

  it('rejects a wrong passphrase without exposing decryption details', () => {
    const bundle = exportCredentialBundle(credentials, passphrase)

    expect(() => importCredentialBundle(bundle, 'wrong-passphrase-value')).toThrow(
      'Unable to decrypt credential bundle',
    )
  })

  it('rejects authenticated tampering', () => {
    const parsed = JSON.parse(exportCredentialBundle(credentials, passphrase)) as {
      cipher: { ciphertext: string }
    }
    const ciphertext = Buffer.from(parsed.cipher.ciphertext, 'base64')
    ciphertext[0] ^= 1
    parsed.cipher.ciphertext = ciphertext.toString('base64')

    expect(() => importCredentialBundle(JSON.stringify(parsed), passphrase)).toThrow(
      'Unable to decrypt credential bundle',
    )
  })

  it('rejects weak passphrases and mismatched fingerprints', () => {
    expect(() => exportCredentialBundle(credentials, 'too-short')).toThrow(
      'Bundle passphrase must contain at least 12 characters',
    )
    expect(() => exportCredentialBundle([
      { ...credentials[0], fingerprint: '0'.repeat(64) },
    ], passphrase)).toThrow('Credential fingerprint does not match its secret')
  })
})
