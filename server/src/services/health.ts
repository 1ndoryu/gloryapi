import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { resolveStoredCredential } from '../lib/dpapi-vault.js';
import type { Platform, KeyStatus } from '@gloryapi/shared/types.js';
import { getSettingNumber } from '../settings/registry.js';

const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Track consecutive failures per key
const failureCount = new Map<number, number>();

type ApiKeyHealthRow = {
  platform: Platform;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  encryption_scheme?: string;
  fingerprint?: string | null;
};

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as ApiKeyHealthRow | undefined;
  if (!row) return 'error';

  const provider = getProvider(row.platform);
  if (!provider) return 'error';

  try {
    const apiKey = resolveStoredCredential(row);
    const isValid = await provider.validateKey(apiKey);

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: unknown) {
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Health] Key ${keyId} transport error:`, message);
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', keyId);
    return 'error';
  }
}

export async function checkAllKeys(): Promise<void> {
  const db = getDb();
  const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

  console.log(`[Health] Checking ${keys.length} keys...`);

  for (const key of keys) {
    await checkKeyHealth(key.id);
  }

  console.log(`[Health] Check complete.`);
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(): void {
  if (intervalId) return;
  const intervalMs = getSettingNumber('health.checkIntervalMs');
  console.log(`[Health] Starting health checker (every ${intervalMs / 1000}s)`);
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err));
  }, intervalMs);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/* [2076-15] Provider-level health tracking.
 * Tracks per-platform failure counts and cooldowns. When a provider returns 429/5xx
 * across multiple keys, the whole provider gets a cooldown period. The router checks
 * this before routing to avoid wasting attempts on a known-down provider.
 *
 * Cooldown strategy: 3 consecutive failures → 60s cooldown. Recovery: 1 success → reset. */


export function recordProviderFailure(platform: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO provider_health (platform, consecutive_failures, last_failure_at)
    VALUES (?, 1, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET
      consecutive_failures = consecutive_failures + 1,
      last_failure_at = datetime('now')
  `).run(platform);

  const row = db.prepare('SELECT consecutive_failures FROM provider_health WHERE platform = ?').get(platform) as { consecutive_failures: number } | undefined;
  const failureThreshold = getSettingNumber('health.providerFailureThreshold');
  if (row && row.consecutive_failures >= failureThreshold) {
    const cooldownMs = getSettingNumber('health.providerCooldownMs');
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    db.prepare('UPDATE provider_health SET cooldown_until = ? WHERE platform = ?').run(cooldownUntil, platform);
    console.log(`[Health] Provider ${platform} on cooldown for ${cooldownMs / 1000}s after ${row.consecutive_failures} consecutive failures`);
  }
}

export function recordProviderSuccess(platform: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO provider_health (platform, consecutive_failures, cooldown_until, last_success_at)
    VALUES (?, 0, NULL, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET
      consecutive_failures = 0,
      cooldown_until = NULL,
      last_success_at = datetime('now')
  `).run(platform);
}

export function isProviderOnCooldown(platform: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT cooldown_until FROM provider_health WHERE platform = ?').get(platform) as { cooldown_until: string | null } | undefined;
  if (!row || !row.cooldown_until) return false;
  const cooldownEnd = new Date(row.cooldown_until).getTime();
  if (Date.now() >= cooldownEnd) {
    db.prepare('UPDATE provider_health SET cooldown_until = NULL WHERE platform = ?').run(platform);
    return false;
  }
  return true;
}

export function getProviderHealthStatus(): Array<{ platform: string; consecutiveFailures: number; onCooldown: boolean; cooldownUntil: string | null; lastSuccess: string | null }> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM provider_health').all() as Array<{ platform: string; consecutive_failures: number; cooldown_until: string | null; last_success_at: string | null }>;
  return rows.map(r => ({
    platform: r.platform,
    consecutiveFailures: r.consecutive_failures,
    onCooldown: r.cooldown_until ? new Date(r.cooldown_until).getTime() > Date.now() : false,
    cooldownUntil: r.cooldown_until,
    lastSuccess: r.last_success_at,
  }));
}
