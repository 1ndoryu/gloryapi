import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey } from '../lib/crypto.js';
import { ensureUnifiedKey, getUnifiedApiKey as readUnifiedApiKey, regenerateUnifiedKey as rotateUnifiedKey } from './security/unified-key.js';
import { migrateModelsV22, migrateModelsV23, migrateModelsV24 } from './migrations-v22-v23.js';
import { migrateModelsV25, migrateModelsV26 } from './migrations-v25-v26.js';
import { migrateModels, migrateModelsV2, migrateModelsV3Ranks, migrateModelsV4, migrateModelsV5, migrateModelsV6, migrateModelsV7, migrateModelsV8, migrateModelsV9, migrateModelsV10 } from './migrations-v1-v10.js';
import { migrateModelsV11, migrateModelsV12, migrateModelsV13, migrateModelsV14, migrateModelsV15, migrateModelsV16, migrateModelsV17, migrateModelsV18, migrateModelsV19, migrateModelsV20, migrateModelsV21 } from './migrations-v11-v21.js';
import { migrateModelsV27, migrateModelsV28, migrateModelsV32 } from './migrations-v27-v28-v32.js';
import { migrateModelsV29, migrateModelsV30, migrateModelsV31, migrateModelsV33, migrateModelsV34, migrateModelsV35 } from './migrations-v29-v35.js';
import { normalizeGloryCatalog } from './catalog/normalize.js';
import { seedLegacyModels } from './catalog/legacy-seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GLORYAPI_DB_PATH
  ? path.resolve(process.env.GLORYAPI_DB_PATH)
  : path.resolve(__dirname, '../../data/gloryapi.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export interface InitDbOptions {
  catalogMode?: 'operational' | 'legacy';
}

export function initDb(dbPath?: string, options: InitDbOptions = {}): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  const isMemory = resolvedPath === ':memory:';
  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(resolvedPath);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables(db);
  const hasLegacyCredentialRows = Boolean(db.prepare(
    "SELECT 1 FROM api_keys WHERE encryption_scheme = 'legacy-aes-gcm' LIMIT 1",
  ).get());
  if (isMemory || process.env.ENCRYPTION_KEY || hasLegacyCredentialRows) {
    initEncryptionKey(db);
  } else {
    // DPAPI-backed installations do not need a database-local AES master key.
    db.prepare("DELETE FROM settings WHERE key = 'encryption_key'").run();
  }
  const hasExistingCatalog = Boolean(
    (db.prepare('SELECT 1 AS present FROM models LIMIT 1').get() as { present: number } | undefined),
  );
  const useLegacyCatalogMigrations = options.catalogMode === 'legacy'
    || hasExistingCatalog
    || (options.catalogMode !== 'operational' && (isMemory || process.env.NODE_ENV === 'test'));

  if (useLegacyCatalogMigrations) {
    ensureLegacyCatalogColumns(db);
    seedLegacyModels(db);
    migrateModels(db);
    migrateModelsV2(db);
    migrateModelsV3Ranks(db);
    migrateModelsV4(db);
    migrateModelsV5(db);
    migrateModelsV6(db);
    migrateModelsV7(db);
    migrateModelsV8(db);
    migrateModelsV9(db);
    migrateModelsV10(db);
    migrateModelsV11(db);
    migrateModelsV12(db);
    migrateModelsV13(db);
    migrateModelsV14(db);
    migrateModelsV15(db);
    migrateModelsV16(db);
    migrateModelsV17(db);
    migrateModelsV18(db);
    migrateModelsV19(db);
    migrateModelsV20(db);
    migrateModelsV21(db);
    migrateModelsV22(db);
    migrateModelsV23(db);
    migrateModelsV24(db);
    migrateModelsV25(db);
    migrateModelsV26(db);
    migrateModelsV27(db);
    migrateModelsV28(db);
    migrateModelsV29(db);
    migrateModelsV30(db);
    migrateModelsV31(db);
    migrateModelsV32(db);
    migrateModelsV33(db);
    migrateModelsV34(db);
    migrateModelsV35(db);
    if (!isMemory && process.env.NODE_ENV !== 'test') normalizeGloryCatalog(db);
  } else {
    // A new operational database uses the compact GloryAPI schema directly;
    // historical catalog migrations are reserved for upgrades of old stores.
    normalizeGloryCatalog(db);
  }
  ensureUnifiedKey(db);

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      context_window INTEGER,
      arena_elo INTEGER,
      artificial_analysis_coding_index REAL,
      cold_start_retry_ms INTEGER DEFAULT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      encryption_scheme TEXT NOT NULL DEFAULT 'legacy-aes-gcm',
      fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      api_key_id INTEGER REFERENCES api_keys(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);

    CREATE TABLE IF NOT EXISTS provider_health (
      platform TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT,
      last_failure_at TEXT,
      last_success_at TEXT
    );

    CREATE TABLE IF NOT EXISTS provider_registry (
      platform TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'active', 'archived')),
      adapter TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      auth_scheme TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      health_verified_at TEXT,
      chat_verified_at TEXT,
      capabilities_verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS provider_model_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window INTEGER,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS provider_runtime_state (
      platform TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS local_auth_tokens (
      name TEXT PRIMARY KEY,
      encrypted_token TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      encryption_scheme TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      rotated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL,
      keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureApiKeyVaultColumns(db);
}

function ensureLegacyCatalogColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!columns.has('monthly_token_budget')) {
    db.exec("ALTER TABLE models ADD COLUMN monthly_token_budget TEXT NOT NULL DEFAULT ''");
  }
}

function ensureApiKeyVaultColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!columns.has('encryption_scheme')) {
    db.exec("ALTER TABLE api_keys ADD COLUMN encryption_scheme TEXT NOT NULL DEFAULT 'legacy-aes-gcm'");
  }
  if (!columns.has('fingerprint')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN fingerprint TEXT');
  }
}

export function getUnifiedApiKey(): string {
  return readUnifiedApiKey(getDb());
}

export function regenerateUnifiedKey(): string {
  return rotateUnifiedKey(getDb());
}
