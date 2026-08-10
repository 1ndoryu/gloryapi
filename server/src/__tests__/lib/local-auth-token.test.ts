import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, initDb } from '../../db/index.js'
import {
  createLocalAuthToken,
  getLocalAuthTokenMetadata,
  resolveLocalAuthToken,
  rotateLocalAuthToken,
} from '../../lib/local-auth-token.js'

describe('DPAPI-backed local sidecar auth token', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:')
  })

  it('stores ciphertext and resolves the token without exposing plaintext metadata', () => {
    const token = createLocalAuthToken()
    const resolved = resolveLocalAuthToken()
    const metadata = getLocalAuthTokenMetadata()
    const row = getDb().prepare('SELECT encrypted_token, fingerprint FROM local_auth_tokens WHERE name = ?').get('codex-bridge') as {
      encrypted_token: string
      fingerprint: string
    }

    expect(token).toHaveLength(43)
    expect(resolved).toBe(token)
    expect(metadata).toMatchObject({
      name: 'codex-bridge',
      encryptionScheme: 'dpapi-current-user',
      enabled: true,
    })
    expect(JSON.stringify(metadata)).not.toContain(token)
    expect(row.encrypted_token).not.toContain(token)
    expect(row.fingerprint).toHaveLength(64)
  })

  it('rotates the token atomically and returns only the replacement to the caller', () => {
    const first = createLocalAuthToken()
    const second = rotateLocalAuthToken()
    const metadata = getLocalAuthTokenMetadata()

    expect(second).not.toBe(first)
    expect(resolveLocalAuthToken()).toBe(second)
    expect(metadata?.rotatedAt).not.toBeNull()
  })
})
