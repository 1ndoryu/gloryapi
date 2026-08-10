import Database from 'better-sqlite3';
import { buildLatestBenchmarkSnapshot, type CatalogModelForBenchmark } from './benchmark-snapshot.js';
import { buildLatestRankingSnapshot, type CatalogModelForRanking } from './ranking-snapshot.js';

export function reapplyLatestRankingSnapshot(db: Database.Database, setRank: Database.Statement) {
  const enabledModels = db.prepare(`
    SELECT
      platform,
      model_id AS modelId,
      intelligence_rank AS intelligenceRank,
      speed_rank AS speedRank,
      display_name AS displayName,
      enabled
    FROM models
  `).all() as CatalogModelForRanking[];

  for (const [rank, platform, modelId] of buildLatestRankingSnapshot(enabledModels)) {
    setRank.run(rank, platform, modelId);
  }
}

export function ensureModelBenchmarkColumns(db: Database.Database) {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(models)`).all() as { name: string }[])
      .map(column => column.name),
  );

  if (!columns.has('arena_elo')) {
    db.exec('ALTER TABLE models ADD COLUMN arena_elo INTEGER');
  }

  if (!columns.has('artificial_analysis_coding_index')) {
    db.exec('ALTER TABLE models ADD COLUMN artificial_analysis_coding_index REAL');
  }
}

export function reapplyLatestBenchmarkSnapshot(db: Database.Database, setBenchmark: Database.Statement) {
  db.prepare('UPDATE models SET arena_elo = NULL, artificial_analysis_coding_index = NULL').run();

  const catalogModels = db.prepare(`
    SELECT
      platform,
      model_id AS modelId
    FROM models
  `).all() as CatalogModelForBenchmark[];

  for (const update of buildLatestBenchmarkSnapshot(catalogModels)) {
    setBenchmark.run(update.arenaElo, update.artificialAnalysisCodingIndex, update.platform, update.modelId);
  }
}
