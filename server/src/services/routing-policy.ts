import { getDb } from '../db/index.js';
import { ROUTING_SCHEMA_VERSION, type RoutingPolicyEntry, type RoutingPolicySnapshot } from '@gloryapi/shared/types.js';

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
  const currentRevision = getRoutingRevision();
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new RoutingRevisionConflictError(currentRevision);
  }

  const nextRevision = currentRevision + 1;
  const transaction = db.transaction(() => {
    const update = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
    for (const entry of validated) {
      const result = update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
      if (result.changes !== 1) throw new RoutingValidationError(`Model ${entry.modelDbId} is not persisted in routing`);
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ROUTING_REVISION_KEY, String(nextRevision));
  });
  transaction();
  return getRoutingSnapshot(validated);
}
