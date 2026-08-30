import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { getConfiguredProviders } from './provider-configuration.js';
import {
  BRIDGE_INTEGRATION,
  CONFIGURATION_SCHEMA,
  type ConfigurationModel,
  type ConfigurationProvider,
  type ConfigurationRoute,
  type ConfigurationRouteKind,
  type ConfigurationSchema,
} from './configuration-v2-contract.js';

/* Consultas de lectura puras del subsistema de configuración v2. Extraído de
 * configuration-v2-storage.ts para mantener cada archivo bajo el límite de
 * líneas del servicio. [por que] Estas funciones solo leen (getDb) y no
 * mutan ni dependen del estado en memoria (routingSnapshot), por lo que
 * pueden vivir en un módulo separado sin riesgo de ciclos. */

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
           MAX(CASE WHEN c.integration = ? AND c.visible = 1 THEN 1 ELSE 0 END) AS bridge_visible,
           MAX(CASE WHEN c.integration = ? THEN c.picker_id ELSE NULL END) AS picker_id
    FROM models m
    LEFT JOIN routing_route_members rm ON rm.model_db_id = m.id
    LEFT JOIN client_catalog_entries c ON c.model_db_id = m.id
    GROUP BY m.id ORDER BY m.platform ASC, m.display_name ASC
  `).all(BRIDGE_INTEGRATION, BRIDGE_INTEGRATION) as Array<{
    id: number; platform: string; model_id: string; display_name: string; enabled: number;
    context_window: number | null; native_vision: number; supports_reasoning: number;
    route_ids: string | null; bridge_visible: number; picker_id: string | null;
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
    pickerId: row.picker_id,
  }));
}

export function getConfigurationProviders(): ConfigurationProvider[] {
  return getConfiguredProviders(getDb());
}

export function getConfigurationSchema(): ConfigurationSchema {
  return CONFIGURATION_SCHEMA;
}