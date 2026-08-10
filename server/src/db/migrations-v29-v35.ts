import Database from 'better-sqlite3';
import {
  ensureModelBenchmarkColumns,
  reapplyLatestBenchmarkSnapshot,
  reapplyLatestRankingSnapshot,
} from './migration-snapshots.js';

type ModelAddition = readonly [
  platform: string,
  modelId: string,
  displayName: string,
  intelligenceRank: number,
  speedRank: number,
  sizeLabel: string,
  rpmLimit: number | null,
  rpdLimit: number | null,
  tpmLimit: number | null,
  tpdLimit: number | null,
  monthlyTokenBudget: string,
  contextWindow: number | null,
];

function insertModels(db: Database.Database, additions: readonly ModelAddition[]) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?,
      size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?,
      monthly_token_budget = ?, context_window = ?
    WHERE platform = ? AND model_id = ?
  `);
  for (const model of additions) {
    insert.run(...model);
    update.run(model[2], model[3], model[4], model[5], model[6], model[7], model[8], model[9], model[10], model[11], model[0], model[1]);
  }
}

function appendFallbackRows(db: Database.Database, additions: readonly ModelAddition[]) {
  const max = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
  const add = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    SELECT id, ?, 1 FROM models WHERE platform = ? AND model_id = ?
  `);
  additions.forEach((model, index) => add.run(max + index + 1, model[0], model[1]));
}

function refreshSnapshots(db: Database.Database) {
  const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
  const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
  reapplyLatestRankingSnapshot(db, setRank);
  reapplyLatestBenchmarkSnapshot(db, setBenchmark);
}

export function migrateModelsV29(db: Database.Database) {
  db.transaction(() => {
    const disable = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ?');
    const removeFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)');
    for (const platform of ['bluesminds', 'deepinfra', 'nebius', 'novita', 'nousresearch', 'reka', 'puter']) {
      removeFallback.run(platform);
      disable.run(platform);
    }
  })();
}

export function migrateModelsV30(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [[
    'tokenrouter', 'moonshotai/kimi-k3-free', 'Kimi K3 Free (TokenRouter)',
    4, 9, 'Frontier', null, null, null, null, 'free', 1048576,
  ]];
  db.transaction(() => {
    insertModels(db, additions);
    appendFallbackRows(db, additions);
    refreshSnapshots(db);
  })();
}

export function migrateModelsV31(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [[
    'bynara', 'claude-sonnet-5', 'Claude Sonnet 5 (Bynara)',
    3, 9, 'Frontier', null, null, null, null, 'free', 200000,
  ]];
  db.transaction(() => {
    insertModels(db, additions);
    appendFallbackRows(db, additions);
    refreshSnapshots(db);
  })();
}

export function migrateModelsV33(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: ModelAddition[] = [[
    'andoryyu', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash (Andoryyu)',
    10, 9, 'Frontier', null, null, null, null, 'free', 1048576,
  ]];
  db.transaction(() => {
    insertModels(db, additions);
    refreshSnapshots(db);
    const model = db.prepare("SELECT id FROM models WHERE platform = 'andoryyu' AND model_id = 'deepseek/deepseek-v4-flash'").get() as { id: number } | undefined;
    if (!model) return;
    const fallback = db.prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(model.id);
    if (!fallback) {
      db.prepare('UPDATE fallback_config SET priority = priority + 1').run();
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.id);
    }
  })();
}

export function migrateModelsV34(db: Database.Database) {
  db.transaction(() => {
    const bare = db.prepare("SELECT id FROM models WHERE platform = 'andoryyu' AND model_id = 'deepseek-v4-flash'").get() as { id: number } | undefined;
    if (bare) {
      const duplicates = db.prepare("SELECT id FROM models WHERE platform = 'andoryyu' AND model_id = 'deepseek/deepseek-v4-flash'").all() as { id: number }[];
      for (const duplicate of duplicates) {
        db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(duplicate.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(duplicate.id);
      }
    } else {
      db.prepare("UPDATE models SET model_id = 'deepseek-v4-flash' WHERE platform = 'andoryyu' AND model_id = 'deepseek/deepseek-v4-flash'").run();
    }

    const model = db.prepare("SELECT id FROM models WHERE platform = 'andoryyu' AND model_id = 'deepseek-v4-flash'").get() as { id: number } | undefined;
    if (!model) return;
    const fallback = db.prepare('SELECT id, priority FROM fallback_config WHERE model_db_id = ?').get(model.id) as { id: number; priority: number } | undefined;
    if (!fallback) {
      db.prepare('UPDATE fallback_config SET priority = priority + 1').run();
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.id);
    } else if (fallback.priority !== 1) {
      db.prepare('UPDATE fallback_config SET priority = priority + 1 WHERE model_db_id != ?').run(model.id);
      db.prepare('UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?').run(model.id);
    }
  })();
}

export function migrateModelsV35(db: Database.Database) {
  db.transaction(() => {
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'groq'").run();
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON f.model_db_id = m.id
      WHERE m.enabled = 1 AND f.id IS NULL
      ORDER BY m.intelligence_rank ASC, m.speed_rank ASC, m.id ASC
    `).all() as { id: number }[];
    let priority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
    const insert = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (const model of missing) insert.run(model.id, ++priority);
  })();
}
