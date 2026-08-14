import { getDb } from '../db/index.js';
import { ConfigurationRevisionConflictError, ConfigurationValidationError, normalizeBridgeContextWindow, type ConfigurationSnapshot } from './configuration-v2-contract.js';
import { abandonIdempotency, claimIdempotency, completeIdempotency, normalizeIdempotencyKey } from './configuration-v2-idempotency.js';
import { getConfigurationSnapshot } from './configuration-v2-catalog.js';
import { reconcileDesktopPickerAliases } from './configuration-v2-picker.js';
import { serializeConfigurationState } from './configuration-v2-snapshot.js';
import { currentConfigurationRevision, getRevision, writeRevision } from './configuration-v2-storage.js';
import { validateProviderEndpoint } from './configuration-v2-provider.js';
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

function normalizeDocumentContextWindow(value: unknown): number {
  return normalizeBridgeContextWindow(typeof value === 'number' ? value : null);
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
        UPDATE models SET display_name = ?, enabled = ?, context_window = ?, native_vision = ?, supports_reasoning = ?, capabilities_explicit = 1
        WHERE id = ?
      `).run(
        String(model.displayName ?? ''), model.enabled === false || model.enabled === 0 ? 0 : 1,
        normalizeBridgeContextWindow(model.contextWindow === null || model.context_window === null ? null : Number(model.contextWindow ?? model.context_window)),
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
      catalogInsert.run(entry.integration ?? 'codex-bridge', entry.externalSlug ?? entry.external_slug, entry.routeId ?? entry.route_id, entry.modelDbId ?? entry.model_db_id ?? null, entry.pickerId ?? entry.picker_id ?? null, entry.displayName ?? entry.display_name ?? entry.externalSlug ?? entry.external_slug, entry.nativeVision === true || entry.native_vision === 1 ? 1 : 0, entry.supportsReasoning === true || entry.supports_reasoning === 1 ? 1 : 0, normalizeDocumentContextWindow(entry.contextWindow ?? entry.context_window), entry.visible === false || entry.visible === 0 ? 0 : 1, Number(entry.sortOrder ?? entry.sort_order ?? 0));
    }
    reconcileDesktopPickerAliases(db);
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
