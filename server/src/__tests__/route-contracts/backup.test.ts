import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { backupDatabase } from '../../db/maintenance/backup.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

async function request(
  app: Express,
  method: string,
  route: string,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

describe('SQLite backup API', () => {
  let app: Express;
  let backupDirectory: string;
  const previousBackupDirectory = process.env.GLORYAPI_BACKUP_DIR;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-backup-'));
    process.env.GLORYAPI_BACKUP_DIR = backupDirectory;
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    for (const entry of fs.readdirSync(backupDirectory)) {
      fs.rmSync(path.join(backupDirectory, entry), { force: true });
    }
  });

  afterAll(() => {
    if (previousBackupDirectory === undefined) delete process.env.GLORYAPI_BACKUP_DIR;
    else process.env.GLORYAPI_BACKUP_DIR = previousBackupDirectory;
    fs.rmSync(backupDirectory, { recursive: true, force: true });
  });

  it('rejects backup requests without the unified admin key', async () => {
    const response = await request(app, 'POST', '/api/settings/backup');
    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
    expect(fs.readdirSync(backupDirectory)).toEqual([]);
  });

  it('creates an online backup that restores all encrypted credential rows', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, 'healthy', 1)
    `);
    const fixtureSecrets = Array.from({ length: 22 }, (_, index) => `fixture-provider-secret-${index}`);

    for (const [index, secret] of fixtureSecrets.entries()) {
      const encrypted = encrypt(secret);
      insert.run('google', `fixture-${index}`, encrypted.encrypted, encrypted.iv, encrypted.authTag);
    }

    const response = await request(app, 'POST', '/api/settings/backup', {
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    });

    expect(response.status).toBe(201);
    expect(response.body.backupId).toMatch(/^gloryapi-/);
    expect(response.body.sizeBytes).toBeGreaterThan(0);
    expect(response.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(['fsync', 'rename-only']).toContain(response.body.durability);
    expect(response.body).not.toHaveProperty('filePath');

    const files = fs.readdirSync(backupDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.db$/);

    const backupPath = path.join(backupDirectory, files[0]);
    const rawBackup = fs.readFileSync(backupPath);
    expect(crypto.createHash('sha256').update(rawBackup).digest('hex')).toBe(response.body.sha256);
    expect(rawBackup.toString('utf8')).not.toContain('fixture-provider-secret');

    const restored = new Database(backupPath, { readonly: true });
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      const rowCount = restored.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as { count: number };
      expect(rowCount.count).toBe(22);

      const rows = restored.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys ORDER BY id').all() as Array<{
        encrypted_key: string;
        iv: string;
        auth_tag: string;
      }>;
      expect(rows.map(row => decrypt(row.encrypted_key, row.iv, row.auth_tag))).toEqual(fixtureSecrets);
    } finally {
      restored.close();
    }
  });

  it('refuses a backup directory inside the repository', async () => {
    process.env.GLORYAPI_BACKUP_DIR = path.resolve('server/data/backups');
    await expect(backupDatabase()).rejects.toThrow('outside the repository');
    process.env.GLORYAPI_BACKUP_DIR = backupDirectory;
  });
});
