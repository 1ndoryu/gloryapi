import { describe, expect, it } from 'vitest'
import { WindowsDpapiVault } from '../../lib/dpapi-vault.js'

const vault = new WindowsDpapiVault()

describe('Windows DPAPI credential vault', () => {
  it('protects and resolves a credential on Windows', () => {
    if (process.platform !== 'win32') return
    const protectedCredential = vault.protect('dpapi-fixture-secret-🔒')

    expect(protectedCredential.ciphertext).not.toContain('dpapi-fixture-secret')
    expect(protectedCredential.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(vault.resolve(protectedCredential)).toBe('dpapi-fixture-secret-🔒')
  })

  it('rejects a modified fingerprint after unprotecting', () => {
    if (process.platform !== 'win32') return
    const protectedCredential = vault.protect('dpapi-integrity-fixture')

    expect(() => vault.resolve({
      ...protectedCredential,
      fingerprint: '0'.repeat(64),
    })).toThrow('Credential fingerprint mismatch')
  })

  it('rejects malformed protected records before invoking DPAPI', () => {
    expect(() => vault.resolve({ fingerprint: 'invalid', ciphertext: 'not-base64' })).toThrow(
      'Invalid credential fingerprint',
    )
  })

  it('fails closed on non-Windows platforms', () => {
    if (process.platform === 'win32') return
    expect(() => vault.protect('platform-fixture-secret')).toThrow('requires Windows')
  })
})
