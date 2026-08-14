import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { ensureProviderConfiguration, getConfiguredProviders, getConfiguredProviderFromDb, DEFAULT_CAPABILITIES, type ConfiguredProvider, type ProviderFailurePolicy, type ProviderTransportOptions } from './provider-configuration.js';

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
  bridgeVisible: boolean;
}

export interface ConfigurationProvider extends ConfiguredProvider {}

export interface ConfigurationFieldDefinition {
  key: string;
  label: string;
  description: string;
  type: 'text' | 'integer' | 'duration-ms' | 'boolean' | 'enum' | 'json-map';
  section: 'identity' | 'routing' | 'capabilities' | 'transport' | 'bridge' | 'diagnostics';
  scope: 'provider' | 'model' | 'route';
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  requiresRestart: boolean;
  sensitive: boolean;
  consumer: string;
}

export interface ConfigurationSchema {
  schemaVersion: 'glory-configuration-fields-v1';
  fields: ConfigurationFieldDefinition[];
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

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_STALE_MS = 10 * 60 * 1000;

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw new ConfigurationValidationError('idempotencyKey must contain 1-128 safe characters');
  return value;
}

function claimIdempotency(db: Database.Database, key: string | undefined, payload: unknown): ConfigurationSnapshot | undefined {
  if (!key) return undefined;
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT request_hash, result_json, created_at FROM configuration_idempotency WHERE idempotency_key = ?').get(key) as { request_hash: string; result_json: string | null; created_at: string } | undefined;
    if (existing) {
      if (existing.request_hash !== hash) throw new ConfigurationValidationError('idempotencyKey was already used with a different request');
      if (existing.result_json) {
        db.exec('COMMIT');
        return JSON.parse(existing.result_json) as ConfigurationSnapshot;
      }
      const age = Date.now() - Date.parse(`${existing.created_at}Z`);
      if (Number.isFinite(age) && age > IDEMPOTENCY_STALE_MS) db.prepare('DELETE FROM configuration_idempotency WHERE idempotency_key = ?').run(key);
      else throw new ConfigurationValidationError('idempotencyKey is already being processed');
    }
    db.prepare(`INSERT INTO configuration_idempotency (idempotency_key, request_hash) VALUES (?, ?)`).run(key, hash);
    db.exec('COMMIT');
    return undefined;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

function completeIdempotency(db: Database.Database, key: string | undefined, snapshot: ConfigurationSnapshot): void {
  if (!key) return;
  db.prepare('UPDATE configuration_idempotency SET result_json = ?, completed_at = datetime(\'now\') WHERE idempotency_key = ?')
    .run(JSON.stringify(snapshot), key);
}

function abandonIdempotency(db: Database.Database, key: string | undefined): void {
  if (key) db.prepare('DELETE FROM configuration_idempotency WHERE idempotency_key = ? AND result_json IS NULL').run(key);
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

export const CONFIGURATION_SCHEMA: ConfigurationSchema = {
  schemaVersion: 'glory-configuration-fields-v1',
  fields: [
    { key: 'displayName', label: 'Nombre visible', description: 'Nombre del proveedor en el registro central.', type: 'text', section: 'identity', scope: 'provider', min: 1, max: 200, requiresRestart: false, sensitive: false, consumer: 'provider registry' },
    { key: 'enabled', label: 'Proveedor disponible', description: 'Permite que sus modelos participen en las rutas.', type: 'boolean', section: 'routing', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'provider lifecycle' },
    { key: 'lifecycle', label: 'Ciclo de vida', description: 'Estado operativo persistido del proveedor.', type: 'enum', section: 'identity', scope: 'provider', options: [{ value: 'active', label: 'Activo' }, { value: 'draft', label: 'Borrador' }, { value: 'archived', label: 'Archivado' }], requiresRestart: false, sensitive: false, consumer: 'provider registry' },
    { key: 'displayName', label: 'Nombre visible', description: 'Nombre mostrado en el panel y el selector.', type: 'text', section: 'identity', scope: 'model', min: 1, max: 200, requiresRestart: false, sensitive: false, consumer: 'catalog projection' },
    { key: 'name', label: 'Nombre de la ruta', description: 'Nombre visible de la política de enrutamiento.', type: 'text', section: 'identity', scope: 'route', min: 1, max: 160, requiresRestart: false, sensitive: false, consumer: 'route editor' },
    { key: 'enabled', label: 'Ruta disponible', description: 'Permite que la ruta sea seleccionada.', type: 'boolean', section: 'routing', scope: 'route', requiresRestart: false, sensitive: false, consumer: 'route resolver' },
    { key: 'visible', label: 'Ruta visible', description: 'Publica la ruta en clientes que consuman el catálogo.', type: 'boolean', section: 'bridge', scope: 'route', requiresRestart: false, sensitive: false, consumer: 'catalog projection' },
    { key: 'enabled', label: 'Disponible', description: 'Permite que el modelo sea candidato de sus rutas.', type: 'boolean', section: 'routing', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'route resolver' },
    { key: 'contextWindow', label: 'Ventana de contexto', description: 'Capacidad real declarada por el proveedor.', type: 'integer', section: 'capabilities', scope: 'model', min: 1, max: 2000000, requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'nativeVision', label: 'Visión nativa', description: 'El modelo recibe imágenes sin convertirlas a texto.', type: 'boolean', section: 'capabilities', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'bridge vision adapter' },
    { key: 'supportsReasoning', label: 'Admite razonamiento', description: 'Permite solicitar un nivel de razonamiento al modelo.', type: 'boolean', section: 'capabilities', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'timeoutMs', label: 'Tiempo de espera', description: 'Límite de espera del transporte upstream.', type: 'duration-ms', section: 'transport', scope: 'provider', min: 1000, max: 300000, requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'endpoint', label: 'Endpoint', description: 'URL HTTPS pública del proveedor compatible.', type: 'text', section: 'transport', scope: 'provider', min: 1, max: 2048, requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'messageProfile', label: 'Perfil de mensajes', description: 'Normalización declarativa permitida para el contrato upstream.', type: 'enum', section: 'transport', scope: 'provider', options: [{ value: 'none', label: 'Ninguno' }, { value: 'null-assistant', label: 'Normalizar assistant nulo' }, { value: 'deepseek-thinking', label: 'Thinking de DeepSeek' }], requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'includeStreamUsage', label: 'Uso al final del stream', description: 'Solicita el bloque de uso terminal cuando el proveedor lo admite.', type: 'boolean', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'bufferUntilContent', label: 'Esperar contenido antes de emitir', description: 'Evita propagar un stream que solo contiene razonamiento y permite activar fallback.', type: 'boolean', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'bufferUntilDone', label: 'Esperar final del stream', description: 'Retiene la respuesta hasta [DONE] para que un corte incompleto pueda usar fallback.', type: 'boolean', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'maxReasoningEffort', label: 'Razonamiento máximo', description: 'Techo de esfuerzo aceptado por el proveedor.', type: 'enum', section: 'capabilities', scope: 'provider', options: [{ value: 'low', label: 'Bajo' }, { value: 'medium', label: 'Medio' }, { value: 'high', label: 'Alto' }, { value: 'max', label: 'Máximo' }], requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'modelAliases', label: 'Alias de modelos', description: 'Mapa JSON de IDs aceptados por el proveedor a sus IDs upstream; no cambia la ruta seleccionada.', type: 'json-map', section: 'transport', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'modelReasoningLimits', label: 'Límites de razonamiento por modelo', description: 'Mapa JSON de modelo a esfuerzo máximo permitido por ese modelo.', type: 'json-map', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'extraHeadersProfile', label: 'Perfil de cabeceras extra', description: 'Perfil cerrado de cabeceras compatibles; no permite introducir nombres o valores arbitrarios.', type: 'enum', section: 'transport', scope: 'provider', options: [{ value: 'none', label: 'Ninguno' }, { value: 'openrouter', label: 'OpenRouter' }], requiresRestart: false, sensitive: false, consumer: 'OpenAI-compatible adapter' },
    { key: 'cooldownMs', label: 'Cooldown normal', description: 'Tiempo de exclusión tras un fallo transitorio.', type: 'duration-ms', section: 'routing', scope: 'provider', min: 0, max: 86400000, requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'rateLimitCooldownMs', label: 'Cooldown por límite', description: 'Tiempo de exclusión tras un 429.', type: 'duration-ms', section: 'routing', scope: 'provider', min: 0, max: 604800000, requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'recordPenalty', label: 'Penalizar tras un fallo', description: 'Aplica penalización de prioridad cuando el proveedor falla.', type: 'boolean', section: 'routing', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'recordProviderFailure', label: 'Registrar fallo del proveedor', description: 'Registra el fallo para cooldown y diagnóstico.', type: 'boolean', section: 'routing', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'routing health' },
    { key: 'streaming', label: 'Streaming', description: 'El proveedor acepta respuestas en streaming.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'tools', label: 'Herramientas', description: 'El proveedor acepta llamadas de herramientas.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'reasoning', label: 'Razonamiento', description: 'El proveedor acepta controles de razonamiento.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'multimodal', label: 'Multimodal', description: 'El proveedor declara entrada multimodal.', type: 'boolean', section: 'capabilities', scope: 'provider', requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'maxContextWindow', label: 'Ventana máxima declarada', description: 'Límite de contexto que el proveedor garantiza; vacío significa desconocido.', type: 'integer', section: 'capabilities', scope: 'provider', min: 1, max: 2000000, requiresRestart: false, sensitive: false, consumer: 'capability validator' },
    { key: 'bridgeVisible', label: 'Visible en el bridge', description: 'Publica el modelo en el selector aislado.', type: 'boolean', section: 'bridge', scope: 'model', requiresRestart: false, sensitive: false, consumer: 'Codex catalog projector' },
  ],
};

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
  const state = serializeConfigurationState(db) as { providers: unknown[]; models: unknown[]; routes: unknown[]; catalog: unknown[] };
  db.prepare(`
    INSERT OR REPLACE INTO configuration_snapshots (revision, snapshot_json)
    VALUES (?, ?)
  `).run(next, JSON.stringify({ schemaVersion: 'glory-configuration-document-v1', revision: next, ...state }));
  invalidateRoutingSnapshot();
  return next;
}

function serializeConfigurationState(db: Database.Database): unknown {
  const providers = db.prepare(`
    SELECT platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled,
           timeout_ms, capabilities_json, transport_json, failure_policy_json
    FROM configuration_providers ORDER BY platform
  `).all();
  const models = db.prepare(`
    SELECT id AS modelDbId, platform, model_id AS modelId, display_name AS displayName,
           enabled, context_window AS contextWindow, native_vision AS nativeVision,
           supports_reasoning AS supportsReasoning
    FROM models ORDER BY id
  `).all();
  const routes = (db.prepare('SELECT route_id AS routeId, name, kind, enabled, visible FROM routing_routes ORDER BY route_id').all() as Array<{ routeId: string; name: string; kind: string; enabled: number; visible: number }>).map(route => ({
    ...route,
    enabled: route.enabled === 1,
    visible: route.visible === 1,
    members: db.prepare('SELECT model_db_id AS modelDbId, priority, enabled FROM routing_route_members WHERE route_id = ? ORDER BY priority').all(route.routeId).map((member) => ({
      ...(member as { modelDbId: number; priority: number; enabled: number }),
      enabled: (member as { enabled: number }).enabled === 1,
    })),
  }));
  const catalog = db.prepare(`
    SELECT integration, external_slug AS externalSlug, route_id AS routeId, model_db_id AS modelDbId,
           picker_id AS pickerId, display_name AS displayName, native_vision AS nativeVision,
           supports_reasoning AS supportsReasoning, context_window AS contextWindow,
           visible, sort_order AS sortOrder
    FROM client_catalog_entries ORDER BY integration, external_slug
  `).all();
  return { providers, models, routes, catalog };
}

function ensureRoute(db: Database.Database, routeId: string, name: string, kind: ConfigurationRouteKind, visible: boolean): void {
  db.prepare(`
    INSERT INTO routing_routes (route_id, name, kind, enabled, visible)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(route_id) DO UPDATE SET name = excluded.name, kind = excluded.kind
  `).run(routeId, name, kind, visible ? 1 : 0);
}

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

let routingSnapshotDirty = true;
let routingSnapshot: { db: Database.Database; routes: Map<string, number[]>; models: Map<number, RoutingModelSnapshot> } | null = null;

/**
 * Route membership is immutable between configuration writes. Keep it in
 * memory on the request hot path and invalidate it from every revisioned
 * mutation (and from the legacy fallback writer).
 */
export function invalidateRoutingSnapshot(): void {
  routingSnapshotDirty = true;
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

    // Never publish the old bare `deepseek-v4-flash` alias. It pointed to
    // Auto, so an explicit model selected in Desktop could silently become a
    // fallback chain and even reach a different provider/model. Older clients
    // must use the explicit persisted picker IDs or `auto`.
    db.prepare(`
      DELETE FROM client_catalog_entries
      WHERE integration = ? AND external_slug = 'deepseek-v4-flash'
    `).run(BRIDGE_INTEGRATION);

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

  // Revision zero is a valid rollback target. Persist the initial state once
  // so an experimental configuration can always be restored without
  // reconstructing it from legacy tables.
  const initialState = serializeConfigurationState(db) as { providers: unknown[]; models: unknown[]; routes: unknown[]; catalog: unknown[] };
  db.prepare(`
    INSERT OR IGNORE INTO configuration_snapshots (revision, snapshot_json)
    VALUES (?, ?)
  `).run(getRevision(db), JSON.stringify({ schemaVersion: 'glory-configuration-document-v1', revision: getRevision(db), ...initialState }));
  invalidateRoutingSnapshot();
}

export function currentConfigurationRevision(): number {
  return getRevision(getDb());
}

export function getRouteModelIds(routeId: string, options: { includeDisabled?: boolean } = {}): number[] {
  const db = getDb();
  if (options.includeDisabled) {
    const rows = db.prepare(`
      SELECT rm.model_db_id
      FROM routing_route_members rm
      WHERE rm.route_id = ?
      ORDER BY rm.priority ASC
    `).all(routeId) as Array<{ model_db_id: number }>;
    return rows.map(row => row.model_db_id);
  }
  // Vitest deliberately reuses the process while fixtures replace the
  // singleton database and some legacy tests mutate fallback_config directly.
  // Production keeps the immutable hot-path snapshot; tests refresh it so a
  // fixture cannot observe another file's database or stale direct SQL.
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
  // Reuse the same immutable snapshot as route membership. Credential state,
  // cooldowns and token quotas remain dynamic in the router, but model
  // identity/capacity metadata no longer causes a SQLite read per candidate.
  getRouteModelIds('');
  return routingSnapshot?.models.get(modelDbId);
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
           GROUP_CONCAT(rm.route_id) AS route_ids,
           MAX(CASE WHEN c.integration = ? AND c.visible = 1 THEN 1 ELSE 0 END) AS bridge_visible
    FROM models m
    LEFT JOIN routing_route_members rm ON rm.model_db_id = m.id
    LEFT JOIN client_catalog_entries c ON c.model_db_id = m.id
    GROUP BY m.id
    ORDER BY m.platform ASC, m.display_name ASC
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

function validateProviderPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(normalized)) throw new ConfigurationValidationError('platform must be a stable lowercase slug');
  return normalized;
}

function validateProviderEndpoint(endpoint: string): string {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new ConfigurationValidationError('endpoint must be a valid URL'); }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || !hostname || hostname === 'localhost' || hostname.endsWith('.local') || isIP(hostname) !== 0) {
    throw new ConfigurationValidationError('endpoint must use HTTPS and a public hostname');
  }
  return parsed.toString().replace(/\/$/, '');
}

function validateTransportOptions(input: Partial<ProviderTransportOptions>): ProviderTransportOptions {
  const allowedProfiles = new Set(['none', 'null-assistant', 'deepseek-thinking']);
  const efforts = new Set(['low', 'medium', 'high', 'max']);
  if (input.messageProfile !== undefined && !allowedProfiles.has(input.messageProfile)) throw new ConfigurationValidationError('Unsupported messageProfile');
  if (input.maxReasoningEffort !== undefined && !efforts.has(input.maxReasoningEffort)) throw new ConfigurationValidationError('Unsupported maxReasoningEffort');
  if (input.includeStreamUsage !== undefined && typeof input.includeStreamUsage !== 'boolean') throw new ConfigurationValidationError('includeStreamUsage must be boolean');
  if (input.bufferUntilContent !== undefined && typeof input.bufferUntilContent !== 'boolean') throw new ConfigurationValidationError('bufferUntilContent must be boolean');
  if (input.bufferUntilDone !== undefined && typeof input.bufferUntilDone !== 'boolean') throw new ConfigurationValidationError('bufferUntilDone must be boolean');
  const aliases = input.modelAliases ?? {};
  const limits = input.modelReasoningLimits ?? {};
  if (typeof aliases !== 'object' || Array.isArray(aliases) || Object.keys(aliases).length > 128) throw new ConfigurationValidationError('modelAliases must be a bounded object');
  if (typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).length > 128) throw new ConfigurationValidationError('modelReasoningLimits must be a bounded object');
  for (const [key, value] of Object.entries(aliases)) if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(key) || typeof value !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value)) throw new ConfigurationValidationError('modelAliases contains an invalid key or value');
  for (const [key, value] of Object.entries(limits)) if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(key) || !efforts.has(value)) throw new ConfigurationValidationError('modelReasoningLimits contains an invalid entry');
  return {
    messageProfile: input.messageProfile ?? 'none',
    includeStreamUsage: input.includeStreamUsage ?? false,
    bufferUntilContent: input.bufferUntilContent ?? false,
    bufferUntilDone: input.bufferUntilDone ?? false,
    maxReasoningEffort: input.maxReasoningEffort ?? 'high',
    modelAliases: aliases,
    modelReasoningLimits: limits,
    extraHeadersProfile: input.extraHeadersProfile === 'openrouter' ? 'openrouter' : 'none',
  };
}

function validateFailurePolicy(input: Partial<ProviderFailurePolicy>): ProviderFailurePolicy {
  const bounded = (value: unknown, name: string, max: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new ConfigurationValidationError(`${name} must be an integer between 0 and ${max}`);
    return value;
  };
  const cooldownMs = bounded(input.cooldownMs, 'cooldownMs', 86400000) ?? 300000;
  const rateLimitCooldownMs = bounded(input.rateLimitCooldownMs, 'rateLimitCooldownMs', 604800000);
  return {
    cooldownMs,
    ...(rateLimitCooldownMs === undefined ? {} : { rateLimitCooldownMs }),
    recordPenalty: input.recordPenalty ?? false,
    recordProviderFailure: input.recordProviderFailure ?? true,
  };
}

export function updateConfigurationProvider(
  platform: string,
  input: {
    expectedRevision?: number;
    displayName?: string;
    lifecycle?: 'active' | 'archived' | 'draft';
    enabled?: boolean;
    endpoint?: string;
    timeoutMs?: number;
    capabilities?: Partial<ConfigurationProvider['capabilities']>;
    transport?: Partial<ProviderTransportOptions>;
    failurePolicy?: Partial<ProviderFailurePolicy>;
    idempotencyKey?: string;
    actor?: string;
    source?: string;
  },
): ConfigurationSnapshot {
  const db = getDb();
  const normalizedPlatform = validateProviderPlatform(platform);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'provider-update', platform: normalizedPlatform, input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const current = getConfiguredProviderFromDb(db, normalizedPlatform);
    if (!current) throw new ConfigurationValidationError(`Provider '${normalizedPlatform}' does not exist`);
    const nextEndpoint = input.endpoint === undefined ? current.endpoint : validateProviderEndpoint(input.endpoint);
    const nextTimeout = input.timeoutMs === undefined ? current.timeoutMs : input.timeoutMs;
    if (!Number.isInteger(nextTimeout) || nextTimeout < 1000 || nextTimeout > 300000) throw new ConfigurationValidationError('timeoutMs must be between 1000 and 300000');
    const nextCapabilities = { ...current.capabilities, ...(input.capabilities ?? {}) };
    const nextTransport = validateTransportOptions({ ...current.transport, ...(input.transport ?? {}) });
    const nextPolicy = validateFailurePolicy({ ...current.failurePolicy, ...(input.failurePolicy ?? {}) });
    const next = {
      displayName: input.displayName?.trim() || current.displayName,
      lifecycle: input.lifecycle ?? current.lifecycle,
      enabled: input.enabled === undefined ? current.enabled : input.enabled,
      endpoint: nextEndpoint,
      timeoutMs: nextTimeout,
      capabilities: nextCapabilities,
      transport: nextTransport,
      failurePolicy: nextPolicy,
    };
    if (!next.displayName) throw new ConfigurationValidationError('displayName cannot be empty');
    db.prepare(`
      UPDATE configuration_providers SET display_name = ?, lifecycle = ?, enabled = ?, endpoint = ?,
        timeout_ms = ?, capabilities_json = ?, transport_json = ?, failure_policy_json = ?, updated_at = datetime('now')
      WHERE platform = ?
    `).run(next.displayName, next.lifecycle, next.enabled ? 1 : 0, next.endpoint, next.timeoutMs, JSON.stringify(next.capabilities), JSON.stringify(next.transport), JSON.stringify(next.failurePolicy), normalizedPlatform);
    if (next.enabled !== current.enabled || next.lifecycle !== current.lifecycle) {
      const available = next.enabled && next.lifecycle === 'active' ? 1 : 0;
      db.prepare(`
        UPDATE fallback_config SET enabled = CASE WHEN ? = 1 THEN (
          SELECT m.enabled FROM models m WHERE m.id = fallback_config.model_db_id
        ) ELSE 0 END
        WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)
      `).run(available, normalizedPlatform);
      db.prepare(`
        UPDATE routing_route_members SET enabled = CASE WHEN ? = 1 THEN (
          SELECT m.enabled FROM models m WHERE m.id = routing_route_members.model_db_id
        ) ELSE 0 END
        WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)
      `).run(available, normalizedPlatform);
    }
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Actualización del proveedor ${normalizedPlatform}`, { type: 'provider', platform: normalizedPlatform, before: current, after: next });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
}

export function createConfigurationProvider(input: {
  platform: string;
  displayName: string;
  endpoint: string;
  adapter?: 'openai-compatible';
  authScheme?: 'bearer';
  timeoutMs?: number;
  capabilities?: Partial<ConfigurationProvider['capabilities']>;
  transport?: Partial<ProviderTransportOptions>;
  failurePolicy?: Partial<ProviderFailurePolicy>;
  enabled?: boolean;
  lifecycle?: 'active' | 'draft';
  actor?: string;
  source?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}): ConfigurationSnapshot {
  const platform = validateProviderPlatform(input.platform);
  const displayName = input.displayName.trim();
  if (!displayName) throw new ConfigurationValidationError('displayName cannot be empty');
  if (input.adapter && input.adapter !== 'openai-compatible') throw new ConfigurationValidationError('Only openai-compatible providers can be configured dynamically');
  const endpoint = validateProviderEndpoint(input.endpoint);
  const timeoutMs = input.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new ConfigurationValidationError('timeoutMs must be between 1000 and 300000');
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(input.capabilities ?? {}) };
  const transport = validateTransportOptions(input.transport ?? {});
  const failurePolicy = validateFailurePolicy(input.failurePolicy ?? {});
  const db = getDb();
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'provider-create', input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const duplicate = db.prepare('SELECT platform FROM configuration_providers WHERE platform = ?').get(platform);
    if (duplicate) throw new ConfigurationValidationError(`Provider '${platform}' already exists`);
    db.prepare(`
      INSERT INTO configuration_providers (platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled, timeout_ms, capabilities_json, transport_json, failure_policy_json)
      VALUES (?, ?, ?, 'openai-compatible', ?, 'bearer', ?, ?, ?, ?, ?)
    `).run(platform, displayName, input.lifecycle ?? 'draft', endpoint, input.enabled === true ? 1 : 0, timeoutMs, JSON.stringify(capabilities), JSON.stringify(transport), JSON.stringify(failurePolicy));
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Alta del proveedor ${platform}`, { type: 'provider-create', platform, displayName });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
}

export interface ConfigurationDocument {
  schemaVersion: 'glory-configuration-document-v1';
  revision: number;
  providers: unknown[];
  models: unknown[];
  routes: unknown[];
  catalog: unknown[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigurationValidationError(`${name} must be an array`);
  if (value.length > 10000) throw new ConfigurationValidationError(`${name} exceeds the configured limit`);
  return value;
}

export function validateConfigurationDocument(value: unknown): ConfigurationDocument {
  const root = record(value, 'configuration document');
  if (root.schemaVersion !== 'glory-configuration-document-v1') throw new ConfigurationValidationError('Unsupported configuration document schema');
  if (typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 0) throw new ConfigurationValidationError('document.revision is invalid');
  const providers = array(root.providers, 'document.providers');
  const models = array(root.models, 'document.models');
  const routes = array(root.routes, 'document.routes');
  const catalog = array(root.catalog, 'document.catalog');
  const modelIds = new Set<number>();
  for (const value of models) {
    const model = record(value, 'document model');
    if (typeof model.modelDbId !== 'number' || !Number.isSafeInteger(model.modelDbId) || model.modelDbId <= 0) throw new ConfigurationValidationError('document modelDbId is invalid');
    if (modelIds.has(model.modelDbId)) throw new ConfigurationValidationError('document contains duplicate modelDbId');
    modelIds.add(model.modelDbId);
    if (typeof model.platform !== 'string' || typeof model.modelId !== 'string') throw new ConfigurationValidationError('document model identity is invalid');
  }
  for (const value of providers) {
    const provider = record(value, 'document provider');
    if (typeof provider.platform !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(provider.platform)) throw new ConfigurationValidationError('document provider platform is invalid');
    if (typeof provider.endpoint !== 'string') throw new ConfigurationValidationError('document provider endpoint is invalid');
    validateProviderEndpoint(provider.endpoint);
    if (provider.adapter !== undefined && provider.adapter !== 'openai-compatible') throw new ConfigurationValidationError('document provider adapter is not supported');
  }
  for (const value of routes) {
    const route = record(value, 'document route');
    if (typeof route.routeId !== 'string' || !Array.isArray(route.members)) throw new ConfigurationValidationError('document route is invalid');
    const members = route.members as unknown[];
    if (members.length === 0 || members.length > 256) throw new ConfigurationValidationError('document route member count is invalid');
    const priorities = members.map(member => {
      const item = record(member, 'document route member');
      if (typeof item.modelDbId !== 'number' || !modelIds.has(item.modelDbId) || typeof item.priority !== 'number') throw new ConfigurationValidationError('document route member is invalid');
      return item.priority;
    }).sort((a, b) => a - b);
    if (priorities.some((priority, index) => priority !== index + 1)) throw new ConfigurationValidationError(`document route '${route.routeId}' priorities are not contiguous`);
  }
  return { schemaVersion: 'glory-configuration-document-v1', revision: root.revision, providers, models, routes, catalog };
}

function jsonObject(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : fallback;
    } catch {
      return fallback;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return fallback;
}

export function exportConfigurationDocument(): ConfigurationDocument {
  const state = serializeConfigurationState(getDb()) as { providers: unknown[]; models: unknown[]; routes: unknown[]; catalog: unknown[] };
  return {
    schemaVersion: 'glory-configuration-document-v1',
    revision: currentConfigurationRevision(),
    ...state,
  };
}

export function applyConfigurationDocument(
  input: unknown,
  options: { expectedRevision?: number; actor?: string; source?: string; dryRun?: boolean; idempotencyKey?: string } = {},
): ConfigurationSnapshot {
  const document = validateConfigurationDocument(input);
  const db = getDb();
  if (options.dryRun) return getConfigurationSnapshot();
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'configuration-apply', document, expectedRevision: options.expectedRevision });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const existingModels = new Set((db.prepare('SELECT id FROM models').all() as Array<{ id: number }>).map(row => row.id));
    const targetProviderPlatforms = document.providers
      .map(value => record(value, 'provider').platform)
      .filter((platform): platform is string => typeof platform === 'string');
    if (targetProviderPlatforms.length > 0) {
      const placeholders = targetProviderPlatforms.map(() => '?').join(',');
      // A rollback/import must not leave a provider introduced later active.
      // Archive it instead of deleting credentials or audit history.
      db.prepare(`UPDATE configuration_providers SET lifecycle = 'archived', enabled = 0, updated_at = datetime('now') WHERE platform NOT IN (${placeholders})`).run(...targetProviderPlatforms);
    } else {
      db.prepare("UPDATE configuration_providers SET lifecycle = 'archived', enabled = 0, updated_at = datetime('now')").run();
    }
    for (const value of document.providers) {
      const provider = record(value, 'provider');
      const capabilities = jsonObject(provider.capabilities_json ?? provider.capabilities, {});
      const transport = jsonObject(provider.transport_json ?? provider.transport, {});
      const failurePolicy = jsonObject(provider.failure_policy_json ?? provider.failurePolicy, {});
      db.prepare(`
        INSERT INTO configuration_providers (platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled, timeout_ms, capabilities_json, transport_json, failure_policy_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform) DO UPDATE SET display_name = excluded.display_name, lifecycle = excluded.lifecycle,
          adapter = excluded.adapter, endpoint = excluded.endpoint, auth_scheme = excluded.auth_scheme,
          enabled = excluded.enabled, timeout_ms = excluded.timeout_ms, capabilities_json = excluded.capabilities_json,
          transport_json = excluded.transport_json, failure_policy_json = excluded.failure_policy_json, updated_at = datetime('now')
      `).run(
        provider.platform,
        String(provider.display_name ?? provider.displayName ?? provider.platform),
        provider.lifecycle ?? 'draft',
        provider.adapter ?? 'openai-compatible',
        String(provider.endpoint ?? ''),
        provider.auth_scheme ?? provider.authScheme ?? 'bearer',
        provider.enabled === false || provider.enabled === 0 ? 0 : 1,
        Number(provider.timeout_ms ?? provider.timeoutMs ?? 120000),
        JSON.stringify(capabilities), JSON.stringify(transport), JSON.stringify(failurePolicy),
      );
    }
    for (const value of document.models) {
      const model = record(value, 'model');
      const id = Number(model.modelDbId);
      if (!existingModels.has(id)) throw new ConfigurationValidationError(`document references unknown model '${id}'`);
      db.prepare(`
        UPDATE models SET display_name = ?, enabled = ?, context_window = ?, native_vision = ?, supports_reasoning = ?
        WHERE id = ?
      `).run(
        String(model.displayName ?? ''), model.enabled === false || model.enabled === 0 ? 0 : 1,
        model.contextWindow === null || model.context_window === null ? null : Number(model.contextWindow ?? model.context_window),
        model.nativeVision === true || model.native_vision === 1 ? 1 : 0,
        model.supportsReasoning === true || model.supports_reasoning === 1 ? 1 : 0,
        id,
      );
    }
    const targetModelIds = new Set(document.models.map(value => Number(record(value, 'model').modelDbId)));
    const currentModelIds = [...existingModels].filter(id => !targetModelIds.has(id));
    if (currentModelIds.length > 0) {
      const placeholders = currentModelIds.map(() => '?').join(',');
      // Models are retained for audit/history, but removed from the restored
      // operational catalog and all routes by disabling them here.
      db.prepare(`UPDATE models SET enabled = 0 WHERE id IN (${placeholders})`).run(...currentModelIds);
    }
    db.prepare('DELETE FROM client_catalog_entries').run();
    db.prepare('DELETE FROM routing_route_members').run();
    db.prepare('DELETE FROM routing_routes').run();
    const routeInsert = db.prepare('INSERT INTO routing_routes (route_id, name, kind, enabled, visible) VALUES (?, ?, ?, ?, ?)');
    const memberInsert = db.prepare('INSERT INTO routing_route_members (route_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
    for (const value of document.routes) {
      const route = record(value, 'route');
      routeInsert.run(route.routeId, route.name ?? route.routeId, route.kind ?? 'policy', route.enabled === false || route.enabled === 0 ? 0 : 1, route.visible === false || route.visible === 0 ? 0 : 1);
      for (const memberValue of route.members as unknown[]) {
        const member = record(memberValue, 'route member');
        memberInsert.run(route.routeId, member.modelDbId, member.priority, member.enabled === false || member.enabled === 0 ? 0 : 1);
      }
    }
    const catalogInsert = db.prepare(`
      INSERT INTO client_catalog_entries (integration, external_slug, route_id, model_db_id, picker_id, display_name, native_vision, supports_reasoning, context_window, visible, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const value of document.catalog) {
      const entry = record(value, 'catalog entry');
      catalogInsert.run(entry.integration ?? 'codex-bridge', entry.externalSlug ?? entry.external_slug, entry.routeId ?? entry.route_id, entry.modelDbId ?? entry.model_db_id ?? null, entry.pickerId ?? entry.picker_id ?? null, entry.displayName ?? entry.display_name ?? entry.externalSlug ?? entry.external_slug, entry.nativeVision === true || entry.native_vision === 1 ? 1 : 0, entry.supportsReasoning === true || entry.supports_reasoning === 1 ? 1 : 0, entry.contextWindow ?? entry.context_window ?? null, entry.visible === false || entry.visible === 0 ? 0 : 1, Number(entry.sortOrder ?? entry.sort_order ?? 0));
    }
    const autoMembers = db.prepare("SELECT model_db_id, priority, enabled FROM routing_route_members WHERE route_id = 'route:auto' ORDER BY priority").all() as Array<{ model_db_id: number; priority: number; enabled: number }>;
    db.prepare('DELETE FROM fallback_config').run();
    const fallbackInsert = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)');
    for (const member of autoMembers) fallbackInsert.run(member.model_db_id, member.priority, member.enabled);
    writeRevision(db, currentRevision, options.actor ?? 'configuration-cli', options.source ?? 'configuration-apply', 'Aplicación completa de configuración', { type: 'configuration-apply', fromRevision: document.revision });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
}

export function rollbackConfiguration(targetRevision: number, expectedRevision?: number, idempotencyKey?: string): ConfigurationSnapshot {
  const row = getDb().prepare('SELECT snapshot_json FROM configuration_snapshots WHERE revision = ?').get(targetRevision) as { snapshot_json: string } | undefined;
  if (!row) throw new ConfigurationValidationError(`No snapshot is available for revision ${targetRevision}`);
  const parsed = JSON.parse(row.snapshot_json) as Record<string, unknown>;
  // Snapshots from the first V2 build stored only the serialized state. Read
  // them once through the stable document envelope so rollback remains
  // compatible after an upgrade.
  const document = parsed.schemaVersion === 'glory-configuration-document-v1'
    ? parsed
    : { schemaVersion: 'glory-configuration-document-v1', revision: targetRevision, ...parsed };
  return applyConfigurationDocument(document, { expectedRevision, idempotencyKey, actor: 'configuration-cli', source: 'configuration-rollback' });
}

export interface ConfigurationSnapshot {
  schemaVersion: 'glory-configuration-v2';
  revision: number;
  routes: ConfigurationRoute[];
  models: ConfigurationModel[];
  providers: ConfigurationProvider[];
  schema: ConfigurationSchema;
  bridge: BridgeCatalogProjection;
}

export function getConfigurationSnapshot(): ConfigurationSnapshot {
  return {
    schemaVersion: 'glory-configuration-v2',
    revision: currentConfigurationRevision(),
    routes: getConfigurationRoutes(),
    models: getConfigurationModels(),
    providers: getConfigurationProviders(),
    schema: getConfigurationSchema(),
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
    idempotencyKey?: string;
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
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'route-update', routeId, input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;

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
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
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
    bridgeVisible?: boolean;
    actor?: string;
    source?: string;
    idempotencyKey?: string;
  },
): ConfigurationSnapshot {
  const db = getDb();
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'model-update', modelDbId, input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const current = db.prepare(`
      SELECT m.id, m.display_name, m.enabled, m.context_window, m.native_vision, m.supports_reasoning,
             MAX(CASE WHEN c.integration = ? AND c.visible = 1 THEN 1 ELSE 0 END) AS bridge_visible
      FROM models m LEFT JOIN client_catalog_entries c ON c.model_db_id = m.id
      WHERE m.id = ? GROUP BY m.id
    `).get(BRIDGE_INTEGRATION, modelDbId) as {
      id: number; display_name: string; enabled: number; context_window: number | null; native_vision: number; supports_reasoning: number; bridge_visible: number;
    } | undefined;
    if (!current) throw new ConfigurationValidationError(`Model '${modelDbId}' does not exist`);
    const next = {
      displayName: input.displayName ?? current.display_name,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      contextWindow: input.contextWindow === undefined ? current.context_window : input.contextWindow,
      nativeVision: input.nativeVision === undefined ? current.native_vision : input.nativeVision ? 1 : 0,
      supportsReasoning: input.supportsReasoning === undefined ? current.supports_reasoning : input.supportsReasoning ? 1 : 0,
      bridgeVisible: input.bridgeVisible === undefined ? current.bridge_visible === 1 : input.bridgeVisible,
    };
    if (!next.displayName.trim()) throw new ConfigurationValidationError('displayName cannot be empty');
    db.prepare(`
      UPDATE models SET display_name = ?, enabled = ?, context_window = ?, native_vision = ?, supports_reasoning = ?
      WHERE id = ?
    `).run(next.displayName.trim(), next.enabled, next.contextWindow, next.nativeVision, next.supportsReasoning, modelDbId);
    if (input.bridgeVisible !== undefined) {
      db.prepare('UPDATE client_catalog_entries SET visible = ? WHERE integration = ? AND model_db_id = ?')
        .run(next.bridgeVisible ? 1 : 0, BRIDGE_INTEGRATION, modelDbId);
    }
    if (input.enabled !== undefined) {
      db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?').run(next.enabled, modelDbId);
      db.prepare('UPDATE routing_route_members SET enabled = ? WHERE model_db_id = ? AND route_id = ?').run(next.enabled, modelDbId, AUTO_ROUTE_ID);
    }
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Actualización del modelo ${modelDbId}`, { type: 'model', modelDbId, before: current, after: next });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
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
  expectedRevision?: number;
  idempotencyKey?: string;
}): ConfigurationSnapshot {
  const platform = input.platform.trim().toLowerCase();
  const modelId = input.modelId.trim();
  const displayName = input.displayName.trim();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(platform)) throw new ConfigurationValidationError('platform must be a stable lowercase slug');
  if (!modelId || modelId.length > 200) throw new ConfigurationValidationError('modelId is required and must be at most 200 characters');
  if (!displayName) throw new ConfigurationValidationError('displayName cannot be empty');
  const db = getDb();
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'model-create', input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number } | undefined;
    if (duplicate) throw new ConfigurationValidationError(`Model '${platform}/${modelId}' already exists`);
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
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
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
}

/**
 * Materialize the models selected in the provider wizard into the canonical
 * catalog. This is intentionally idempotent: reactivating a draft must not
 * duplicate models, routes, or bridge entries.
 */
export function materializeConfigurationModels(
  platform: string,
  models: Array<{
    modelId: string;
    displayName: string;
    contextWindow: number | null;
    nativeVision: boolean;
    supportsReasoning: boolean;
  }>,
  options: { actor?: string; source?: string } = {},
): ConfigurationSnapshot {
  const normalizedPlatform = platform.trim().toLowerCase();
  if (!normalizedPlatform || models.length === 0) return getConfigurationSnapshot();
  const db = getDb();
  const uniqueModels = [...new Map(models.map(model => [model.modelId, model])).values()];
  const pending = uniqueModels.filter(model => {
    const existing = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(normalizedPlatform, model.modelId);
    return !existing;
  });
  if (pending.length === 0) return getConfigurationSnapshot();

  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    const ranks = db.prepare('SELECT COALESCE(MAX(intelligence_rank), 0) AS intelligence, COALESCE(MAX(speed_rank), 0) AS speed FROM models').get() as { intelligence: number; speed: number };
    const insertModel = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        context_window, native_vision, supports_reasoning, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const insertCatalog = db.prepare(`
      INSERT INTO client_catalog_entries (
        integration, external_slug, route_id, model_db_id, picker_id, display_name,
        native_vision, supports_reasoning, context_window, visible, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1000)
    `);
    pending.forEach((model, index) => {
      const modelResult = insertModel.run(
        normalizedPlatform,
        model.modelId,
        model.displayName.trim(),
        ranks.intelligence + index + 1,
        ranks.speed + index + 1,
        model.contextWindow,
        model.nativeVision ? 1 : 0,
        model.supportsReasoning ? 1 : 0,
      );
      const modelDbId = Number(modelResult.lastInsertRowid);
      const routeId = safeRouteId(normalizedPlatform, model.modelId);
      ensureRoute(db, routeId, model.displayName, 'pinned', true);
      ensureMember(db, routeId, modelDbId, 1, true);
      insertCatalog.run(
        BRIDGE_INTEGRATION,
        `${normalizedPlatform}/${model.modelId}`,
        routeId,
        modelDbId,
        safePickerId(normalizedPlatform, model.modelId),
        model.displayName,
        model.nativeVision ? 1 : 0,
        model.supportsReasoning ? 1 : 0,
        model.contextWindow,
      );
    });
    writeRevision(
      db,
      currentRevision,
      options.actor ?? 'provider-registry',
      options.source ?? 'provider-model-materialization',
      `Materialización de modelos del proveedor ${normalizedPlatform}`,
      { type: 'provider-model-materialization', platform: normalizedPlatform, models: pending.map(model => model.modelId) },
    );
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
      AND (c.model_db_id IS NULL OR (m.enabled = 1 AND NOT EXISTS (
        SELECT 1 FROM configuration_providers p
        WHERE p.platform = m.platform AND (p.enabled = 0 OR p.lifecycle <> 'active')
      )))
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
  // Hash only the transport/catalog contract. `routeId` is an internal
  // diagnostic detail and is intentionally not copied into the bridge file.
  const hashEntries = entries.map(({ routeId: _routeId, ...entry }) => entry);
  const hash = crypto.createHash('sha256').update(JSON.stringify(hashEntries)).digest('hex');
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
