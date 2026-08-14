import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

export type ConfigurationRouteKind = 'auto' | 'pinned' | 'policy';

export interface ConfigurationRouteMember {
  modelDbId: number;
  priority: number;
  enabled: boolean;
}

export interface ConfigurationRoute {
  routeId: string;
  name: string;
  kind: ConfigurationRouteKind;
  enabled: boolean;
  visible: boolean;
  members: ConfigurationRouteMember[];
}

export interface BridgeCatalogEntry {
  id: string;
  wireModel: string;
  pickerId: string | null;
  provider: string;
  displayName: string;
  nativeVision: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
  routeId: string;
}

export interface BridgeCatalogProjection {
  schemaVersion: 'glory-bridge-model-catalog-v2';
  revision: number;
  hash: string;
  generatedAt: string;
  entries: BridgeCatalogEntry[];
}

export interface ConfigurationModel {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number | null;
  nativeVision: boolean;
  supportsReasoning: boolean;
  routeIds: string[];
}

export class ConfigurationRevisionConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super(`Configuration revision conflict; current revision is ${currentRevision}`);
    this.name = 'ConfigurationRevisionConflictError';
  }
}

export class ConfigurationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationValidationError';
  }
}

const CONFIGURATION_REVISION_KEY = 'configuration_revision';
const AUTO_ROUTE_ID = 'route:auto';
const BRIDGE_INTEGRATION = 'codex-bridge';

function safeRouteId(platform: string, modelId: string): string {
  const digest = crypto.createHash('sha256').update(`${platform}\0${modelId}`).digest('hex').slice(0, 16);
  return `route:model:${digest}`;
}

function safePickerId(platform: string, modelId: string): string {
  // Eight hex characters were enough for the six-model bootstrap but started
  // colliding when legacy catalogs contained dozens of providers. The picker
  // id is an opaque client identity, so use a stable 64-bit prefix instead.
  const digest = crypto.createHash('sha256').update(`${platform}\0${modelId}`).digest('hex').slice(0, 16);
  return `gpt-bridge-${digest}`;
}

function getRevision(db: Database.Database): number {
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

function writeRevision(
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
  return next;
}

function ensureRoute(db: Database.Database, routeId: string, name: string, kind: ConfigurationRouteKind, visible: boolean): void {
  db.prepare(`
    INSERT INTO routing_routes (route_id, name, kind, enabled, visible)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(route_id) DO UPDATE SET name = excluded.name, kind = excluded.kind
  `).run(routeId, name, kind, visible ? 1 : 0);
}

function ensureMember(db: Database.Database, routeId: string, modelDbId: number, priority: number, enabled: boolean): void {
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
  db.prepare(`
    INSERT INTO client_catalog_entries (
      integration, external_slug, route_id, model_db_id, picker_id, display_name,
      native_vision, supports_reasoning, context_window, visible, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
    ON CONFLICT(integration, external_slug) DO UPDATE SET
      route_id = excluded.route_id,
      model_db_id = excluded.model_db_id,
      display_name = excluded.display_name,
      native_vision = excluded.native_vision,
      context_window = excluded.context_window,
      visible = excluded.visible
  `).run(
    BRIDGE_INTEGRATION,
    externalSlug,
    routeId,
    model.id,
    pickerId,
    model.display_name,
    model.native_vision === 1 ? 1 : 0,
    model.context_window,
    model.id,
  );
}

function ensureModelCapabilityColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!columns.has('native_vision')) db.exec('ALTER TABLE models ADD COLUMN native_vision INTEGER NOT NULL DEFAULT 0 CHECK (native_vision IN (0, 1))');
  if (!columns.has('supports_reasoning')) db.exec('ALTER TABLE models ADD COLUMN supports_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (supports_reasoning IN (0, 1))');
}

export function ensureConfigurationV2(db: Database.Database): void {
  ensureModelCapabilityColumns(db);
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

    CREATE INDEX IF NOT EXISTS idx_route_members_model ON routing_route_members(model_db_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_integration_visible ON client_catalog_entries(integration, visible, sort_order);
  `);
  ensureRevision(db);

  // A legacy catalog normalization may have removed provider models while V2
  // tables were already present. Reconcile those references before any new
  // foreign-key-checked write or catalog projection.
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
    // The persisted fallback table is the migration source for the first V2
    // snapshot. After this bootstrap, route:auto is maintained by the
    // synchronization triggers and by the transactional configuration service.
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

    // `deepseek-v4-flash` is the stable legacy alias used by older bridge
    // clients. It is deliberately a route alias, never a provider model.
    db.prepare(`
      INSERT INTO client_catalog_entries (
        integration, external_slug, route_id, model_db_id, picker_id, display_name,
        native_vision, supports_reasoning, context_window, visible, sort_order
      ) VALUES (?, 'deepseek-v4-flash', ?, NULL, 'gpt-bridge-deepseek-flash-alias', 'DeepSeek V4 Flash (Auto)', 0, 1, 150000, 1, 1)
      ON CONFLICT(integration, external_slug) DO UPDATE SET
        route_id = excluded.route_id, model_db_id = NULL,
        picker_id = excluded.picker_id, display_name = excluded.display_name,
        native_vision = excluded.native_vision,
        supports_reasoning = excluded.supports_reasoning,
        context_window = excluded.context_window,
        visible = 1
    `).run(BRIDGE_INTEGRATION, AUTO_ROUTE_ID);

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
}

export function currentConfigurationRevision(): number {
  return getRevision(getDb());
}

export function getRouteModelIds(routeId: string, options: { includeDisabled?: boolean } = {}): number[] {
  const enabledFilter = options.includeDisabled ? '' : 'AND rr.enabled = 1 AND rm.enabled = 1 AND m.enabled = 1';
  const rows = getDb().prepare(`
    SELECT rm.model_db_id
    FROM routing_route_members rm
    JOIN routing_routes rr ON rr.route_id = rm.route_id
    JOIN models m ON m.id = rm.model_db_id
    WHERE rm.route_id = ? ${enabledFilter}
    ORDER BY rm.priority ASC
  `).all(routeId) as Array<{ model_db_id: number }>;
  return rows.map(row => row.model_db_id);
}

export function resolveClientCatalogEntry(externalSlug: string): { routeId: string; modelDbId: number | null } | undefined {
  const row = getDb().prepare(`
    SELECT route_id, model_db_id
    FROM client_catalog_entries
    WHERE integration = ? AND external_slug = ? AND visible = 1
  `).get(BRIDGE_INTEGRATION, externalSlug) as { route_id: string; model_db_id: number | null } | undefined;
  return row ? { routeId: row.route_id, modelDbId: row.model_db_id } : undefined;
}

export function getConfigurationRoutes(): ConfigurationRoute[] {
  const db = getDb();
  const routes = db.prepare(`SELECT route_id, name, kind, enabled, visible FROM routing_routes ORDER BY route_id`).all() as Array<{ route_id: string; name: string; kind: ConfigurationRouteKind; enabled: number; visible: number }>;
  return routes.map(route => ({
    routeId: route.route_id,
    name: route.name,
    kind: route.kind,
    enabled: route.enabled === 1,
    visible: route.visible === 1,
    members: db.prepare(`
      SELECT model_db_id, priority, enabled
      FROM routing_route_members WHERE route_id = ? ORDER BY priority ASC
    `).all(route.route_id).map(row => ({
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
           GROUP_CONCAT(rm.route_id) AS route_ids
    FROM models m
    LEFT JOIN routing_route_members rm ON rm.model_db_id = m.id
    GROUP BY m.id
    ORDER BY m.platform ASC, m.display_name ASC
  `).all() as Array<{
    id: number; platform: string; model_id: string; display_name: string; enabled: number;
    context_window: number | null; native_vision: number; supports_reasoning: number;
    route_ids: string | null;
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
  }));
}

export interface ConfigurationSnapshot {
  schemaVersion: 'glory-configuration-v2';
  revision: number;
  routes: ConfigurationRoute[];
  models: ConfigurationModel[];
  bridge: BridgeCatalogProjection;
}

export function getConfigurationSnapshot(): ConfigurationSnapshot {
  return {
    schemaVersion: 'glory-configuration-v2',
    revision: currentConfigurationRevision(),
    routes: getConfigurationRoutes(),
    models: getConfigurationModels(),
    bridge: getBridgeCatalogProjection(),
  };
}

export function updateConfigurationRoute(
  routeId: string,
  input: {
    expectedRevision?: number;
    name?: string;
    enabled?: boolean;
    visible?: boolean;
    members: Array<{ modelDbId: number; priority: number; enabled: boolean }>;
    actor?: string;
    source?: string;
  },
): ConfigurationSnapshot {
  const db = getDb();
  const currentRoute = db.prepare('SELECT route_id, kind FROM routing_routes WHERE route_id = ?').get(routeId) as { route_id: string; kind: ConfigurationRouteKind } | undefined;
  if (!currentRoute) throw new ConfigurationValidationError(`Route '${routeId}' does not exist`);
  if (!Array.isArray(input.members) || input.members.length === 0) throw new ConfigurationValidationError('A route must contain at least one model');
  const ids = input.members.map(member => member.modelDbId);
  if (new Set(ids).size !== ids.length) throw new ConfigurationValidationError('A route cannot contain duplicate models');
  const priorities = input.members.map(member => member.priority).sort((a, b) => a - b);
  if (priorities.some((priority, index) => priority !== index + 1)) throw new ConfigurationValidationError('Route priorities must be contiguous starting at 1');

  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const existingModels = new Set((db.prepare('SELECT id FROM models').all() as Array<{ id: number }>).map(row => row.id));
    if (ids.some(id => !existingModels.has(id))) throw new ConfigurationValidationError('Route contains a model that is not in the catalog');

    const currentMembers = db.prepare(`SELECT model_db_id, priority, enabled FROM routing_route_members WHERE route_id = ? ORDER BY priority`).all(routeId);
    db.prepare(`
      UPDATE routing_routes SET
        name = COALESCE(?, name), enabled = COALESCE(?, enabled),
        visible = COALESCE(?, visible), updated_at = datetime('now')
      WHERE route_id = ?
    `).run(input.name ?? null, input.enabled === undefined ? null : input.enabled ? 1 : 0, input.visible === undefined ? null : input.visible ? 1 : 0, routeId);
    db.prepare('DELETE FROM routing_route_members WHERE route_id = ?').run(routeId);
    const insert = db.prepare('INSERT INTO routing_route_members (route_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
    for (const member of input.members) insert.run(routeId, member.modelDbId, member.priority, member.enabled ? 1 : 0);

    // Keep the legacy dashboard and older clients consistent while they are
    // still supported. New routing code reads routing_route_members only.
    if (routeId === AUTO_ROUTE_ID) {
      db.prepare('DELETE FROM fallback_config').run();
      const fallbackInsert = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)');
      for (const member of input.members) fallbackInsert.run(member.modelDbId, member.priority, member.enabled ? 1 : 0);
    }
    const diff = { type: 'route', routeId, before: currentMembers, after: input.members };
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Actualización de ${routeId}`, diff);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getConfigurationSnapshot();
}

export function updateConfigurationModel(
  modelDbId: number,
  input: {
    expectedRevision?: number;
    displayName?: string;
    enabled?: boolean;
    contextWindow?: number | null;
    nativeVision?: boolean;
    supportsReasoning?: boolean;
    actor?: string;
    source?: string;
  },
): ConfigurationSnapshot {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const current = db.prepare(`SELECT id, display_name, enabled, context_window, native_vision, supports_reasoning FROM models WHERE id = ?`).get(modelDbId) as {
      id: number; display_name: string; enabled: number; context_window: number | null; native_vision: number; supports_reasoning: number;
    } | undefined;
    if (!current) throw new ConfigurationValidationError(`Model '${modelDbId}' does not exist`);
    const next = {
      displayName: input.displayName ?? current.display_name,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      contextWindow: input.contextWindow === undefined ? current.context_window : input.contextWindow,
      nativeVision: input.nativeVision === undefined ? current.native_vision : input.nativeVision ? 1 : 0,
      supportsReasoning: input.supportsReasoning === undefined ? current.supports_reasoning : input.supportsReasoning ? 1 : 0,
    };
    if (!next.displayName.trim()) throw new ConfigurationValidationError('displayName cannot be empty');
    db.prepare(`
      UPDATE models SET display_name = ?, enabled = ?, context_window = ?, native_vision = ?, supports_reasoning = ?
      WHERE id = ?
    `).run(next.displayName.trim(), next.enabled, next.contextWindow, next.nativeVision, next.supportsReasoning, modelDbId);
    if (input.enabled !== undefined) {
      db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?').run(next.enabled, modelDbId);
      db.prepare('UPDATE routing_route_members SET enabled = ? WHERE model_db_id = ? AND route_id = ?').run(next.enabled, modelDbId, AUTO_ROUTE_ID);
    }
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Actualización del modelo ${modelDbId}`, { type: 'model', modelDbId, before: current, after: next });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getConfigurationSnapshot();
}

export function createConfigurationModel(input: {
  platform: string;
  modelId: string;
  displayName: string;
  contextWindow?: number | null;
  nativeVision?: boolean;
  supportsReasoning?: boolean;
  intelligenceRank?: number;
  speedRank?: number;
  addToAuto?: boolean;
  actor?: string;
  source?: string;
}): ConfigurationSnapshot {
  const platform = input.platform.trim().toLowerCase();
  const modelId = input.modelId.trim();
  const displayName = input.displayName.trim();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(platform)) throw new ConfigurationValidationError('platform must be a stable lowercase slug');
  if (!modelId || modelId.length > 200) throw new ConfigurationValidationError('modelId is required and must be at most 200 characters');
  if (!displayName) throw new ConfigurationValidationError('displayName cannot be empty');
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number } | undefined;
    if (duplicate) throw new ConfigurationValidationError(`Model '${platform}/${modelId}' already exists`);
    const currentRevision = getRevision(db);
    const maxRanks = db.prepare('SELECT COALESCE(MAX(intelligence_rank), 0) AS intelligence, COALESCE(MAX(speed_rank), 0) AS speed FROM models').get() as { intelligence: number; speed: number };
    const modelResult = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        context_window, native_vision, supports_reasoning, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      platform,
      modelId,
      displayName,
      input.intelligenceRank ?? maxRanks.intelligence + 1,
      input.speedRank ?? maxRanks.speed + 1,
      input.contextWindow ?? null,
      input.nativeVision ? 1 : 0,
      input.supportsReasoning ? 1 : 0,
    );
    const modelDbId = Number(modelResult.lastInsertRowid);
    const routeId = safeRouteId(platform, modelId);
    ensureRoute(db, routeId, displayName, 'pinned', true);
    ensureMember(db, routeId, modelDbId, 1, true);
    const pickerId = safePickerId(platform, modelId);
    db.prepare(`
      INSERT INTO client_catalog_entries (
        integration, external_slug, route_id, model_db_id, picker_id, display_name,
        native_vision, supports_reasoning, context_window, visible, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1000)
    `).run(BRIDGE_INTEGRATION, `${platform}/${modelId}`, routeId, modelDbId, pickerId, displayName, input.nativeVision ? 1 : 0, input.supportsReasoning ? 1 : 0, input.contextWindow ?? null);
    if (input.addToAuto) {
      const maxPriority = db.prepare("SELECT COALESCE(MAX(priority), 0) AS priority FROM routing_route_members WHERE route_id = 'route:auto'").get() as { priority: number };
      ensureMember(db, AUTO_ROUTE_ID, modelDbId, maxPriority.priority + 1, true);
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, maxPriority.priority + 1);
    }
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Alta del modelo ${platform}/${modelId}`, { type: 'model-create', platform, modelId, modelDbId, addToAuto: input.addToAuto === true });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getConfigurationSnapshot();
}

export function getBridgeCatalogProjection(): BridgeCatalogProjection {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.external_slug, c.picker_id, c.display_name, c.native_vision,
           c.supports_reasoning, c.context_window, c.route_id,
           COALESCE(m.platform, 'auto') AS platform
    FROM client_catalog_entries c
    LEFT JOIN models m ON m.id = c.model_db_id
    WHERE c.integration = ? AND c.visible = 1
      AND (c.route_id = ? OR EXISTS (
        SELECT 1 FROM routing_routes r WHERE r.route_id = c.route_id AND r.enabled = 1
      ))
    ORDER BY c.sort_order ASC, c.display_name ASC
  `).all(BRIDGE_INTEGRATION, AUTO_ROUTE_ID) as Array<{
    external_slug: string; picker_id: string | null; display_name: string; native_vision: number;
    supports_reasoning: number; context_window: number | null; route_id: string; platform: string;
  }>;
  const entries = rows.map(row => ({
    id: row.external_slug,
    wireModel: row.route_id === AUTO_ROUTE_ID ? 'auto' : row.external_slug,
    pickerId: row.picker_id,
    provider: row.platform,
    displayName: row.display_name,
    nativeVision: row.native_vision === 1,
    supportsReasoning: row.supports_reasoning === 1,
    // The Desktop client must compact before the largest provider window can
    // destabilize the bridge. Provider-specific capacity remains in models;
    // this projection deliberately exposes one conservative client limit.
    contextWindow: row.context_window === null ? 150000 : Math.min(row.context_window, 150000),
    routeId: row.route_id,
  }));
  const revision = currentConfigurationRevision();
  const hash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { schemaVersion: 'glory-bridge-model-catalog-v2', revision, hash, generatedAt: new Date().toISOString(), entries };
}

export function recordConfigurationRevision(actor: string, source: string, summary: string, diff: unknown): number {
  const db = getDb();
  const current = getRevision(db);
  db.transaction(() => {
    writeRevision(db, current, actor, source, summary, diff);
  })();
  return current + 1;
}

export { AUTO_ROUTE_ID, BRIDGE_INTEGRATION, safeRouteId };
