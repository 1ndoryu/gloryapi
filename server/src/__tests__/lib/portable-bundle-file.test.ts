import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportCredentialBundleFile,
  importCredentialBundleFile,
  writeCredentialBundleFile,
} from '../../lib/portable-bundle-file.js'

const passphrase = 'correct-horse-battery-staple'
const credential = { platform: 'google', label: 'portable-fixture', secret: 'portable-fixture-secret' }
const temporaryFiles: string[] = []

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

describe('portable credential bundle files', () => {
  it('writes atomically, keeps ciphertext bounded, and restores credentials', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-bundle-file-'))
    const filePath = path.join(directory, 'credentials.glorybundle')
    temporaryFiles.push(filePath)

    const writtenPath = exportCredentialBundleFile(filePath, [credential], passphrase)
    expect(writtenPath).toBe(path.resolve(filePath))
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain(credential.secret)
    expect(importCredentialBundleFile(filePath, passphrase)).toEqual([
      expect.objectContaining({
        platform: credential.platform,
        label: credential.label,
        secret: credential.secret,
      }),
    ])
    expect(fs.readdirSync(directory).filter((entry) => entry.includes('.tmp-'))).toEqual([])

    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o077).toBe(0)
    }
  })

  it('rejects a missing file and an oversized serialized bundle', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-bundle-file-'))
    const filePath = path.join(directory, 'credentials.glorybundle')
    temporaryFiles.push(filePath)

    expect(() => importCredentialBundleFile(filePath, passphrase)).toThrow()
    expect(() => writeCredentialBundleFile(filePath, 'x'.repeat(16 * 1024 * 1024 + 1)))
      .toThrow('Credential bundle file exceeds the bounded file size')
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
