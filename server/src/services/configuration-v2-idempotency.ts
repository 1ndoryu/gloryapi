import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { ConfigurationValidationError, type ConfigurationSnapshot } from './configuration-v2-contract.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_STALE_MS = 10 * 60 * 1000;

export function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw new ConfigurationValidationError('idempotencyKey must contain 1-128 safe characters', 'idempotency_key_invalid');
  return value;
}

export function claimIdempotency(db: Database.Database, key: string | undefined, payload: unknown): ConfigurationSnapshot | undefined {
  if (!key) return undefined;
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT request_hash, result_json, created_at FROM configuration_idempotency WHERE idempotency_key = ?').get(key) as { request_hash: string; result_json: string | null; created_at: string } | undefined;
    if (existing) {
      if (existing.request_hash !== hash) throw new ConfigurationValidationError('idempotencyKey was already used with a different request', 'idempotency_key_reused');
      if (existing.result_json) {
        db.exec('COMMIT');
        return JSON.parse(existing.result_json) as ConfigurationSnapshot;
      }
      const age = Date.now() - Date.parse(`${existing.created_at}Z`);
      if (Number.isFinite(age) && age > IDEMPOTENCY_STALE_MS) db.prepare('DELETE FROM configuration_idempotency WHERE idempotency_key = ?').run(key);
      else throw new ConfigurationValidationError('idempotencyKey is already being processed', 'idempotency_key_in_progress');
    }
    db.prepare('INSERT INTO configuration_idempotency (idempotency_key, request_hash) VALUES (?, ?)').run(key, hash);
    db.exec('COMMIT');
    return undefined;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

export function completeIdempotency(db: Database.Database, key: string | undefined, snapshot: ConfigurationSnapshot): void {
  if (!key) return;
  db.prepare('UPDATE configuration_idempotency SET result_json = ?, completed_at = datetime(\'now\') WHERE idempotency_key = ?')
    .run(JSON.stringify(snapshot), key);
}

export function abandonIdempotency(db: Database.Database, key: string | undefined): void {
  if (key) db.prepare('DELETE FROM configuration_idempotency WHERE idempotency_key = ? AND result_json IS NULL').run(key);
}
