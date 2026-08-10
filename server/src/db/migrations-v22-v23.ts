import Database from 'better-sqlite3';
import {
  ensureModelBenchmarkColumns,
  reapplyLatestBenchmarkSnapshot,
  reapplyLatestRankingSnapshot,
} from './migration-snapshots.js';

interface CatalogAdditionIdentity {
  platform: string;
  modelId: string;
  displayName: string;
  sizeLabel: string;
}

interface CatalogAdditionRanking {
  intelligenceRank: number;
  speedRank: number;
}

interface CatalogAdditionLimits {
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
}

interface CatalogAddition extends CatalogAdditionIdentity, CatalogAdditionRanking, CatalogAdditionLimits {}

function insertOrUpdateModels(db: Database.Database, additions: CatalogAddition[]) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank,
       size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
       monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?,
      size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?,
      tpd_limit = ?, monthly_token_budget = ?, context_window = ?
    WHERE platform = ? AND model_id = ?
  `);

  for (const model of additions) {
    insert.run(model.platform, model.modelId, model.displayName, model.intelligenceRank,
      model.speedRank, model.sizeLabel, model.rpmLimit, model.rpdLimit,
      model.tpmLimit, model.tpdLimit, model.monthlyTokenBudget, model.contextWindow);
    update.run(model.displayName, model.intelligenceRank, model.speedRank, model.sizeLabel,
      model.rpmLimit, model.rpdLimit, model.tpmLimit, model.tpdLimit,
      model.monthlyTokenBudget, model.contextWindow, model.platform, model.modelId);
  }
}

function ensureFallbackRows(db: Database.Database) {
  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
  `).all() as { id: number }[];
  if (missing.length === 0) return;

  const maxPriority = (db.prepare(
    'SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config',
  ).get() as { value: number }).value;
  const addFallback = db.prepare(
    'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
  );
  for (let index = 0; index < missing.length; index++) {
    addFallback.run(missing[index].id, maxPriority + index + 1);
  }
}

function placeZenModelBefore(db: Database.Database, modelId: string, predecessorId: string) {
  const model = db.prepare(`
    SELECT fc.id, fc.priority FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE m.platform = 'opencode-zen' AND m.model_id = ?
  `).get(modelId) as { id: number; priority: number } | undefined;
  const predecessor = db.prepare(`
    SELECT fc.priority FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE m.platform = 'opencode-zen' AND m.model_id = ?
  `).get(predecessorId) as { priority: number } | undefined;
  if (!model || !predecessor || model.priority <= predecessor.priority) return;

  db.prepare('UPDATE fallback_config SET priority = priority + 1 WHERE priority >= ? AND priority < ?')
    .run(predecessor.priority, model.priority);
  db.prepare('UPDATE fallback_config SET priority = ? WHERE id = ?')
    .run(predecessor.priority, model.id);
}

export function migrateModelsV22(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: CatalogAddition[] = [{
    platform: 'opencode-zen', modelId: 'mimo-v2.5-free', displayName: 'MiMo V2.5 (Zen)',
    intelligenceRank: 9, speedRank: 9, sizeLabel: 'Frontier', rpmLimit: null,
    rpdLimit: null, tpmLimit: null, tpdLimit: null, monthlyTokenBudget: '~6M',
    contextWindow: 1048576,
  }];

  db.transaction(() => {
    const before = db.prepare("SELECT COUNT(*) AS value FROM models WHERE platform = 'opencode-zen' AND model_id = 'mimo-v2.5-free'").get() as { value: number };
    insertOrUpdateModels(db, additions);
    ensureFallbackRows(db);
    db.prepare("UPDATE fallback_config SET enabled = 1 WHERE model_db_id = (SELECT id FROM models WHERE platform = 'opencode-zen' AND model_id = 'mimo-v2.5-free')").run();
    if (before.value === 0) placeZenModelBefore(db, 'mimo-v2.5-free', 'deepseek-v4-flash-free');
    const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
    const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
    reapplyLatestRankingSnapshot(db, setRank);
    reapplyLatestBenchmarkSnapshot(db, setBenchmark);
  })();
}

export function migrateModelsV23(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const additions: CatalogAddition[] = [{
    platform: 'opencode-zen', modelId: 'minimax-m3-free', displayName: 'MiniMax M3 (Zen)',
    intelligenceRank: 17, speedRank: 9, sizeLabel: 'Large', rpmLimit: null,
    rpdLimit: null, tpmLimit: null, tpdLimit: null, monthlyTokenBudget: '~6M',
    contextWindow: 1048576,
  }];

  db.transaction(() => {
    const before = db.prepare("SELECT COUNT(*) AS value FROM models WHERE platform = 'opencode-zen' AND model_id = 'minimax-m3-free'").get() as { value: number };
    insertOrUpdateModels(db, additions);
    ensureFallbackRows(db);
    db.prepare("UPDATE fallback_config SET enabled = 1 WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'opencode-zen' AND model_id IN ('minimax-m3-free', 'minimax-m2.5-free'))").run();
    if (before.value === 0) placeZenModelBefore(db, 'minimax-m3-free', 'minimax-m2.5-free');
    const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
    const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
    reapplyLatestRankingSnapshot(db, setRank);
    reapplyLatestBenchmarkSnapshot(db, setBenchmark);
  })();
}

export function migrateModelsV24(db: Database.Database) {
  ensureModelBenchmarkColumns(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank,
       size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
       monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('commandcode', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash (CommandCode)',
    4, 9, 'Frontier', null, null, null, null, 'paid (Pro)', 1048576);
  const setRank = db.prepare('UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?');
  const setBenchmark = db.prepare('UPDATE models SET arena_elo = ?, artificial_analysis_coding_index = ? WHERE platform = ? AND model_id = ?');
  ensureFallbackRows(db);
  reapplyLatestRankingSnapshot(db, setRank);
  reapplyLatestBenchmarkSnapshot(db, setBenchmark);
}
