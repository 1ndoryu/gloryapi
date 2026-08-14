import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/index.js';
import {
  AUTO_ROUTE_ID,
  BRIDGE_INTEGRATION,
  normalizeBridgeContextWindow,
  type BridgeCatalogProjection,
  type BridgeCatalogSyncStatus,
  type ConfigurationSnapshot,
} from './configuration-v2-contract.js';
import {
  currentConfigurationRevision,
  getConfigurationModels,
  getConfigurationProviders,
  getConfigurationRoutes,
  getConfigurationSchema,
  getRevision,
  writeRevision,
} from './configuration-v2-storage.js';

function bridgeCatalogPath(): string {
  const configured = process.env.GLORYAPI_BRIDGE_CATALOG_PATH || process.env.BRIDGE_MODEL_CATALOG_FILE;
  return path.resolve(configured || path.join(os.homedir(), '.gloryapi', 'runtime', 'bridge-runtime', 'bridge-model-catalog.json'));
}

export function getBridgeCatalogSyncStatus(projection: Omit<BridgeCatalogProjection, 'sync'>): BridgeCatalogSyncStatus {
  const catalogPath = bridgeCatalogPath();
  const checkedAt = new Date().toISOString();
  if (!fs.existsSync(catalogPath)) {
    return { state: 'missing', path: catalogPath, checkedAt, revision: null, hash: null, errors: ['No existe una proyección local del bridge en la ruta configurada'] };
  }
  try {
    const file = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { schemaVersion?: string; revision?: number; hash?: string; entries?: unknown[] };
    const errors: string[] = [];
    const fileRevision = typeof file.revision === 'number' && Number.isSafeInteger(file.revision) ? file.revision : null;
    if (file.schemaVersion !== projection.schemaVersion) errors.push('schemaVersion local desactualizado');
    if (!Number.isSafeInteger(file.revision)) errors.push('revision local inválida');
    if (!Array.isArray(file.entries)) errors.push('entries local no es un array');
    const entries = Array.isArray(file.entries) ? file.entries : [];
    const hashEntries = entries.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { routeId: _routeId, ...transportEntry } = value as Record<string, unknown>;
      return transportEntry;
    });
    const calculatedHash = crypto.createHash('sha256').update(JSON.stringify(hashEntries)).digest('hex');
    if (file.hash !== calculatedHash) errors.push('hash local no coincide con entries');
    if (fileRevision !== projection.revision) errors.push(`revision local=${String(file.revision)} canónica=${projection.revision}`);
    if (file.hash !== projection.hash) errors.push('hash local no coincide con la proyección canónica');
    return {
      state: errors.length === 0 ? 'synced' : 'stale',
      path: catalogPath,
      checkedAt,
      revision: fileRevision,
      hash: typeof file.hash === 'string' ? file.hash : null,
      errors,
    };
  } catch (error) {
    return { state: 'invalid', path: catalogPath, checkedAt, revision: null, hash: null, errors: [error instanceof Error ? error.message : 'No se pudo leer la proyección local'] };
  }
}

export function getConfigurationSnapshot(): ConfigurationSnapshot {
  const bridge = getBridgeCatalogProjection();
  return {
    schemaVersion: 'glory-configuration-v2',
    revision: currentConfigurationRevision(),
    routes: getConfigurationRoutes(),
    models: getConfigurationModels(),
    providers: getConfigurationProviders(),
    schema: getConfigurationSchema(),
    bridge: { ...bridge, sync: getBridgeCatalogSyncStatus(bridge) },
  };
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
    contextWindow: normalizeBridgeContextWindow(row.context_window),
    routeId: row.route_id,
  }));
  const revision = currentConfigurationRevision();
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
