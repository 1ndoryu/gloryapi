import crypto from 'node:crypto'

const BUNDLE_FORMAT = 'gloryapi-credential-bundle'
const BUNDLE_VERSION = 1
const CIPHER_ALGORITHM = 'aes-256-gcm'
const KDF_ALGORITHM = 'argon2id'
const KEY_BYTES = 32
const SALT_BYTES = 16
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const ARGON2_MEMORY_KIB = 19_456
const ARGON2_PASSES = 2
const ARGON2_PARALLELISM = 1
const ARGON2_TAG_BYTES = KEY_BYTES
const MIN_PASSPHRASE_LENGTH = 12

interface Argon2Sync {
  (
    algorithm: 'argon2id',
    parameters: {
      message: string
      nonce: Buffer
      parallelism: number
      tagLength: number
      memory: number
      passes: number
    },
  ): Buffer
}

export interface CredentialBundleInput {
  platform: string
  label: string
  secret: string
  fingerprint?: string
}

export interface CredentialBundleEntry {
  platform: string
  label: string
  fingerprint: string
  secret: string
}

interface PortableBundle {
  format: typeof BUNDLE_FORMAT
  version: typeof BUNDLE_VERSION
  kdf: {
    algorithm: typeof KDF_ALGORITHM
    memoryKib: number
    passes: number
    parallelism: number
    salt: string
  }
  cipher: {
    algorithm: typeof CIPHER_ALGORITHM
    nonce: string
    authTag: string
    ciphertext: string
  }
}

interface BundlePayload {
  credentials: CredentialBundleEntry[]
}

function getArgon2(): Argon2Sync {
  const cryptoWithArgon2 = crypto as typeof crypto & { argon2Sync?: Argon2Sync }
  if (!cryptoWithArgon2.argon2Sync) {
    throw new Error('Portable credential bundles require Node.js with built-in Argon2id support')
  }
  return cryptoWithArgon2.argon2Sync
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Bundle passphrase must contain at least ${MIN_PASSPHRASE_LENGTH} characters`)
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid credential bundle structure')
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid credential bundle field: ${key}`)
  return value
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid credential bundle field: ${key}`)
  }
  return value
}

function decodeBase64(value: string, expectedBytes: number, field: string, exact = true): Buffer {
  const decoded = Buffer.from(value, 'base64')
  const validLength = exact ? decoded.length === expectedBytes : decoded.length >= expectedBytes
  if (!validLength || decoded.toString('base64') !== value) {
    throw new Error(`Invalid credential bundle field: ${field}`)
  }
  return decoded
}

function fingerprintFor(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex')
}

function normalizeCredentials(credentials: CredentialBundleInput[]): CredentialBundleEntry[] {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    throw new Error('Credential bundle must contain at least one credential')
  }
  return credentials.map((credential) => {
    if (!credential || typeof credential !== 'object') throw new Error('Invalid credential bundle entry')
    if (!credential.platform || !credential.label || !credential.secret) {
      throw new Error('Credential bundle entries require platform, label and secret')
    }
    const fingerprint = credential.fingerprint ?? fingerprintFor(credential.secret)
    if (!/^[0-9a-f]{64}$/i.test(fingerprint) || fingerprint.toLowerCase() !== fingerprintFor(credential.secret)) {
      throw new Error('Credential fingerprint does not match its secret')
    }
    return {
      platform: credential.platform,
      label: credential.label,
      fingerprint: fingerprint.toLowerCase(),
      secret: credential.secret,
    }
  })
}

function associatedData(bundle: Pick<PortableBundle, 'format' | 'version' | 'kdf' | 'cipher'>): Buffer {
  return Buffer.from([
    bundle.format,
    String(bundle.version),
    bundle.kdf.algorithm,
    String(bundle.kdf.memoryKib),
    String(bundle.kdf.passes),
    String(bundle.kdf.parallelism),
    bundle.cipher.algorithm,
  ].join(':'), 'utf8')
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return getArgon2()(KDF_ALGORITHM, {
    message: passphrase,
    nonce: salt,
    parallelism: ARGON2_PARALLELISM,
    tagLength: ARGON2_TAG_BYTES,
    memory: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES,
  })
}

export function exportCredentialBundle(credentials: CredentialBundleInput[], passphrase: string): string {
  assertPassphrase(passphrase)
  const normalized = normalizeCredentials(credentials)
  const salt = crypto.randomBytes(SALT_BYTES)
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const bundle: PortableBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kdf: {
      algorithm: KDF_ALGORITHM,
      memoryKib: ARGON2_MEMORY_KIB,
      passes: ARGON2_PASSES,
      parallelism: ARGON2_PARALLELISM,
      salt: salt.toString('base64'),
    },
    cipher: {
      algorithm: CIPHER_ALGORITHM,
      nonce: nonce.toString('base64'),
      authTag: '',
      ciphertext: '',
    },
  }
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, deriveKey(passphrase, salt), nonce)
  cipher.setAAD(associatedData(bundle))
  const plaintext = JSON.stringify({ credentials: normalized } satisfies BundlePayload)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  bundle.cipher.ciphertext = ciphertext.toString('base64')
  bundle.cipher.authTag = cipher.getAuthTag().toString('base64')
  return JSON.stringify(bundle)
}

function parseBundle(serialized: string): PortableBundle {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Invalid credential bundle JSON')
  }
  assertRecord(value)
  if (value.format !== BUNDLE_FORMAT || value.version !== BUNDLE_VERSION) {
    throw new Error('Unsupported credential bundle version')
  }
  const kdfValue = value.kdf
  const cipherValue = value.cipher
  assertRecord(kdfValue)
  assertRecord(cipherValue)
  const bundle: PortableBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kdf: {
      algorithm: readString(kdfValue, 'algorithm') as typeof KDF_ALGORITHM,
      memoryKib: readNumber(kdfValue, 'memoryKib'),
      passes: readNumber(kdfValue, 'passes'),
      parallelism: readNumber(kdfValue, 'parallelism'),
      salt: readString(kdfValue, 'salt'),
    },
    cipher: {
      algorithm: readString(cipherValue, 'algorithm') as typeof CIPHER_ALGORITHM,
      nonce: readString(cipherValue, 'nonce'),
      authTag: readString(cipherValue, 'authTag'),
      ciphertext: readString(cipherValue, 'ciphertext'),
    },
  }
  if (bundle.kdf.algorithm !== KDF_ALGORITHM || bundle.kdf.memoryKib !== ARGON2_MEMORY_KIB ||
      bundle.kdf.passes !== ARGON2_PASSES || bundle.kdf.parallelism !== ARGON2_PARALLELISM ||
      bundle.cipher.algorithm !== CIPHER_ALGORITHM) {
    throw new Error('Unsupported credential bundle parameters')
  }
  decodeBase64(bundle.kdf.salt, SALT_BYTES, 'salt')
  decodeBase64(bundle.cipher.nonce, NONCE_BYTES, 'nonce')
  decodeBase64(bundle.cipher.authTag, AUTH_TAG_BYTES, 'authTag')
  decodeBase64(bundle.cipher.ciphertext, 1, 'ciphertext', false)
  return bundle
}

function parsePayload(value: unknown): CredentialBundleEntry[] {
  assertRecord(value)
  const credentials = value.credentials
  if (!Array.isArray(credentials) || credentials.length === 0) throw new Error('Credential bundle has no credentials')
  return credentials.map((entry) => {
    assertRecord(entry)
    const credential: CredentialBundleEntry = {
      platform: readString(entry, 'platform'),
      label: readString(entry, 'label'),
      fingerprint: readString(entry, 'fingerprint'),
      secret: readString(entry, 'secret'),
    }
    if (!/^[0-9a-f]{64}$/i.test(credential.fingerprint) || fingerprintFor(credential.secret) !== credential.fingerprint.toLowerCase()) {
      throw new Error('Credential fingerprint does not match its secret')
    }
    return { ...credential, fingerprint: credential.fingerprint.toLowerCase() }
  })
}

export function importCredentialBundle(serialized: string, passphrase: string): CredentialBundleEntry[] {
  assertPassphrase(passphrase)
  const bundle = parseBundle(serialized)
  const salt = decodeBase64(bundle.kdf.salt, SALT_BYTES, 'salt')
  const nonce = decodeBase64(bundle.cipher.nonce, NONCE_BYTES, 'nonce')
  const authTag = decodeBase64(bundle.cipher.authTag, AUTH_TAG_BYTES, 'authTag')
  const ciphertext = decodeBase64(bundle.cipher.ciphertext, 1, 'ciphertext', false)
  try {
    const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, deriveKey(passphrase, salt), nonce)
    decipher.setAAD(associatedData(bundle))
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    return parsePayload(JSON.parse(plaintext))
  } catch {
    throw new Error('Unable to decrypt credential bundle')
  }
}
