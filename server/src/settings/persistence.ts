import { getDb } from '../db/index.js';

const SETTINGS_REVISION_KEY = 'settings_revision';

export class SettingsRevisionConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super(`Settings revision conflict; current revision is ${currentRevision}`);
    this.name = 'SettingsRevisionConflictError';
  }
}

export function getRevision(): number {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_REVISION_KEY) as { value: string } | undefined;
  if (!row) return 0;
  const revision = Number.parseInt(row.value, 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function commitRawValues(entries: Array<[string, string]>, expectedRevision?: number): number {
  const db = getDb();
  const currentRevision = getRevision();
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new SettingsRevisionConflictError(currentRevision);
  const nextRevision = currentRevision + 1;
  const transaction = db.transaction(() => {
    const update = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [key, value] of entries) update.run(key, value);
    update.run(SETTINGS_REVISION_KEY, String(nextRevision));
    db.prepare('INSERT INTO settings_audit (revision, keys_json) VALUES (?, ?)')
      .run(nextRevision, JSON.stringify(entries.map(([key]) => key).sort()));
  });
  transaction();
  return nextRevision;
}

export function getSettingsAudit(limit = 50): Array<{ revision: number; keys: string[]; createdAt: string }> {
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = getDb().prepare(
    'SELECT revision, keys_json, created_at FROM settings_audit ORDER BY id DESC LIMIT ?'
  ).all(bounded) as Array<{ revision: number; keys_json: string; created_at: string }>;
  return rows.map(row => ({ revision: row.revision, keys: JSON.parse(row.keys_json) as string[], createdAt: row.created_at }));
}

