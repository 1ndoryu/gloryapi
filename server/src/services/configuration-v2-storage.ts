import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { ensureProviderConfiguration, getConfiguredProviders } from './provider-configuration.js';
import { serializeConfigurationState } from './configuration-v2-snapshot.js';
import { ensureKnownModelCapabilityDefaults } from './configuration-v2-capabilities.js';
import {
  AUTO_ROUTE_ID,
  BRIDGE_INTEGRATION,
  CONFIGURATION_REVISION_KEY,
  CONFIGURATION_SCHEMA,
  safePickerId,
  safeRouteId,
  type ConfigurationModel,
  type ConfigurationProvider,
  type ConfigurationRoute,
  type ConfigurationRouteKind,
  type ConfigurationSchema,
} from './configuration-v2-contract.js';

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

export { serializeConfigurationState } from './configuration-v2-snapshot.js';

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
  const pickerId = safePickerId(model.platform, model.model_id);
  const existingSlug = db.prepare(
    'SELECT external_slug FROM client_catalog_entries WHERE integration = ? AND model_db_id = ? LIMIT 1',
  ).get(BRIDGE_INTEGRATION, model.id) as { external_slug: string } | undefined;
  const stableExternalSlug = existingSlug?.external_slug || externalSlug;
  db.prepare(`
    INSERT INTO client_catalog_entries (
      integration, external_slug, route_id, model_db_id, picker_id, display_name,
      native_vision, supports_reasoning, context_window, visible, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(integration, external_slug) DO UPDATE SET
      route_id = excluded.route_id,
       model_db_id = excluded.model_db_id,
       display_name = excluded.display_name,
       native_vision = excluded.native_vision,
       supports_reasoning = excluded.supports_reasoning,
       context_window = excluded.context_window,
      visible = excluded.visible
  `).run(
    BRIDGE_INTEGRATION,
    stableExternalSlug,
    routeId,
    model.id,
    pickerId,
    model.display_name,
    model.native_vision === 1 ? 1 : 0,
    model.supports_reasoning === 1 ? 1 : 0,
    model.context_window,
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

export function ensureConfigurationV2(db: Database.Database): void {
  ensureModelCapabilityColumns(db);
  ensureKnownModelCapabilityDefaults(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_routes (
      route_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('auto', 'pinned', 'policy')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS routing_route_members (
      route_id TEXT NOT NULL REFERENCES routing_routes(route_id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
      priority INTEGER NOT NULL CHECK (priority > 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      PRIMARY KEY (route_id, model_db_id)
    );

    CREATE TABLE IF NOT EXISTS client_catalog_entries (
      integration TEXT NOT NULL,
      external_slug TEXT NOT NULL,
      route_id TEXT NOT NULL REFERENCES routing_routes(route_id) ON DELETE RESTRICT,
      model_db_id INTEGER REFERENCES models(id) ON DELETE RESTRICT,
      picker_id TEXT,
      display_name TEXT NOT NULL,
      native_vision INTEGER NOT NULL DEFAULT 0 CHECK (native_vision IN (0, 1)),
      supports_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (supports_reasoning IN (0, 1)),
      context_window INTEGER,
      visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (integration, external_slug),
      UNIQUE (integration, picker_id)
    );

    CREATE TABLE IF NOT EXISTS configuration_revisions (
      revision INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS configuration_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS configuration_snapshots (
      revision INTEGER PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS configuration_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_route_members_model ON routing_route_members(model_db_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_integration_visible ON client_catalog_entries(integration, visible, sort_order);
  `);
  ensureRevision(db);
  ensureProviderConfiguration(db);
  db.exec(`
    DELETE FROM routing_route_members WHERE model_db_id NOT IN (SELECT id FROM models);
    DELETE FROM client_catalog_entries
    WHERE model_db_id IS NOT NULL AND model_db_id NOT IN (SELECT id FROM models);
  `);

  db.transaction(() => {
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
      ) VALUES (?, 'auto', ?, NULL, 'codex-auto-review', 'Auto (router de GloryAPI)', 0, 1, 150000, 1, 0)
      ON CONFLICT(integration, external_slug) DO UPDATE SET
        route_id = excluded.route_id, picker_id = excluded.picker_id,
        display_name = excluded.display_name, visible = 1
    `).run(BRIDGE_INTEGRATION, AUTO_ROUTE_ID);
  })();

  db.exec(`
    DROP TRIGGER IF EXISTS routing_v2_sync_fallback_update;
    DROP TRIGGER IF EXISTS routing_v2_sync_fallback_insert;
    CREATE TRIGGER IF NOT EXISTS routing_v2_sync_fallback_update
    AFTER UPDATE OF priority, enabled ON fallback_config
    BEGIN
      UPDATE routing_route_members
      SET priority = NEW.priority, enabled = NEW.enabled
      WHERE route_id = 'route:auto' AND model_db_id = NEW.model_db_id;
      INSERT OR REPLACE INTO routing_route_members (route_id, model_db_id, priority, enabled)
      SELECT 'route:auto', NEW.model_db_id, NEW.priority, NEW.enabled
      WHERE NOT EXISTS (
        SELECT 1 FROM routing_route_members WHERE route_id = 'route:auto' AND model_db_id = NEW.model_db_id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS routing_v2_sync_fallback_insert
    AFTER INSERT ON fallback_config
    BEGIN
      INSERT OR REPLACE INTO routing_route_members (route_id, model_db_id, priority, enabled)
      SELECT 'route:auto', NEW.model_db_id, NEW.priority, NEW.enabled
      WHERE EXISTS (SELECT 1 FROM routing_routes WHERE route_id = 'route:auto');
    END;
  `);

  const initialState = serializeConfigurationState(db) as { providers: unknown[]; models: unknown[]; routes: unknown[]; catalog: unknown[] };
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

export function resolveClientCatalogEntry(externalSlug: string): { routeId: string; modelDbId: number | null } | undefined {
  const row = getDb().prepare(`
    SELECT route_id, model_db_id FROM client_catalog_entries
    WHERE integration = ? AND external_slug = ? AND visible = 1
  `).get(BRIDGE_INTEGRATION, externalSlug) as { route_id: string; model_db_id: number | null } | undefined;
  return row ? { routeId: row.route_id, modelDbId: row.model_db_id } : undefined;
}

export function getConfigurationRoutes(): ConfigurationRoute[] {
  const db = getDb();
  const routes = db.prepare('SELECT route_id, name, kind, enabled, visible FROM routing_routes ORDER BY route_id').all() as Array<{ route_id: string; name: string; kind: ConfigurationRouteKind; enabled: number; visible: number }>;
  return routes.map(route => ({
    routeId: route.route_id,
    name: route.name,
    kind: route.kind,
    enabled: route.enabled === 1,
    visible: route.visible === 1,
    members: db.prepare('SELECT model_db_id, priority, enabled FROM routing_route_members WHERE route_id = ? ORDER BY priority ASC').all(route.route_id).map(row => ({
      modelDbId: (row as { model_db_id: number }).model_db_id,
      priority: (row as { priority: number }).priority,
      enabled: (row as { enabled: number }).enabled === 1,
    })),
  }));
}

export function getConfigurationModels(): ConfigurationModel[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.enabled,
           m.context_window, m.native_vision, m.supports_reasoning,
           GROUP_CONCAT(rm.route_id) AS route_ids,
           MAX(CASE WHEN c.integration = ? AND c.visible = 1 THEN 1 ELSE 0 END) AS bridge_visible
    FROM models m
    LEFT JOIN routing_route_members rm ON rm.model_db_id = m.id
    LEFT JOIN client_catalog_entries c ON c.model_db_id = m.id
    GROUP BY m.id ORDER BY m.platform ASC, m.display_name ASC
  `).all(BRIDGE_INTEGRATION) as Array<{
    id: number; platform: string; model_id: string; display_name: string; enabled: number;
    context_window: number | null; native_vision: number; supports_reasoning: number;
    route_ids: string | null; bridge_visible: number;
  }>;
  return rows.map(row => ({
    modelDbId: row.id,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    contextWindow: row.context_window,
    nativeVision: row.native_vision === 1,
    supportsReasoning: row.supports_reasoning === 1,
    routeIds: row.route_ids ? row.route_ids.split(',') : [],
    bridgeVisible: row.bridge_visible === 1,
  }));
}

export function getConfigurationProviders(): ConfigurationProvider[] {
  return getConfiguredProviders(getDb());
}

export function getConfigurationSchema(): ConfigurationSchema {
  return CONFIGURATION_SCHEMA;
}

export { AUTO_ROUTE_ID, BRIDGE_INTEGRATION, safeRouteId, safePickerId };
