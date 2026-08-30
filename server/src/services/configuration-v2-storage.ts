import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { ensureProviderConfiguration } from './provider-configuration.js';
import { serializeConfigurationState } from './configuration-v2-snapshot.js';
import { ensureKnownModelCapabilityDefaults } from './configuration-v2-capabilities.js';
import { ensureConfigurationSchema, ensureFallbackTriggers } from './configuration-v2-schema.js';
import {
  AUTO_ROUTE_ID,
  BRIDGE_CONTEXT_WINDOW,
  BRIDGE_INTEGRATION,
  CONFIGURATION_REVISION_KEY,
  normalizeBridgeContextWindow,
  safeRouteId,
  type ConfigurationRouteKind,
  type BridgeVisionModel,
} from './configuration-v2-contract.js';
import {
  allocateDesktopPickerAlias,
  isDesktopPickerAlias,
  reconcileDesktopPickerAliases,
} from './configuration-v2-picker.js';

export interface RoutingModelSnapshot {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  cold_start_retry_ms: number | null;
}

export function getRevision(db: Database.Database): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CONFIGURATION_REVISION_KEY) as { value: string } | undefined;
  const parsed = Number.parseInt(row?.value ?? '0', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function ensureRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, '0')
    ON CONFLICT(key) DO NOTHING
  `).run(CONFIGURATION_REVISION_KEY);
}


export function writeRevision(
  db: Database.Database,
  currentRevision: number,
  actor: string,
  source: string,
  summary: string,
  diff: unknown,
): number {
  const next = currentRevision + 1;
  const hash = crypto.createHash('sha256').update(JSON.stringify(diff)).digest('hex');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('configuration_revision', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(next));
  db.prepare(`
    INSERT INTO configuration_revisions (revision, hash, actor, source, summary)
    VALUES (?, ?, ?, ?, ?)
  `).run(next, hash, actor, source, summary);
  db.prepare(`
    INSERT INTO configuration_audit (revision, actor, source, diff_json)
    VALUES (?, ?, ?, ?)
  `).run(next, actor, source, JSON.stringify(diff));
  const state = serializeConfigurationState(db) as { providers: unknown[]; models: unknown[]; routes: unknown[]; catalog: unknown[] };
  db.prepare(`
    INSERT OR REPLACE INTO configuration_snapshots (revision, snapshot_json)
    VALUES (?, ?)
  `).run(next, JSON.stringify({ schemaVersion: 'glory-configuration-document-v1', revision: next, ...state }));
  invalidateRoutingSnapshot();
  return next;
}

export function ensureRoute(db: Database.Database, routeId: string, name: string, kind: ConfigurationRouteKind, visible: boolean): void {
  db.prepare(`
    INSERT INTO routing_routes (route_id, name, kind, enabled, visible)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(route_id) DO UPDATE SET name = excluded.name, kind = excluded.kind
  `).run(routeId, name, kind, visible ? 1 : 0);
}

export function ensureMember(db: Database.Database, routeId: string, modelDbId: number, priority: number, enabled: boolean): void {
  db.prepare(`
    INSERT INTO routing_route_members (route_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(route_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled
  `).run(routeId, modelDbId, priority, enabled ? 1 : 0);
}

export function getBridgeVisionModels(): BridgeVisionModel[] {
  const rows = getDb().prepare(`
    SELECT route_id, model_id, provider, display_name, base_url,
           completions_path, auth_platform, context_window, priority, enabled
    FROM bridge_vision_routes
    ORDER BY priority ASC, route_id ASC
  `).all() as Array<{
    route_id: string;
    model_id: string;
    provider: string;
    display_name: string;
    base_url: string;
    completions_path: string;
    auth_platform: string;
    context_window: number | null;
    priority: number;
    enabled: number;
  }>;

  return rows.map(row => ({
    routeId: row.route_id,
    id: row.model_id,
    provider: row.provider,
    displayName: row.display_name,
    baseUrl: row.base_url,
    completionsPath: row.completions_path,
    authPlatform: row.auth_platform,
    contextWindow: row.context_window,
    priority: row.priority,
    enabled: row.enabled === 1,
  }));
}

function ensureBridgeVisionRoutes(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bridge_vision_routes (
      route_id, model_id, provider, display_name, base_url,
      completions_path, auth_platform, context_window, priority, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'vision:opencode-zen:mimo-v2.5-free',
    'mimo-v2.5-free',
    'opencode-zen',
    'MiMo V2.5 Free (OpenCode Zen)',
    'https://opencode.ai/zen/v1',
    '/chat/completions',
    'opencode-zen',
    BRIDGE_CONTEXT_WINDOW,
    1,
    1,
  );
  insert.run(
    'vision:opencode-go:mimo-v2.5',
    'mimo-v2.5',
    'opencode-go',
    'MiMo V2.5 (OpenCode Go)',
    'https://opencode.ai/zen/go/v1',
    '/chat/completions',
    'opencode-go',
    BRIDGE_CONTEXT_WINDOW,
    2,
    1,
  );
}

function ensureCatalogEntry(
  db: Database.Database,
  model: {
    id: number;
    platform: string;
    model_id: string;
    display_name: string;
    context_window: number | null;
    native_vision: number;
    supports_reasoning: number;
  },
  externalSlug: string,
): void {
  const routeId = safeRouteId(model.platform, model.model_id);
  ensureRoute(db, routeId, model.display_name, 'pinned', true);
  ensureMember(db, routeId, model.id, 1, true);
  const existing = db.prepare(
    'SELECT external_slug, picker_id FROM client_catalog_entries WHERE integration = ? AND model_db_id = ? LIMIT 1',
  ).get(BRIDGE_INTEGRATION, model.id) as { external_slug: string; picker_id: string | null } | undefined;
  const stableExternalSlug = existing?.external_slug || externalSlug;
  const pickerId = isDesktopPickerAlias(existing?.picker_id)
    ? existing.picker_id
    : allocateDesktopPickerAlias(db, model.id);
  db.prepare(`
    INSERT INTO client_catalog_entries (
      integration, external_slug, route_id, model_db_id, picker_id, display_name,
      native_vision, supports_reasoning, context_window, visible, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(integration, external_slug) DO UPDATE SET
      route_id = excluded.route_id,
       model_db_id = excluded.model_db_id,
       display_name = excluded.display_name,
       native_vision = excluded.native_vision,
       supports_reasoning = excluded.supports_reasoning,
      context_window = excluded.context_window
  `).run(
    BRIDGE_INTEGRATION,
    stableExternalSlug,
    routeId,
    model.id,
    pickerId,
    model.display_name,
    model.native_vision === 1 ? 1 : 0,
    model.supports_reasoning === 1 ? 1 : 0,
    normalizeBridgeContextWindow(model.context_window),
    pickerId ? 1 : 0,
    model.id,
  );
}

function ensureModelCapabilityColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!columns.has('native_vision')) db.prepare('ALTER TABLE models ADD COLUMN native_vision INTEGER NOT NULL DEFAULT 0 CHECK (native_vision IN (0, 1))').run();
  if (!columns.has('supports_reasoning')) db.prepare('ALTER TABLE models ADD COLUMN supports_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (supports_reasoning IN (0, 1))').run();
  if (!columns.has('capabilities_explicit')) db.prepare('ALTER TABLE models ADD COLUMN capabilities_explicit INTEGER NOT NULL DEFAULT 0 CHECK (capabilities_explicit IN (0, 1))').run();
}

function normalizeBridgeContextWindows(db: Database.Database): { models: number; catalogEntries: number } {
  const operationalCatalog = Boolean(db.prepare(
    "SELECT 1 FROM settings WHERE key = 'catalog_schema_version' AND value = 'glory-v1' LIMIT 1",
  ).get());
  if (!operationalCatalog) return { models: 0, catalogEntries: 0 };
  const models = db.prepare(`
    UPDATE models
    SET context_window = ?
    WHERE context_window IS NULL OR context_window <> ?
  `).run(BRIDGE_CONTEXT_WINDOW, BRIDGE_CONTEXT_WINDOW).changes;
  const catalogEntries = db.prepare(`
    UPDATE client_catalog_entries
    SET context_window = ?
    WHERE integration = ? AND (context_window IS NULL OR context_window <> ?)
  `).run(BRIDGE_CONTEXT_WINDOW, BRIDGE_INTEGRATION, BRIDGE_CONTEXT_WINDOW).changes;
  return { models, catalogEntries };
}

export function ensureConfigurationV2(db: Database.Database): void {
  ensureModelCapabilityColumns(db);
  ensureKnownModelCapabilityDefaults(db);
  ensureConfigurationSchema(db);
  ensureRevision(db);
  ensureProviderConfiguration(db);
  ensureBridgeVisionRoutes(db);
  db.exec(`
    DELETE FROM routing_route_members WHERE model_db_id NOT IN (SELECT id FROM models);
    DELETE FROM client_catalog_entries
    WHERE model_db_id IS NOT NULL AND model_db_id NOT IN (SELECT id FROM models);
  `);

  const contextWindowMigration = db.transaction(() => normalizeBridgeContextWindows(db))();

  const pickerAliasMigration = db.transaction(() => {
    ensureRoute(db, AUTO_ROUTE_ID, 'Auto (router de GloryAPI)', 'auto', true);
    const fallbackRows = db.prepare(`
      SELECT fc.model_db_id, fc.priority, fc.enabled, m.model_id
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE m.enabled = 1
      ORDER BY fc.priority ASC
    `).all() as Array<{ model_db_id: number; priority: number; enabled: number; model_id: string }>;
    for (const row of fallbackRows) ensureMember(db, AUTO_ROUTE_ID, row.model_db_id, row.priority, row.enabled === 1);

    const models = db.prepare(`
      SELECT id, platform, model_id, display_name, context_window,
             native_vision, supports_reasoning
      FROM models
      WHERE enabled = 1
      ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
    `).all() as Array<{
      id: number; platform: string; model_id: string; display_name: string;
      context_window: number | null; native_vision: number; supports_reasoning: number;
    }>;
    const duplicateExternalSlugs = new Set(
      [...new Map(models.map(model => [model.model_id, models.filter(candidate => candidate.model_id === model.model_id).length])).entries()]
        .filter(([, count]) => count > 1)
        .map(([modelId]) => modelId),
    );
    for (const model of models) {
      const externalSlug = duplicateExternalSlugs.has(model.model_id)
        ? `${model.platform}/${model.model_id}`
        : model.model_id;
      ensureCatalogEntry(db, model, externalSlug);
    }
    db.prepare(`DELETE FROM client_catalog_entries WHERE integration = ? AND external_slug = 'deepseek-v4-flash'`).run(BRIDGE_INTEGRATION);
    db.prepare(`
      INSERT INTO client_catalog_entries (
        integration, external_slug, route_id, model_db_id, picker_id, display_name,
        native_vision, supports_reasoning, context_window, visible, sort_order
      ) VALUES (?, 'auto', ?, NULL, 'codex-auto-review', 'Auto (router de GloryAPI)', 0, 1, ?, 1, 0)
      ON CONFLICT(integration, external_slug) DO UPDATE SET
        route_id = excluded.route_id, picker_id = excluded.picker_id,
        display_name = excluded.display_name, visible = 1
    `).run(BRIDGE_INTEGRATION, AUTO_ROUTE_ID, BRIDGE_CONTEXT_WINDOW);
    return reconcileDesktopPickerAliases(db);
  })();

  ensureFallbackTriggers(db);

  if (pickerAliasMigration.length > 0 || contextWindowMigration.models > 0 || contextWindowMigration.catalogEntries > 0) {
    const currentRevision = getRevision(db);
    db.transaction(() => {
      writeRevision(
        db,
        currentRevision,
        'configuration-migration',
        'bridge-context-window',
        'Normalización del límite operativo de contexto del bridge',
        {
          type: 'bridge-context-window',
          contextWindow: BRIDGE_CONTEXT_WINDOW,
          modelsUpdated: contextWindowMigration.models,
          catalogEntriesUpdated: contextWindowMigration.catalogEntries,
          pickerAliasChanges: pickerAliasMigration,
        },
      );
    })();
  }

  const initialState = serializeConfigurationState(db) as { providers: unknown[]; models: unknown[]; routes: unknown[]; catalog: unknown[]; visionModels: unknown[] };
  db.prepare(`
    INSERT OR IGNORE INTO configuration_snapshots (revision, snapshot_json)
    VALUES (?, ?)
  `).run(getRevision(db), JSON.stringify({ schemaVersion: 'glory-configuration-document-v1', revision: getRevision(db), ...initialState }));
  invalidateRoutingSnapshot();
}

let routingSnapshotDirty = true;
let routingSnapshot: { db: Database.Database; routes: Map<string, number[]>; models: Map<number, RoutingModelSnapshot> } | null = null;

export function invalidateRoutingSnapshot(): void {
  routingSnapshotDirty = true;
}

export function currentConfigurationRevision(): number {
  return getRevision(getDb());
}

export function getRouteModelIds(routeId: string, options: { includeDisabled?: boolean } = {}): number[] {
  const db = getDb();
  if (options.includeDisabled) {
    const rows = db.prepare('SELECT rm.model_db_id FROM routing_route_members rm WHERE rm.route_id = ? ORDER BY rm.priority ASC').all(routeId) as Array<{ model_db_id: number }>;
    return rows.map(row => row.model_db_id);
  }
  const refreshForTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (refreshForTest || routingSnapshotDirty || !routingSnapshot || routingSnapshot.db !== db) {
    const allRoutes = db.prepare(`
      SELECT rm.route_id, rm.model_db_id
      FROM routing_route_members rm
      JOIN routing_routes rr ON rr.route_id = rm.route_id
      JOIN models m ON m.id = rm.model_db_id
      WHERE rr.enabled = 1 AND rm.enabled = 1 AND m.enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM configuration_providers p
          WHERE p.platform = m.platform AND (p.enabled = 0 OR p.lifecycle <> 'active')
        )
      ORDER BY rm.route_id, rm.priority ASC
    `).all() as Array<{ route_id: string; model_db_id: number }>;
    const routes = new Map<string, number[]>();
    for (const row of allRoutes) routes.set(row.route_id, [...(routes.get(row.route_id) ?? []), row.model_db_id]);
    const modelRows = db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
             m.cold_start_retry_ms
      FROM models m
      WHERE m.enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM configuration_providers p
          WHERE p.platform = m.platform AND (p.enabled = 0 OR p.lifecycle <> 'active')
        )
    `).all() as RoutingModelSnapshot[];
    routingSnapshot = { db, routes, models: new Map(modelRows.map(model => [model.id, model])) };
    routingSnapshotDirty = false;
  }
  return [...(routingSnapshot.routes.get(routeId) ?? [])];
}

export function getRoutingModel(modelDbId: number): RoutingModelSnapshot | undefined {
  getRouteModelIds('');
  return routingSnapshot?.models.get(modelDbId);
}

export { AUTO_ROUTE_ID, BRIDGE_INTEGRATION, safeRouteId };
