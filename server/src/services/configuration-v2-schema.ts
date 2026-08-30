import type Database from 'better-sqlite3';

/* DDL del subsistema de configuración v2 (tablas + índices) y los triggers de
 * sincronización de fallback. Extraído de configuration-v2-storage.ts para
 * mantener cada archivo bajo el límite de líneas del servicio y centralizar el
 * contrato de esquema en un solo módulo. [por que] La definición de tablas es
 * un contrato de persistencia duradero que no depende de la lógica de negocio
 * de almacenamiento y cambiarla no requiere entender el flujo de migración. */
export function ensureConfigurationSchema(db: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS bridge_vision_routes (
      route_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      completions_path TEXT NOT NULL DEFAULT '/chat/completions',
      auth_platform TEXT NOT NULL,
      context_window INTEGER,
      priority INTEGER NOT NULL CHECK (priority > 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_vision_routes_order ON bridge_vision_routes(priority, route_id);
  `);
}

export function ensureFallbackTriggers(db: Database.Database): void {
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