import { getDb } from '../db/index.js';
import { AUTO_ROUTE_ID, BRIDGE_INTEGRATION, ConfigurationRevisionConflictError, ConfigurationValidationError, normalizeBridgeContextWindow, safeRouteId, type ConfigurationRouteKind, type ConfigurationSnapshot } from './configuration-v2-contract.js';
import { abandonIdempotency, claimIdempotency, completeIdempotency, normalizeIdempotencyKey } from './configuration-v2-idempotency.js';
import { getConfigurationSnapshot } from './configuration-v2-catalog.js';
import { allocateDesktopPickerAlias, requireDesktopPickerAlias } from './configuration-v2-picker.js';
import { ensureMember, ensureRoute, getRevision, writeRevision } from './configuration-v2-storage.js';

function assertReasoningCapability(db: ReturnType<typeof getDb>, platform: string, supportsReasoning: boolean): void {
  if (!supportsReasoning) return;
  const row = db.prepare('SELECT capabilities_json FROM configuration_providers WHERE platform = ?').get(platform) as { capabilities_json: string } | undefined;
  if (!row) return;
  let providerReasoning = false;
  try {
    const capabilities = JSON.parse(row.capabilities_json) as { reasoning?: unknown };
    providerReasoning = capabilities.reasoning === true;
  } catch {
    providerReasoning = false;
  }
  if (!providerReasoning) {
    throw new ConfigurationValidationError(`El proveedor '${platform}' no declara control de razonamiento para este modelo`);
  }
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
    pickerId?: string | null;
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
      SELECT m.id, m.platform, m.display_name, m.enabled, m.context_window, m.native_vision, m.supports_reasoning, m.capabilities_explicit,
             MAX(CASE WHEN c.integration = ? AND c.visible = 1 THEN 1 ELSE 0 END) AS bridge_visible,
             MAX(CASE WHEN c.integration = ? THEN c.picker_id ELSE NULL END) AS picker_id
      FROM models m LEFT JOIN client_catalog_entries c ON c.model_db_id = m.id
      WHERE m.id = ? GROUP BY m.id
    `).get(BRIDGE_INTEGRATION, BRIDGE_INTEGRATION, modelDbId) as {
      id: number; platform: string; display_name: string; enabled: number; context_window: number | null; native_vision: number; supports_reasoning: number; capabilities_explicit: number; bridge_visible: number; picker_id: string | null;
    } | undefined;
    if (!current) throw new ConfigurationValidationError(`Model '${modelDbId}' does not exist`);
    const next = {
      displayName: input.displayName ?? current.display_name,
      enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      contextWindow: normalizeBridgeContextWindow(input.contextWindow === undefined ? current.context_window : input.contextWindow),
      nativeVision: input.nativeVision === undefined ? current.native_vision : input.nativeVision ? 1 : 0,
      supportsReasoning: input.supportsReasoning === undefined ? current.supports_reasoning : input.supportsReasoning ? 1 : 0,
      capabilitiesExplicit: input.nativeVision === undefined && input.supportsReasoning === undefined
        ? current.capabilities_explicit
        : 1,
      bridgeVisible: input.bridgeVisible === undefined ? current.bridge_visible === 1 : input.bridgeVisible,
      pickerId: input.pickerId === undefined
        ? current.picker_id
        : input.pickerId === null
          ? null
          : requireDesktopPickerAlias(input.pickerId),
    };
    if (!next.displayName.trim()) throw new ConfigurationValidationError('displayName cannot be empty');
    assertReasoningCapability(db, current.platform, next.supportsReasoning === 1);
    if (next.bridgeVisible && !next.pickerId) {
      next.pickerId = allocateDesktopPickerAlias(db, modelDbId);
    }
    if (next.bridgeVisible && !next.pickerId) {
      throw new ConfigurationValidationError('No compatible Codex Desktop picker alias is available; hide another model or assign a free alias');
    }
    if (next.pickerId) {
      const owner = db.prepare(`
        SELECT model_db_id FROM client_catalog_entries
        WHERE integration = ? AND picker_id = ? AND model_db_id <> ?
      `).get(BRIDGE_INTEGRATION, next.pickerId, modelDbId) as { model_db_id: number } | undefined;
      if (owner) throw new ConfigurationValidationError(`pickerId '${next.pickerId}' is already assigned to another model`);
    }
    db.prepare(`
      UPDATE models SET display_name = ?, enabled = ?, context_window = ?, native_vision = ?, supports_reasoning = ?, capabilities_explicit = ?
      WHERE id = ?
    `).run(next.displayName.trim(), next.enabled, next.contextWindow, next.nativeVision, next.supportsReasoning, next.capabilitiesExplicit, modelDbId);
    db.prepare(`
      UPDATE client_catalog_entries SET
        picker_id = ?, visible = ?, display_name = ?, native_vision = ?,
        supports_reasoning = ?, context_window = ?
      WHERE integration = ? AND model_db_id = ?
    `).run(
      next.pickerId,
      next.bridgeVisible ? 1 : 0,
      next.displayName.trim(),
      next.nativeVision,
      next.supportsReasoning,
      next.contextWindow,
      BRIDGE_INTEGRATION,
      modelDbId,
    );
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
  bridgeVisible?: boolean;
  pickerId?: string;
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
  assertReasoningCapability(db, platform, input.supportsReasoning === true);
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
        context_window, native_vision, supports_reasoning, capabilities_explicit, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    `).run(
      platform,
      modelId,
      displayName,
      input.intelligenceRank ?? maxRanks.intelligence + 1,
      input.speedRank ?? maxRanks.speed + 1,
      normalizeBridgeContextWindow(input.contextWindow),
      input.nativeVision ? 1 : 0,
      input.supportsReasoning ? 1 : 0,
    );
    const modelDbId = Number(modelResult.lastInsertRowid);
    const routeId = safeRouteId(platform, modelId);
    ensureRoute(db, routeId, displayName, 'pinned', true);
    ensureMember(db, routeId, modelDbId, 1, true);
    const pickerId = input.pickerId === undefined
      ? allocateDesktopPickerAlias(db)
      : requireDesktopPickerAlias(input.pickerId);
    const bridgeVisible = input.bridgeVisible === undefined ? pickerId !== null : input.bridgeVisible;
    if (bridgeVisible && !pickerId) {
      throw new ConfigurationValidationError('No compatible Codex Desktop picker alias is available; create the model with bridgeVisible=false or free an alias');
    }
    if (pickerId) {
      const owner = db.prepare('SELECT model_db_id FROM client_catalog_entries WHERE integration = ? AND picker_id = ?')
        .get(BRIDGE_INTEGRATION, pickerId) as { model_db_id: number } | undefined;
      if (owner) throw new ConfigurationValidationError(`pickerId '${pickerId}' is already assigned to another model`);
    }
    db.prepare(`
      INSERT INTO client_catalog_entries (
        integration, external_slug, route_id, model_db_id, picker_id, display_name,
        native_vision, supports_reasoning, context_window, visible, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000)
    `).run(BRIDGE_INTEGRATION, `${platform}/${modelId}`, routeId, modelDbId, pickerId, displayName, input.nativeVision ? 1 : 0, input.supportsReasoning ? 1 : 0, normalizeBridgeContextWindow(input.contextWindow), bridgeVisible ? 1 : 0);
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
    for (const model of pending) assertReasoningCapability(db, normalizedPlatform, model.supportsReasoning);
    const currentRevision = getRevision(db);
    const ranks = db.prepare('SELECT COALESCE(MAX(intelligence_rank), 0) AS intelligence, COALESCE(MAX(speed_rank), 0) AS speed FROM models').get() as { intelligence: number; speed: number };
    const insertModel = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        context_window, native_vision, supports_reasoning, capabilities_explicit, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    `);
    const insertCatalog = db.prepare(`
      INSERT INTO client_catalog_entries (
        integration, external_slug, route_id, model_db_id, picker_id, display_name,
        native_vision, supports_reasoning, context_window, visible, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000)
    `);
    pending.forEach((model, index) => {
      const modelResult = insertModel.run(
        normalizedPlatform,
        model.modelId,
        model.displayName.trim(),
        ranks.intelligence + index + 1,
        ranks.speed + index + 1,
        normalizeBridgeContextWindow(model.contextWindow),
        model.nativeVision ? 1 : 0,
        model.supportsReasoning ? 1 : 0,
      );
      const modelDbId = Number(modelResult.lastInsertRowid);
      const routeId = safeRouteId(normalizedPlatform, model.modelId);
      ensureRoute(db, routeId, model.displayName, 'pinned', true);
      ensureMember(db, routeId, modelDbId, 1, true);
      const pickerId = allocateDesktopPickerAlias(db);
      insertCatalog.run(
        BRIDGE_INTEGRATION,
        `${normalizedPlatform}/${model.modelId}`,
        routeId,
        modelDbId,
        pickerId,
        model.displayName,
        model.nativeVision ? 1 : 0,
        model.supportsReasoning ? 1 : 0,
        normalizeBridgeContextWindow(model.contextWindow),
        pickerId ? 1 : 0,
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
