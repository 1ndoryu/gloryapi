import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties } from '../services/router.js';
import {
  getRoutingSnapshot,
  RoutingRevisionConflictError,
  RoutingValidationError,
  updateRoutingPolicy,
} from '../services/routing-policy.js';
import { publishRoutingChanged, subscribeToRoutingEvents } from '../services/routing-events.js';
import { getRoutingRuntimeSnapshot } from '../services/routing-runtime.js';
import { getRecentRoutingTraces } from '../services/routing-trace.js';
import { requireAdmin } from '../lib/admin-auth.js';

export const fallbackRouter = Router();

type FallbackRow = {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  arena_elo: number | null;
  artificial_analysis_coding_index: number | null;
};

fallbackRouter.get('/events', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  subscribeToRoutingEvents(res);
});

fallbackRouter.get('/traces', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ schemaVersion: 'glory-routing-trace-v1', traces: getRecentRoutingTraces() });
});

fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.arena_elo, m.artificial_analysis_coding_index
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  const requestStats = db.prepare(`
    SELECT r.platform, r.model_id,
           COUNT(*) as total_requests,
           SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as successful_requests
    FROM requests r
    WHERE r.created_at >= datetime('now', '-30 days')
    GROUP BY r.platform, r.model_id
  `).all() as { platform: string; model_id: string; total_requests: number; successful_requests: number }[];
  const statsMap = new Map(requestStats.map(s => [`${s.platform}:${s.model_id}`, s]));

  const entries = rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const stats = statsMap.get(`${r.platform}:${r.model_id}`);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      arenaElo: r.arena_elo,
      artificialAnalysisCodingIndex: r.artificial_analysis_coding_index,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      keyCount: keyCountMap.get(r.platform) ?? 0,
      totalRequests: stats?.total_requests ?? 0,
      successRate: stats && stats.total_requests > 0 ? Math.round((stats.successful_requests / stats.total_requests) * 100) : null,
    };
  });

  res.json({ ...getRoutingSnapshot(entries), entries, runtime: getRoutingRuntimeSnapshot() });
});

const updateSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  entries: z.array(z.object({
    modelDbId: z.number(),
    priority: z.number(),
    enabled: z.boolean(),
  })),
}).strict();

fallbackRouter.put('/', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  try {
    const snapshot = updateRoutingPolicy(parsed.data.entries, parsed.data.expectedRevision);
    publishRoutingChanged(snapshot);
    res.json(snapshot);
  } catch (error) {
    if (error instanceof RoutingRevisionConflictError) {
      res.status(409).json({ error: { message: error.message, code: 'routing_revision_conflict' }, currentRevision: error.currentRevision });
      return;
    }
    if (error instanceof RoutingValidationError) {
      res.status(400).json({ error: { message: error.message, code: 'invalid_routing' } });
      return;
    }
    throw error;
  }
});
