import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDb } from '../index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface DatabaseBackupMetadata {
  backupId: string
  filePath: string
  sizeBytes: number
  sha256: string
  createdAt: string
  durability: 'fsync' | 'rename-only'
}

function getBackupDirectory(): string {
  const configured = process.env.GLORYAPI_BACKUP_DIR?.trim()
  const directory = configured ? path.resolve(configured) : path.join(os.homedir(), '.gloryapi', 'backups')
  const repositoryRoot = path.resolve(__dirname, '../../..')
  const relative = path.relative(repositoryRoot, directory)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('GLORYAPI_BACKUP_DIR must point outside the repository')
  }
  return directory
}

export async function backupDatabase(): Promise<DatabaseBackupMetadata> {
  const source = getDb()
  const directory = getBackupDirectory()
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const createdAt = new Date().toISOString()
  const backupId = `gloryapi-${createdAt.replace(/[^0-9]/g, '').slice(0, 17)}-${crypto.randomBytes(6).toString('hex')}`
  const filePath = path.join(directory, `${backupId}.db`)
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`

  try {
    await source.backup(temporaryPath)
    let durability: DatabaseBackupMetadata['durability'] = 'fsync'
    const descriptor = fs.openSync(temporaryPath, 'r')
    try {
      try {
        fs.fsyncSync(descriptor)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code !== 'EPERM' && code !== 'ENOTSUP') throw error
        durability = 'rename-only'
      }
    } finally {
      fs.closeSync(descriptor)
    }

    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(temporaryPath)) hash.update(chunk)
    fs.renameSync(temporaryPath, filePath)
    const stats = fs.statSync(filePath)
    return { backupId, filePath, sizeBytes: stats.size, sha256: hash.digest('hex'), createdAt, durability }
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`SQLite backup failed: ${message}`)
  }
}
