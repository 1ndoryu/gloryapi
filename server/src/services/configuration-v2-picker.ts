import type Database from 'better-sqlite3';
import { BRIDGE_INTEGRATION, ConfigurationValidationError } from './configuration-v2-contract.js';

/* El selector del bridge ya no exige ranuras compatibles con ChatGPT Desktop:
 * cualquier modelo publica su propio id libre y el bridge lo traduce al
 * wireModel real. Solo se valida forma (mismo patrón que el bridge acepta en
 * su catálogo) y unicidad dentro de la integración. */
export const PICKER_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const MAX_PICKER_ID_SUFFIX = 999;

export function isPickerId(value: unknown): value is string {
  return typeof value === 'string' && PICKER_ID_PATTERN.test(value);
}

export function requirePickerId(value: unknown): string {
  if (!isPickerId(value)) {
    throw new ConfigurationValidationError('pickerId must match /^[A-Za-z0-9._:/-]{1,128}$/');
  }
  return value;
}

function usedPickerIds(db: Database.Database, excludedModelDbId?: number): Set<string> {
  const rows = db.prepare(`
    SELECT picker_id FROM client_catalog_entries
    WHERE integration = ? AND picker_id IS NOT NULL
      AND (? IS NULL OR model_db_id IS NULL OR model_db_id <> ?)
  `).all(BRIDGE_INTEGRATION, excludedModelDbId ?? null, excludedModelDbId ?? null) as Array<{ picker_id: string }>;
  return new Set(rows.map(row => row.picker_id));
}

/** Asigna un id libre para el selector. El preferido suele ser el slug del
 * modelo; si está ocupado se sufija (-2, -3, …) antes de rendirse. */
export function allocatePickerId(db: Database.Database, excludedModelDbId?: number, preferred?: string): string | null {
  const used = usedPickerIds(db, excludedModelDbId);
  const base = typeof preferred === 'string' && PICKER_ID_PATTERN.test(preferred) ? preferred : null;
  if (base && !used.has(base)) return base;
  if (base) {
    for (let suffix = 2; suffix <= MAX_PICKER_ID_SUFFIX; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (candidate.length <= 128 && !used.has(candidate)) return candidate;
    }
  }
  return null;
}

export interface PickerIdMigration {
  modelDbId: number;
  before: string | null;
  after: string | null;
  visible: boolean;
}

/** Repara entradas visibles sin id de selector asignando uno libre derivado
 * del slug del modelo. Los ids existentes (incluidos los alias legacy de
 * Desktop) se conservan tal cual: son válidos y estables. Una segunda
 * ejecución no cambia nada. */
export function reconcileBridgePickerIds(db: Database.Database): PickerIdMigration[] {
  const rows = db.prepare(`
    SELECT c.model_db_id, c.picker_id, c.visible, m.model_id
    FROM client_catalog_entries c LEFT JOIN models m ON m.id = c.model_db_id
    WHERE c.integration = ? AND c.model_db_id IS NOT NULL
    ORDER BY c.sort_order ASC, c.model_db_id ASC
  `).all(BRIDGE_INTEGRATION) as Array<{ model_db_id: number; picker_id: string | null; visible: number; model_id: string | null }>;
  const pending = rows.filter(row => row.visible === 1 && !isPickerId(row.picker_id));
  if (pending.length === 0) return [];

  const update = db.prepare('UPDATE client_catalog_entries SET picker_id = ? WHERE integration = ? AND model_db_id = ?');
  return pending.map(row => {
    const alias = allocatePickerId(db, row.model_db_id, row.model_id ?? undefined);
    update.run(alias, BRIDGE_INTEGRATION, row.model_db_id);
    return { modelDbId: row.model_db_id, before: row.picker_id, after: alias, visible: alias !== null };
  });
}
