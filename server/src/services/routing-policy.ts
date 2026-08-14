import { getDb } from '../db/index.js';
import { ROUTING_SCHEMA_VERSION, type RoutingPolicyEntry, type RoutingPolicySnapshot } from '@gloryapi/shared/types.js';
import crypto from 'node:crypto';

const ROUTING_REVISION_KEY = 'routing_revision';

export class RoutingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingValidationError';
  }
}

export class RoutingRevisionConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super(`Routing revision conflict; current revision is ${currentRevision}`);
    this.name = 'RoutingRevisionConflictError';
  }
}

export function getRoutingRevision(): number {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(ROUTING_REVISION_KEY) as { value: string } | undefined;
  if (!row) return 0;
  const revision = Number.parseInt(row.value, 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function getRoutingSnapshot(entries: RoutingPolicyEntry[]): RoutingPolicySnapshot {
  return {
    schemaVersion: ROUTING_SCHEMA_VERSION,
    revision: getRoutingRevision(),
    entries,
  };
}

function validateEntries(entries: unknown): RoutingPolicyEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RoutingValidationError('Routing entries must be a non-empty array');
  }

  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new RoutingValidationError(`Routing entry ${index} is invalid`);
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.modelDbId !== 'number' || !Number.isInteger(candidate.modelDbId) || candidate.modelDbId <= 0) {
      throw new RoutingValidationError(`Routing entry ${index} has an invalid modelDbId`);
    }
    if (typeof candidate.priority !== 'number' || !Number.isInteger(candidate.priority) || candidate.priority <= 0) {
      throw new RoutingValidationError(`Routing entry ${index} has an invalid priority`);
    }
    if (typeof candidate.enabled !== 'boolean') throw new RoutingValidationError(`Routing entry ${index} has an invalid enabled flag`);
    return {
      modelDbId: candidate.modelDbId,
      priority: candidate.priority,
      enabled: candidate.enabled,
    };
  });

  const ids = new Set(normalized.map(entry => entry.modelDbId));
  if (ids.size !== normalized.length) throw new RoutingValidationError('Routing entries must not contain duplicate models');
  const priorities = normalized.map(entry => entry.priority).sort((a, b) => a - b);
  if (priorities.some((priority, index) => priority !== index + 1)) {
    throw new RoutingValidationError('Routing priorities must contain every integer from 1 to the entry count');
  }

  const rows = getDb().prepare('SELECT model_db_id FROM fallback_config ORDER BY model_db_id ASC').all() as Array<{ model_db_id: number }>;
  const expectedIds = rows.map(row => row.model_db_id);
  if (expectedIds.length !== normalized.length || expectedIds.some(id => !ids.has(id))) {
    throw new RoutingValidationError('Routing update must include exactly the persisted model set');
  }
  return normalized;
}

export function updateRoutingPolicy(entries: unknown, expectedRevision?: number): RoutingPolicySnapshot {
  const validated = validateEntries(entries);
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    // The compare-and-swap belongs inside the write transaction. Reading the
    // revision before BEGIN allowed two dashboard writers to both pass the
    // check and overwrite one another's route.
    const currentRevision = getRoutingRevision();
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new RoutingRevisionConflictError(currentRevision);
    }
    const nextRevision = currentRevision + 1;
    const configurationRow = db.prepare("SELECT value FROM settings WHERE key = 'configuration_revision'").get() as { value: string } | undefined;
    const currentConfigurationRevision = Number.parseInt(configurationRow?.value ?? '0', 10);
    const nextConfigurationRevision = Number.isSafeInteger(currentConfigurationRevision) && currentConfigurationRevision >= 0
      ? currentConfigurationRevision + 1
      : 1;
    const diff = { type: 'routing_policy', entries: validated, routingRevision: nextRevision };
    const hash = crypto.createHash('sha256').update(JSON.stringify(diff)).digest('hex');
    const update = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
    const updateV2 = db.prepare(`
      UPDATE routing_route_members SET priority = ?, enabled = ?
      WHERE route_id = 'route:auto' AND model_db_id = ?
    `);
    const insertV2 = db.prepare(`
      INSERT OR IGNORE INTO routing_route_members (route_id, model_db_id, priority, enabled)
      VALUES ('route:auto', ?, ?, ?)
    `);
    for (const entry of validated) {
      const result = update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
      if (result.changes !== 1) throw new RoutingValidationError(`Model ${entry.modelDbId} is not persisted in routing`);
      const v2Result = updateV2.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
      if (v2Result.changes === 0) insertV2.run(entry.modelDbId, entry.priority, entry.enabled ? 1 : 0);
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ROUTING_REVISION_KEY, String(nextRevision));
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('configuration_revision', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(nextConfigurationRevision));
    db.prepare(`
      INSERT INTO configuration_revisions (revision, hash, actor, source, summary)
      VALUES (?, ?, 'dashboard', 'routing', 'Actualización de la ruta Auto')
    `).run(nextConfigurationRevision, hash);
    db.prepare(`
      INSERT INTO configuration_audit (revision, actor, source, diff_json)
      VALUES (?, 'dashboard', 'routing', ?)
    `).run(nextConfigurationRevision, JSON.stringify(diff));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getRoutingSnapshot(validated);
}
