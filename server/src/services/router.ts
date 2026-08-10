import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { resolveStoredCredential } from '../lib/dpapi-vault.js';
import { canMakeRequest, canUseTokens, isOnCooldown, isNearLimit } from './ratelimit.js';
import { isProviderOnCooldown } from './health.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@gloryapi/shared/types.js';

interface ModelRow {
  id: number;
  platform: Platform;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  cold_start_retry_ms: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  encryption_scheme?: string;
  fingerprint?: string | null;
  status: string;
  enabled: number;
}

type RoutingError = Error & { status?: number };

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: Platform;
  displayName: string;
  coldStartRetryMs: number | null;
}

function tryRouteSpecificModel(
  model: ModelRow,
  estimatedTokens: number,
  skipKeys?: Set<string>,
): RouteResult | undefined {
  /* [2076-15] Skip entire provider if on cooldown (3+ consecutive failures). */
  if (isProviderOnCooldown(model.platform)) return undefined;

  const provider = getProvider(model.platform);
  if (!provider) return undefined;

  const db = getDb();
  const keys = db.prepare(
    'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
  ).all(model.platform, 'invalid') as KeyRow[];

  if (keys.length === 0) return undefined;

  const limits = {
    rpm: model.rpm_limit,
    rpd: model.rpd_limit,
    tpm: model.tpm_limit,
    tpd: model.tpd_limit,
  };

  const rrKey = `${model.platform}:${model.model_id}`;
  let idx = roundRobinIndex.get(rrKey) ?? 0;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[idx % keys.length];
    idx++;

    const skipId = `${model.platform}:${model.model_id}:${key.id}`;
    if (skipKeys?.has(skipId)) continue;

    if (isOnCooldown(model.platform, model.model_id, key.id)) continue;
    if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
    if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

    /* [2076-16] Skip if any rate limit is at 80%+ usage. This avoids wasting
     * a request on a model that's about to hit its limit. Only checked after
     * the hard limits pass — this is a soft preference, not a block. */
    if (isNearLimit(model.platform, model.model_id, key.id, limits)) continue;

    roundRobinIndex.set(rrKey, idx);
    const decryptedKey = resolveStoredCredential(key);

    return {
      provider,
      modelId: model.model_id,
      modelDbId: model.id,
      apiKey: decryptedKey,
      keyId: key.id,
      platform: model.platform,
      displayName: model.display_name,
      coldStartRetryMs: model.cold_start_retry_ms,
    };
  }

  roundRobinIndex.set(rrKey, idx);
  return undefined;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * If restrictedFallbackChain is provided, it is used INSTEAD of the global
 * fallback_config. This allows model-specific fallback chains (e.g. try
 * free model first, then paid model, without falling through to all other
 * models in the catalog).
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 * @param restrictedFallbackChain - ordered list of model DB IDs; used instead
 *   of global fallback_config when the preferred model (if any) fails
 */
export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  restrictedFallbackChain?: number[],
): RouteResult {
  const db = getDb();

  if (preferredModelDbId) {
    const preferredModel = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(preferredModelDbId) as ModelRow | undefined;
    /* [255A-1] Explicitly requested models may be intentionally excluded from
     * the automatic fallback chain. Try the preferred model directly first so
     * explicit-only catalog rows still work without contaminating `auto`. */
    if (preferredModel) {
      const preferredRoute = tryRouteSpecificModel(preferredModel, estimatedTokens, skipKeys);
      if (preferredRoute) return preferredRoute;
    }
  }

  // If a restricted fallback chain is provided (model-specific override),
  // use it instead of the global fallback_config. This allows routing
  // to a specific set of models without falling through to everything
  // else in the catalog.
  if (restrictedFallbackChain && restrictedFallbackChain.length > 0) {
    const seen = new Set<number>();
    for (const modelDbId of restrictedFallbackChain) {
      if (seen.has(modelDbId)) continue;
      seen.add(modelDbId);

      // Apply dynamic penalty to the restricted chain too
      const effectivePriority = getPenalty(modelDbId);

      const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(modelDbId) as ModelRow | undefined;
      if (!model) continue;

      // Penalized models sink to the end within the restricted chain
      if (effectivePriority > 0) {
        // Skip this model if penalized — try the rest first
        continue;
      }

      const route = tryRouteSpecificModel(model, estimatedTokens, skipKeys);
      if (route) return route;
    }

    // Second pass: try penalized models (all have exhausted non-penalized)
    for (const modelDbId of restrictedFallbackChain) {
      const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(modelDbId) as ModelRow | undefined;
      if (!model) continue;
      const route = tryRouteSpecificModel(model, estimatedTokens, skipKeys);
      if (route) return route;
    }

    const err = new Error('All models in the restricted fallback chain exhausted.') as RoutingError;
    err.status = 429;
    throw err;
  }

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;
    const route = tryRouteSpecificModel(model, estimatedTokens, skipKeys);
    if (route) return route;
  }

  /* [2076-17] Health-aware second pass: if all models were skipped due to
   * near-limit or cooldown, retry without the near-limit filter. This ensures
   * we still serve requests when all providers are busy — we just prefer
   * less-loaded ones first. Arena ELO is used as tiebreaker via intelligence_rank
   * (already embedded in fallback_config priority). */
  for (const entry of sortedChain) {
    if (!entry.enabled) continue;
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;
    const route = tryRouteSpecificModelRelaxed(model, estimatedTokens, skipKeys);
    if (route) return route;
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as RoutingError;
  err.status = 429;
  throw err;
}

/* [2076-17] Relaxed routing: same as tryRouteSpecificModel but skips the
 * near-limit check. Used as a second pass when all models are at 80%+ —
 * better to serve with a busy model than return 429. */
function tryRouteSpecificModelRelaxed(
  model: ModelRow,
  estimatedTokens: number,
  skipKeys?: Set<string>,
): RouteResult | undefined {
  if (isProviderOnCooldown(model.platform)) return undefined;

  const provider = getProvider(model.platform);
  if (!provider) return undefined;

  const db = getDb();
  const keys = db.prepare(
    'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
  ).all(model.platform, 'invalid') as KeyRow[];

  if (keys.length === 0) return undefined;

  const limits = {
    rpm: model.rpm_limit,
    rpd: model.rpd_limit,
    tpm: model.tpm_limit,
    tpd: model.tpd_limit,
  };

  const rrKey = `${model.platform}:${model.model_id}:relaxed`;
  let idx = roundRobinIndex.get(rrKey) ?? 0;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[idx % keys.length];
    idx++;

    const skipId = `${model.platform}:${model.model_id}:${key.id}`;
    if (skipKeys?.has(skipId)) continue;

    if (isOnCooldown(model.platform, model.model_id, key.id)) continue;
    if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
    if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

    roundRobinIndex.set(rrKey, idx);
    const decryptedKey = resolveStoredCredential(key);

    return {
      provider,
      modelId: model.model_id,
      modelDbId: model.id,
      apiKey: decryptedKey,
      keyId: key.id,
      platform: model.platform,
      displayName: model.display_name,
      coldStartRetryMs: model.cold_start_retry_ms,
    };
  }

  roundRobinIndex.set(rrKey, idx);
  return undefined;
}
