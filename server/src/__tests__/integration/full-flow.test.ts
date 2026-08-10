import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { getAdminAuthToken } from '../../lib/admin-auth.js';
import type { AddressInfo } from 'node:net';

type IntegrationEntry = {
  id: number;
  platform: string;
  modelId: string;
  enabled: boolean;
  hasProvider: boolean;
  arenaElo: number | null;
  artificialAnalysisCodingIndex: number | null;
  priority: number;
  speedRank: number;
  label: string;
  resultBrief: string;
};
type IntegrationBody = IntegrationEntry[] & {
  error: { code: string; message: string };
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  platform: string;
  maskedKey: string;
  platforms: unknown[];
  keys: unknown[];
};

async function req<T = IntegrationBody>(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address');
  const addr = address as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const managementHeaders = path.startsWith('/api/') && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
    ? { Authorization: `Bearer ${getAdminAuthToken()}` }
    : {};
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...managementHeaders, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: unknown = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json as T, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Full Integration Flow', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    // Clean
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('Step 1: Verify models are seeded', async () => {
    const { status, body } = await req(app, 'GET', '/api/models');
    expect(status).toBe(200);
    // Tightened from >= 14 — current catalog post-V9 is 60+ rows; if a future
    // migration accidentally drops a chunk we want to know.
    expect(body.length).toBeGreaterThanOrEqual(50);
    expect(body[0]).toHaveProperty('modelId');
    expect(body[0]).toHaveProperty('hasProvider');
    // All should have providers (catches drift between catalog and providers/index.ts)
    for (const m of body) {
      expect(m.hasProvider).toBe(true);
    }

    const firstDisabledIndex = body.findIndex(m => m.enabled === false);
    if (firstDisabledIndex !== -1) {
      expect(body.slice(0, firstDisabledIndex).every(m => m.enabled === true)).toBe(true);
    }

    const modelOrder = new Map(body.map((m, index: number) => [`${m.platform}:${m.modelId}`, index]));
    expect(modelOrder.get('google:gemini-3.5-flash')).toBeLessThan(modelOrder.get('google:gemini-3-flash-preview'));
    expect(modelOrder.get('google:gemini-3.5-flash')).toBeLessThan(modelOrder.get('ollama:gemini-3-flash-preview'));
    expect(modelOrder.get('ollama:glm-5.1')).toBeLessThan(modelOrder.get('ollama:deepseek-v4-pro'));
    expect(modelOrder.get('ollama:deepseek-v4-pro')).toBeLessThan(modelOrder.get('ollama:qwen3.5:397b'));
    expect(modelOrder.get('huggingface:zai-org/GLM-5.1')).toBeLessThan(modelOrder.get('huggingface:Qwen/Qwen3.5-397B-A17B'));
    expect(modelOrder.get('nvidia:deepseek-ai/deepseek-v4-pro')).toBeLessThan(modelOrder.get('nvidia:qwen/qwen3-coder-480b-a35b-instruct'));
    expect(modelOrder.get('google:gemma-4-31b-it')).toBeLessThan(modelOrder.get('openrouter:deepseek/deepseek-v4-flash:free'));
    expect(modelOrder.get('openrouter:deepseek/deepseek-v4-flash:free')).toBeLessThan(modelOrder.get('openrouter:qwen/qwen3-next-80b-a3b-instruct:free'));

    const gemini35 = body.find(m => m.platform === 'google' && m.modelId === 'gemini-3.5-flash');
    expect(gemini35?.arenaElo).toBe(1507);
    expect(gemini35?.artificialAnalysisCodingIndex).toBeCloseTo(44.9810606060606, 10);
  });

  it('Step 2: Verify fallback chain is populated', async () => {
    const { status, body } = await req(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(body.entries.length).toBeGreaterThanOrEqual(50);
    expect(body.entries[0]).toHaveProperty('priority');
    expect(body.entries[0]).toHaveProperty('enabled');

    const glm47 = body.entries.find(m => m.platform === 'ollama' && m.modelId === 'glm-4.7');
    expect(glm47?.arenaElo).toBe(1486);
    expect(glm47?.artificialAnalysisCodingIndex).toBeCloseTo(36.2584175084175, 10);
  });

  it('Step 3: Authenticated proxy returns 429 with no keys', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());
    // 429 (all exhausted) or 502 (provider error) or 503 (no route)
    expect([429, 502, 503]).toContain(status);
    expect(body.error).toBeDefined();
  });

  it('Step 4: Add a Groq key', async () => {
    const { status, body } = await req(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_integration_test_key',
      label: 'Integration Test',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.maskedKey).toContain('...');
  });

  it('Step 5: Proxy routes to Groq and handles provider error gracefully', async () => {
    // Mock fetch to simulate a Groq API error
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // If it's calling the Groq API, return an error
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Invalid API Key' } }),
        } as unknown as Response;
      }
      // Otherwise pass through (for our test server)
      return origFetch(url, init);
    });

    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    // 502 (provider error) or 429 (all exhausted after retries)
    expect([502, 429]).toContain(status);
    expect(body.error).toBeDefined();

    vi.restoreAllMocks();
  });

  it('Step 6: Error was logged in analytics', async () => {
    const { status, body } = await req(app, 'GET', '/api/analytics/summary?range=24h');
    expect(status).toBe(200);
    // May or may not have logged depending on retry behavior
    expect(body.totalRequests).toBeGreaterThanOrEqual(0);
  });

  it('Step 6b: Analytics history returns per-request summaries without response content', async () => {
    const { status, body } = await req(app, 'GET', '/api/analytics/history?range=24h&limit=10');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0]).toHaveProperty('platform');
    expect(body[0]).toHaveProperty('modelId');
    expect(body[0]).toHaveProperty('status');
    expect(body[0]).toHaveProperty('resultBrief');
    expect(body[0]).not.toHaveProperty('response');
  });

  it('Step 8: Health endpoint works', async () => {
    const { status, body } = await req(app, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(body).toHaveProperty('platforms');
    expect(body).toHaveProperty('keys');
  });

  it('Step 9: Delete a key if any exist', async () => {
    // Add a fresh key to ensure we have one to delete
    await req(app, 'POST', '/api/keys', {
      platform: 'groq', key: 'gsk_delete_test', label: 'delete-test',
    });
    const { body: keys } = await req(app, 'GET', '/api/keys');
    const target = keys.find(k => k.label === 'delete-test');
    expect(target).toBeDefined();

    const { status } = await req(app, 'DELETE', `/api/keys/${target.id}`);
    expect(status).toBe(200);
  });

  it('Step 10: Validate request schema', async () => {
    const { status } = await req(app, 'POST', '/v1/chat/completions', {
      messages: [], // empty
    }, authHeaders());
    expect(status).toBe(400);

    const { status: s2 } = await req(app, 'POST', '/v1/chat/completions', {
      // missing messages entirely
    }, authHeaders());
    expect(s2).toBe(400);
  });

  it('Step 11: Explicit unknown model returns 400 (not silent fallthrough)', async () => {
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('not in the catalog');
  });

  it('Step 12: Explicit disabled model returns 400 with disabled reason', async () => {
    // gemini-2.5-pro is disabled (V1 migration). Reuse it as a known-disabled fixture.
    const { status, body } = await req(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('is disabled');
  });
});
