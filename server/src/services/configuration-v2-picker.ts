import type Database from 'better-sqlite3';
import {
  BRIDGE_INTEGRATION,
  ConfigurationValidationError,
  DESKTOP_PICKER_ALIAS_VALUES,
} from './configuration-v2-contract.js';

/* Codex Desktop filtra los slugs del selector. Estas ranuras son parte del
 * adaptador del cliente, no identidades de proveedor: la DB conserva qué
 * ranura presenta cada modelo y el bridge la traduce al wireModel real. */
const DESKTOP_PICKER_ALIAS_SET = new Set<string>(DESKTOP_PICKER_ALIAS_VALUES);

export function isDesktopPickerAlias(value: unknown): value is string {
  return typeof value === 'string' && DESKTOP_PICKER_ALIAS_SET.has(value);
}

export function requireDesktopPickerAlias(value: unknown): string {
  if (!isDesktopPickerAlias(value)) {
    throw new ConfigurationValidationError('pickerId must be one of the Codex Desktop compatible aliases');
  }
  return value;
}

export function allocateDesktopPickerAlias(db: Database.Database, excludedModelDbId?: number): string | null {
  const rows = db.prepare(`
    SELECT picker_id FROM client_catalog_entries
    WHERE integration = ? AND picker_id IS NOT NULL
      AND (? IS NULL OR model_db_id IS NULL OR model_db_id <> ?)
  `).all(BRIDGE_INTEGRATION, excludedModelDbId ?? null, excludedModelDbId ?? null) as Array<{ picker_id: string }>;
  const used = new Set(rows.map(row => row.picker_id));
  return DESKTOP_PICKER_ALIAS_VALUES.find(alias => !used.has(alias)) ?? null;
}

export interface PickerAliasMigration {
  modelDbId: number;
  before: string | null;
  after: string | null;
  visible: boolean;
}

/** Repara aliases hash de la versión anterior sin depender del proveedor o
 * modelo. El orden persistido asigna ranuras estables y una segunda ejecución
 * no cambia nada. Si se agotan, el modelo queda oculto en vez de publicar un
 * slug que Desktop descartará silenciosamente. */
export function reconcileDesktopPickerAliases(db: Database.Database): PickerAliasMigration[] {
  const rows = db.prepare(`
    SELECT model_db_id, picker_id, visible
    FROM client_catalog_entries
    WHERE integration = ? AND model_db_id IS NOT NULL
    ORDER BY sort_order ASC, model_db_id ASC
  `).all(BRIDGE_INTEGRATION) as Array<{ model_db_id: number; picker_id: string | null; visible: number }>;
  const claimed = new Set(rows.filter(row => isDesktopPickerAlias(row.picker_id)).map(row => row.picker_id as string));
  // A hidden model intentionally has no Desktop slot. Do not keep treating
  // that stable state as a migration on every database initialization.
  const pending = rows.filter(row => row.visible === 1 && !isDesktopPickerAlias(row.picker_id));
  if (pending.length === 0) return [];

  const clear = db.prepare('UPDATE client_catalog_entries SET picker_id = NULL WHERE integration = ? AND model_db_id = ?');
  for (const row of pending) clear.run(BRIDGE_INTEGRATION, row.model_db_id);

  const update = db.prepare('UPDATE client_catalog_entries SET picker_id = ?, visible = ? WHERE integration = ? AND model_db_id = ?');
  return pending.map(row => {
    const alias = DESKTOP_PICKER_ALIAS_VALUES.find(candidate => !claimed.has(candidate)) ?? null;
    if (alias) claimed.add(alias);
    const visible = alias !== null && row.visible === 1;
    update.run(alias, visible ? 1 : 0, BRIDGE_INTEGRATION, row.model_db_id);
    return { modelDbId: row.model_db_id, before: row.picker_id, after: alias, visible };
  });
}
