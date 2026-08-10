import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { checkKeyHealth, checkAllKeys, getProviderHealthStatus } from '../services/health.js';
import { hasProvider } from '../providers/index.js';
import { getRateLimitStatus } from '../services/ratelimit.js';
import type { Platform } from '@gloryapi/shared/types.js';

export const healthRouter = Router();

type HealthPlatformRow = {
  platform: Platform;
  total_keys: number;
  healthy_keys: number;
  rate_limited_keys: number;
  invalid_keys: number;
  error_keys: number;
  unknown_keys: number;
  enabled_keys: number;
};

type HealthKeyRow = {
  id: number;
  platform: string;
  label: string;
  status: string;
  enabled: number;
  created_at: string;
  last_checked_at: string | null;
};

type HealthModelCountRow = HealthKeyRow & { model_count: number };

type RateLimitRow = {
  key_id: number;
  platform: string;
  label: string;
  model_id: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
};

// Get health status for all platforms
healthRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const platforms = db.prepare(`
    SELECT
      platform,
      COUNT(*) as total_keys,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
      SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
    FROM api_keys
    GROUP BY platform
  `).all() as HealthPlatformRow[];

  const keys = db.prepare(`
    SELECT id, platform, label, status, enabled, created_at, last_checked_at
    FROM api_keys
    ORDER BY platform, created_at DESC
  `).all() as HealthKeyRow[];

  res.json({
    platforms: platforms.map(p => ({
      platform: p.platform,
      hasProvider: hasProvider(p.platform),
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: p.rate_limited_keys,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    })),
    keys: keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
    })),
  });
});

// Check a specific key
healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

// Check all keys
healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  await checkAllKeys();
  res.json({ success: true });
});

// Get per-key health status (dedicated endpoint)
healthRouter.get('/keys', (_req: Request, res: Response) => {
  const db = getDb();

  const keys = db.prepare(`
    SELECT k.id, k.platform, k.label, k.status, k.enabled, k.created_at, k.last_checked_at,
           COUNT(m.id) as model_count
    FROM api_keys k
    LEFT JOIN models m ON m.platform = k.platform AND m.enabled = 1
    GROUP BY k.id
    ORDER BY k.platform, k.created_at DESC
  `).all() as HealthModelCountRow[];

  res.json({
    keys: keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      modelCount: k.model_count,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
    })),
    total: keys.length,
    enabled: keys.filter(k => k.enabled === 1).length,
    healthy: keys.filter(k => k.status === 'healthy').length,
  });
});

// Get rate limit status (in-memory snapshot)
healthRouter.get('/ratelimits', (_req: Request, res: Response) => {
  const db = getDb();

  // Get all enabled keys with their platform limits
  const keys = db.prepare(`
    SELECT k.id as key_id, k.platform, k.label, m.model_id,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
    FROM api_keys k
    JOIN models m ON m.platform = k.platform
    WHERE k.enabled = 1 AND m.enabled = 1
    ORDER BY k.platform, m.model_id
  `).all() as RateLimitRow[];

  const status = keys.map(k => {
    const limits = {
      rpm: k.rpm_limit,
      rpd: k.rpd_limit,
      tpm: k.tpm_limit,
      tpd: k.tpd_limit,
    };
    const usage = getRateLimitStatus(k.platform, k.model_id, k.key_id, limits);
    return {
      platform: k.platform,
      modelId: k.model_id,
      keyId: k.key_id,
      keyLabel: k.label,
      ...usage,
    };
  });

  res.json({
    entries: status,
    total: status.length,
  });
});

/* [2076-15] Provider-level health status. Shows per-platform failure counts
 * and cooldown state. Used by the frontend to display which providers are
 * experiencing issues. */
healthRouter.get('/providers', (_req: Request, res: Response) => {
  const providers = getProviderHealthStatus();
  res.json({
    providers,
    total: providers.length,
    onCooldown: providers.filter(p => p.onCooldown).length,
  });
});
