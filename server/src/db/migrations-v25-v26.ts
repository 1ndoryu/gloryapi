import Database from 'better-sqlite3';
import {
  ensureModelBenchmarkColumns,
  reapplyLatestBenchmarkSnapshot,
  reapplyLatestRankingSnapshot,
} from './migration-snapshots.js';

export function migrateModelsV25(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'api_key_id')) {
    db.exec('ALTER TABLE requests ADD COLUMN api_key_id INTEGER REFERENCES api_keys(id)');
  }
}

export function migrateModelsV26(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions = [
    ['opencode-go', 'deepseek-v4-pro', 'DeepSeek V4 Pro (Go)', 5, 9, 'Frontier', null, null, null, null, 'paid (Go)', 1048576],
    ['opencode-go', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Go)', 10, 9, 'Frontier', null, null, null, null, 'paid (Go)', 1048576],
    ['opencode-go', 'mimo-v2.5', 'MiMo V2.5 (Go)', 9, 9, 'Large', null, null, null, null, 'paid (Go)', 1048576],
    ['opencode-go', 'mimo-v2.5-pro', 'MiMo V2.5 Pro (Go)', 7, 9, 'Large', null, null, null, null, 'paid (Go)', 1048576],
  ] as const;
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
  db.transaction(() => {
    for (const model of additions) {
      insert.run(...model);
      update.run(model[2], model[3], model[4], model[5], model[6], model[7], model[8], model[9], model[10], model[11], model[0], model[1]);
    }
    const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
    const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
    reapplyLatestRankingSnapshot(db, setRank);
    reapplyLatestBenchmarkSnapshot(db, setBenchmark);
  })();
}
