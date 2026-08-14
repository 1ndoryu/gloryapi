import type Database from 'better-sqlite3';

/** Serializa el estado público sin credenciales para export, auditoría y rollback. */
export function serializeConfigurationState(db: Database.Database): unknown {
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
