import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureUnifiedKey, getUnifiedApiKey } from '../../db/security/unified-key.js'

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE local_auth_tokens (
      name TEXT PRIMARY KEY,
      encrypted_token TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      encryption_scheme TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      rotated_at TEXT
    );
  `)
}

describe('unified API key DPAPI contract', () => {
  it('migrates a persistent plaintext setting and then rejects its absence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-unified-key-'))
    const file = path.join(dir, 'test.db')
    const db = new Database(file)
    try {
      createSchema(db)
      db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run('gloryapi-test-migration-key')
      ensureUnifiedKey(db)
      expect(db.prepare("SELECT 1 FROM settings WHERE key = 'unified_api_key'").get()).toBeUndefined()
      expect(db.prepare("SELECT encryption_scheme FROM local_auth_tokens WHERE name = 'gloryapi-unified-api-key'").get()).toMatchObject({ encryption_scheme: 'dpapi-current-user' })
      expect(getUnifiedApiKey(db)).toBe('gloryapi-test-migration-key')

      db.prepare("DELETE FROM local_auth_tokens WHERE name = 'gloryapi-unified-api-key'").run()
      db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run('legacy-plaintext-must-fail')
      expect(() => getUnifiedApiKey(db)).toThrow(/DPAPI token is missing/)
    } finally {
      db.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows releases SQLite handles shortly after close */ }
    }
  })
})
