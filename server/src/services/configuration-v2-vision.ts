import { getDb } from '../db/index.js';
import {
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  type ConfigurationSnapshot,
} from './configuration-v2-contract.js';
import { getConfigurationSnapshot } from './configuration-v2-catalog.js';
import { getRevision, getBridgeVisionModels, writeRevision } from './configuration-v2-storage.js';

export interface BridgeVisionRouteUpdate {
  routeId: string;
  priority: number;
  enabled: boolean;
}

function validateVisionUpdates(input: BridgeVisionRouteUpdate[]): BridgeVisionRouteUpdate[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConfigurationValidationError('La cadena de visión debe contener al menos una ruta');
  }
  const normalized = input.map((route, index) => {
    if (!route || typeof route.routeId !== 'string' || !/^[a-z][a-z0-9:._-]{1,127}$/.test(route.routeId)) {
      throw new ConfigurationValidationError(`La ruta de visión ${index} tiene un routeId inválido`);
    }
    if (!Number.isSafeInteger(route.priority) || route.priority <= 0) {
      throw new ConfigurationValidationError(`La ruta de visión ${index} tiene una prioridad inválida`);
    }
    if (typeof route.enabled !== 'boolean') {
      throw new ConfigurationValidationError(`La ruta de visión ${index} tiene un estado inválido`);
    }
    return { routeId: route.routeId, priority: route.priority, enabled: route.enabled };
  });
  if (new Set(normalized.map(route => route.routeId)).size !== normalized.length) {
    throw new ConfigurationValidationError('La cadena de visión no puede repetir rutas');
  }
  const priorities = normalized.map(route => route.priority).sort((left, right) => left - right);
  if (priorities.some((priority, index) => priority !== index + 1)) {
    throw new ConfigurationValidationError('Las prioridades de visión deben ser contiguas desde 1');
  }
  return normalized;
}

export { getBridgeVisionModels } from './configuration-v2-storage.js';

export function updateBridgeVisionModels(input: {
  expectedRevision?: number;
  routes: BridgeVisionRouteUpdate[];
  actor?: string;
  source?: string;
}): ConfigurationSnapshot {
  const db = getDb();
  const routes = validateVisionUpdates(input.routes);
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new ConfigurationRevisionConflictError(currentRevision);
    }
    const persisted = db.prepare('SELECT route_id FROM bridge_vision_routes ORDER BY route_id').all() as Array<{ route_id: string }>;
    const persistedIds = new Set(persisted.map(route => route.route_id));
    if (persistedIds.size !== routes.length || routes.some(route => !persistedIds.has(route.routeId))) {
      throw new ConfigurationValidationError('La actualización debe incluir exactamente las rutas de visión persistidas');
    }
    const update = db.prepare(`
      UPDATE bridge_vision_routes
      SET priority = ?, enabled = ?, updated_at = datetime('now')
      WHERE route_id = ?
    `);
    for (const route of routes) {
      const result = update.run(route.priority, route.enabled ? 1 : 0, route.routeId);
      if (result.changes !== 1) throw new ConfigurationValidationError(`La ruta de visión '${route.routeId}' no existe`);
    }
    writeRevision(
      db,
      currentRevision,
      input.actor ?? 'configuration-api',
      input.source ?? 'configuration-vision',
      'Actualización de la cadena de visión del bridge',
      { type: 'bridge-vision-routes', routes },
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getConfigurationSnapshot();
}
