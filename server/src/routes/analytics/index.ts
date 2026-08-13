import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../../db/index.js';
import type {
  SummaryRow,
  ModelStatsRow,
  PlatformStatsRow,
  TimelineRow,
  ErrorDetailRow,
  CategoryRow,
  PlatformErrorRow,
  HistoryRow,
  RecentErrorRow,
} from '../../lib/analytics/contract.js';
import { requireAdmin } from '../../lib/admin-auth.js';

export const analyticsRouter = Router();
analyticsRouter.use((req, res, next) => {
  if (requireAdmin(req, res)) next();
});

const ERROR_CATEGORY_SQL = `
  CASE
    WHEN error LIKE '%400%' OR error LIKE '%invalid request%' OR error LIKE '%invalid json payload%' THEN 'Bad Request (400)'
    WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
    WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid key%' THEN 'Auth Error (401)'
    WHEN error LIKE '%402%' OR error LIKE '%payment required%' THEN 'Payment Required (402)'
    WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
    WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
    WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
    WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
    WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
    ELSE 'Other'
  END
`;

// SQLite stores these timestamps as UTC `YYYY-MM-DD HH:MM:SS`. Use the same
// representation for lexical comparisons; ISO's `T` would exclude rows from
// the boundary date even when they fall inside the requested range.
function getSinceTimestamp(range: string): string {
  const now = Date.now();
  let since: Date;
  switch (range) {
    case '24h':
      since = new Date(now - 24 * 60 * 60 * 1000);
      break;
    case '30d':
      since = new Date(now - 30 * 24 * 60 * 60 * 1000);
      break;
    case '7d':
    default:
      since = new Date(now - 7 * 24 * 60 * 60 * 1000);
      break;
  }
  return since.toISOString().replace('T', ' ').slice(0, 19);
}

// Summary stats
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN request_kind = 'main' THEN 1 ELSE 0 END) as main_requests,
      SUM(CASE WHEN request_kind <> 'main' THEN 1 ELSE 0 END) as auxiliary_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(reasoning_tokens) as total_reasoning_tokens,
      SUM(cached_input_tokens) as cached_input_tokens,
      SUM(cache_write_tokens) as cache_write_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM requests
    WHERE created_at >= ?
  `).get(since) as SummaryRow;

  const totalRequests = stats.total_requests ?? 0;
  const successRate = totalRequests > 0 ? ((stats.success_count ?? 0) / totalRequests) * 100 : 0;
  const totalTokens = (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0);

  // Estimate cost savings: average ~$3/M input + $15/M output tokens (GPT-4o pricing)
  const inputCost = ((stats.total_input_tokens ?? 0) / 1_000_000) * 3;
  const outputCost = ((stats.total_output_tokens ?? 0) / 1_000_000) * 15;

  res.json({
    totalRequests,
    mainRequests: stats.main_requests ?? 0,
    auxiliaryRequests: stats.auxiliary_requests ?? 0,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: stats.total_input_tokens ?? 0,
    totalOutputTokens: stats.total_output_tokens ?? 0,
    totalReasoningTokens: stats.total_reasoning_tokens ?? 0,
    cachedInputTokens: stats.cached_input_tokens ?? 0,
    cacheWriteTokens: stats.cache_write_tokens ?? 0,
    avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
  });
});

// Stats grouped by model
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(since) as ModelStatsRow[];

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Stats grouped by platform
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      platform,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(latency_ms) as avg_latency_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform
    ORDER BY requests DESC
  `).all(since) as PlatformStatsRow[];

  res.json(rows.map(r => ({
    platform: r.platform,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Timeline data
analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  // dateFormat is a hardcoded whitelist — never user-controlled.
  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', created_at) as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests
    WHERE created_at >= ?
    GROUP BY strftime('${dateFormat}', created_at)
    ORDER BY timestamp ASC
  `).all(since) as TimelineRow[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
  })));
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      platform,
      model_id,
      ${ERROR_CATEGORY_SQL} as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform, error_category
    ORDER BY count DESC
  `).all(since) as ErrorDetailRow[];

  // Also get totals by category
  const byCategory = db.prepare(`
    SELECT
      ${ERROR_CATEGORY_SQL} as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY category
    ORDER BY count DESC
  `).all(since) as CategoryRow[];

  // Errors by platform
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform
    ORDER BY count DESC
  `).all(since) as PlatformErrorRow[];

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

analyticsRouter.get('/history', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 50;

  const rows = db.prepare(`
    SELECT
      r.id,
      r.platform,
      r.model_id,
      m.display_name,
      r.status,
      r.input_tokens,
      r.output_tokens,
      r.reasoning_effort,
      r.reasoning_tokens,
      r.reasoning_tokens_source,
      r.latency_ms,
      r.error,
      r.created_at,
      r.api_key_id,
      ak.label as api_key_label,
      r.request_kind,
      r.parent_request_id,
      r.cached_input_tokens,
      r.cache_write_tokens,
      CASE
        WHEN r.status = 'success' THEN 'Success'
        ELSE ${ERROR_CATEGORY_SQL.replaceAll('error', 'r.error')}
      END as result_brief
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    LEFT JOIN api_keys ak ON ak.id = r.api_key_id
    WHERE r.created_at >= ?
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?
  `).all(since, limit) as HistoryRow[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    status: r.status,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    reasoningEffort: r.reasoning_effort,
    reasoningTokens: r.reasoning_tokens ?? 0,
    reasoningTokensSource: r.reasoning_tokens_source ?? 'none',
    latencyMs: r.latency_ms ?? 0,
    error: r.error,
    errorPreview: typeof r.error === 'string' ? r.error.slice(0, 120) : null,
    resultBrief: r.result_brief,
    createdAt: r.created_at,
    apiKeyId: r.api_key_id,
    apiKeyLabel: r.api_key_label,
    requestKind: r.request_kind ?? 'main',
    parentRequestId: r.parent_request_id,
    cachedInputTokens: r.cached_input_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
  })));
});

// Recent errors
analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(since) as RecentErrorRow[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
});
