import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdmin } from '../../lib/admin-auth.js';
import { getRoutingSnapshot } from '../../services/routing-policy.js';
import { getRoutingRuntimeSnapshot } from '../../services/routing-runtime.js';
import { getDb } from '../../db/index.js';

export const controlStatusRouter = Router();

controlStatusRouter.get('/', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const models = getDb().prepare(`
    SELECT m.id AS modelDbId, m.platform, m.model_id AS modelId, m.display_name AS displayName,
           fc.priority, fc.enabled
    FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY fc.priority ASC
  `).all();
  const routingEntries = models.map(row => ({
    modelDbId: Number((row as { modelDbId: number }).modelDbId),
    priority: Number((row as { priority: number }).priority),
    enabled: Boolean((row as { enabled: number }).enabled),
  }));
  res.json({
    schemaVersion: 'glory-control-status-v1',
    service: 'gloryapi',
    pid: process.pid,
    routing: getRoutingSnapshot(routingEntries),
    runtime: getRoutingRuntimeSnapshot(),
    models,
  });
});
