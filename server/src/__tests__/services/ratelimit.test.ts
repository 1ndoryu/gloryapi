import { describe, it, expect, beforeEach } from 'vitest';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
  setCooldown,
  getShortestCooldownRemainingMs,
  resetCooldownsForTest,
} from '../../services/ratelimit.js';

describe('Rate Limiter', () => {
  // Use unique identifiers per test to avoid cross-contamination
  let testId: number;

  beforeEach(() => {
    testId = Math.floor(Math.random() * 1_000_000);
    resetCooldownsForTest();
  });

  describe('canMakeRequest', () => {
    it('should allow request when under RPM limit', () => {
      expect(canMakeRequest('groq', 'llama-70b', testId, {
        rpm: 30, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    it('should deny request when RPM limit reached', () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      recordRequest('groq', 'llama-70b', testId);
      recordRequest('groq', 'llama-70b', testId);
      expect(canMakeRequest('groq', 'llama-70b', testId, limits)).toBe(false);
    });

    it('should deny request when RPD limit reached', () => {
      const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
      recordRequest('google', 'gemini', testId);
      expect(canMakeRequest('google', 'gemini', testId, limits)).toBe(false);
    });

    it('should allow request when limits are null (unlimited)', () => {
      expect(canMakeRequest('nvidia', 'nemotron', testId, {
        rpm: null, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('canUseTokens', () => {
    it('should allow tokens when under TPM limit', () => {
      expect(canUseTokens('groq', 'llama-70b', testId, 500, {
        tpm: 6000, tpd: null,
      })).toBe(true);
    });

    it('should deny tokens when TPM limit would be exceeded', () => {
      recordTokens('cerebras', 'qwen3', testId, 50000);
      expect(canUseTokens('cerebras', 'qwen3', testId, 20000, {
        tpm: 60000, tpd: null,
      })).toBe(false);
    });

    it('should allow when limit is null', () => {
      expect(canUseTokens('nvidia', 'nemotron', testId, 100000, {
        tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return current usage counts', () => {
      const limits = { rpm: 30, rpd: 1000, tpm: 6000, tpd: null };
      recordRequest('groq', 'test-model', testId);
      recordRequest('groq', 'test-model', testId);
      recordTokens('groq', 'test-model', testId, 500);

      const status = getRateLimitStatus('groq', 'test-model', testId, limits);
      expect(status.rpm.used).toBe(2);
      expect(status.rpm.limit).toBe(30);
      expect(status.rpd.used).toBe(2);
      expect(status.tpm.used).toBe(500);
    });
  });

  describe('getShortestCooldownRemainingMs', () => {
    it('should return 0 when no cooldowns are set', () => {
      expect(getShortestCooldownRemainingMs()).toBe(0);
    });

    it('should return the shortest remaining cooldown across platforms', () => {
      setCooldown('andoryyu', 'deepseek-v4-flash', testId, 300_000);
      setCooldown('opencode-go', 'deepseek-v4-flash', testId, 15_000);
      const shortest = getShortestCooldownRemainingMs();
      // 15s cooldown must be the shortest; allow small clock skew.
      expect(shortest).toBeGreaterThan(0);
      expect(shortest).toBeLessThanOrEqual(15_000);
    });

    it('should ignore already-expired cooldowns', async () => {
      setCooldown('opencode-go', 'deepseek-v4-flash', testId, 5);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(getShortestCooldownRemainingMs()).toBe(0);
    });

    it('should not block routes when cooldown is 0ms (e.g. opencode-go paid fallback)', () => {
      // opencode-go has cooldownMs: 0 in PROVIDER_FAILURE_POLICY: after a
      // transient failure it must be immediately eligible again so the same
      // request can retry it instead of failing with "All candidate models
      // are temporarily unavailable".
      setCooldown('opencode-go', 'deepseek-v4-flash', testId, 0);
      expect(getShortestCooldownRemainingMs()).toBe(0);
    });
  });
});
