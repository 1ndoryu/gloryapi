import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import type { Platform } from '@gloryapi/shared/types.js';
import { requireAdmin } from '../lib/admin-auth.js';

export const modelsRouter = Router();
modelsRouter.use((req, res, next) => {
  if (requireAdmin(req, res)) next();
});

type ModelRow = {
  id: number;
  platform: Platform;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  arena_elo: number | null;
  artificial_analysis_coding_index: number | null;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  context_window: number | null;
  cold_start_retry_ms: number | null;
  enabled: number;
  priority: number | null;
  fallback_enabled: number | null;
  native_vision: number;
  supports_reasoning: number;
};

function compareModelsForCatalog(a: { enabled: boolean; intelligenceRank: number; speedRank: number; displayName: string }, b: { enabled: boolean; intelligenceRank: number; speedRank: number; displayName: string }) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  if (a.intelligenceRank !== b.intelligenceRank) return a.intelligenceRank - b.intelligenceRank;
  if (a.speedRank !== b.speedRank) return a.speedRank - b.speedRank;
  return a.displayName.localeCompare(b.displayName);
}

// List visible models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = 1
    ORDER BY
      CASE WHEN m.enabled = 1 THEN 0 ELSE 1 END ASC,
      m.intelligence_rank ASC,
      m.speed_rank ASC,
      m.display_name ASC
  `).all() as ModelRow[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    arenaElo: m.arena_elo,
    artificialAnalysisCodingIndex: m.artificial_analysis_coding_index,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    nativeVision: m.native_vision === 1,
    supportsReasoning: m.supports_reasoning === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  })).sort(compareModelsForCatalog);

  res.json(result);
});
