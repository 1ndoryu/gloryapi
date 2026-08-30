import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getUnifiedApiKey, initDb } from '../../db/index.js';
import { getAdminAuthToken } from '../../lib/admin-auth.js';
import type { AddressInfo } from 'node:net';

type FallbackEntry = {
  modelDbId: number;
  priority: number;
  enabled: boolean;
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  arenaElo: number | null;
  artificialAnalysisCodingIndex: number | null;
};

async function request<T = { schemaVersion: string; revision: number; entries: FallbackEntry[] }>(app: Express, method: string, path: string, body?: unknown, authorization?: string) {
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address');
  const addr = address as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${authorization === undefined ? getAdminAuthToken() : authorization}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: unknown = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as T };
}

describe('Fallback API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('GET /api/fallback returns fallback chain', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(body.schemaVersion).toBe('glory-routing-v1');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    // La lista de modelos de visión del bridge se expone por separado de la
    // cadena de enrutamiento; no es un modelo de respuesta de Auto.
    expect(Array.isArray(body.visionModels)).toBe(true);
    expect(body.visionModels.length).toBeGreaterThan(0);
    expect(body.visionModels[0]).toHaveProperty('routeId');
    expect(body.visionModels[0]).toHaveProperty('authPlatform');
    expect(body.visionModels[0]).toHaveProperty('enabled');
    // Should be sorted by priority
    for (let i = 1; i < body.entries.length; i++) {
      expect(body.entries[i].priority).toBeGreaterThanOrEqual(body.entries[i - 1].priority);
    }
  });

  it('GET /api/fallback entries have expected fields', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const first = body.entries[0];
    expect(first).toHaveProperty('modelDbId');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('enabled');
    expect(first).toHaveProperty('platform');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('intelligenceRank');
  });

  it('keeps MiMo enabled ahead of DeepSeek V4 Flash in the default Zen fallback order', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const mimo = body.entries.find(entry => entry.platform === 'opencode-zen' && entry.modelId === 'mimo-v2.5-free');
    const deepseek = body.entries.find(entry => entry.platform === 'opencode-zen' && entry.modelId === 'deepseek-v4-flash-free');

    expect(mimo).toBeTruthy();
    expect(deepseek).toBeTruthy();
    expect(mimo.enabled).toBe(true);
    expect(deepseek.enabled).toBe(true);
    expect(mimo.priority).toBeLessThan(deepseek.priority);
  });

  it('keeps MiniMax M3 enabled ahead of MiniMax M2.5 in the default Zen fallback order', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const m3 = body.entries.find(entry => entry.platform === 'opencode-zen' && entry.modelId === 'minimax-m3-free');
    const m25 = body.entries.find(entry => entry.platform === 'opencode-zen' && entry.modelId === 'minimax-m2.5-free');

    expect(m3).toBeTruthy();
    expect(m25).toBeTruthy();
    expect(m3.enabled).toBe(true);
    expect(m25.enabled).toBe(true);
    expect(m3.priority).toBeLessThan(m25.priority);
  });

  it('PUT /api/fallback updates order', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');

    // Reverse the order
    const reversed = original.entries.map((e, i: number) => ({
      modelDbId: e.modelDbId,
      priority: original.entries.length - i,
      enabled: e.enabled,
    }));

    const { status } = await request(app, 'PUT', '/api/fallback', { expectedRevision: original.revision, entries: reversed }, getUnifiedApiKey());
    expect(status).toBe(200);

    // Verify order changed
    const { body: after } = await request(app, 'GET', '/api/fallback');
    expect(after.entries[0].modelDbId).toBe(original.entries[original.entries.length - 1].modelDbId);

    // Restore original order
    const restore = original.entries.map((e, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await request(app, 'PUT', '/api/fallback', { expectedRevision: after.revision, entries: restore }, getUnifiedApiKey());
  });

  it('rejects unauthenticated, stale, duplicate, and incomplete routing writes', async () => {
    const { body: snapshot } = await request(app, 'GET', '/api/fallback');
    const payload = snapshot.entries.map(entry => ({ modelDbId: entry.modelDbId, priority: entry.priority, enabled: entry.enabled }));

    const unauthorized = await request(app, 'PUT', '/api/fallback', { expectedRevision: snapshot.revision, entries: payload }, '');
    expect(unauthorized.status).toBe(401);

    const duplicate = [...payload.slice(0, -1), { ...payload[0], priority: payload.length }];
    const duplicateResponse = await request(app, 'PUT', '/api/fallback', { expectedRevision: snapshot.revision, entries: duplicate }, getUnifiedApiKey());
    expect(duplicateResponse.status).toBe(400);

    const stale = await request(app, 'PUT', '/api/fallback', { expectedRevision: Math.max(0, snapshot.revision - 1), entries: payload }, getUnifiedApiKey());
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'routing_revision_conflict' }, currentRevision: snapshot.revision });

    const incomplete = await request(app, 'PUT', '/api/fallback', { expectedRevision: snapshot.revision, entries: payload.slice(0, -1) }, getUnifiedApiKey());
    expect(incomplete.status).toBe(400);
  });

  it('streams sanitized routing changes and closes unauthorized subscriptions', async () => {
    const unauthorized = await request(app, 'GET', '/api/fallback/events', undefined, '');
    expect(unauthorized.status).toBe(401);

    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose an address');
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/fallback/events`, {
      headers: { Authorization: `Bearer ${getUnifiedApiKey()}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (!response.body) throw new Error('SSE response did not expose a body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready = await reader.read();
    expect(decoder.decode(ready.value)).toContain('event: routing.ready');

    const { body: snapshot } = await request(app, 'GET', '/api/fallback');
    const reversed = snapshot.entries.map((entry, index) => ({
      modelDbId: entry.modelDbId,
      priority: snapshot.entries.length - index,
      enabled: entry.enabled,
    }));
    const updated = await request(app, 'PUT', '/api/fallback', {
      expectedRevision: snapshot.revision,
      entries: reversed,
    }, getUnifiedApiKey());
    expect(updated.status).toBe(200);

    let eventText = '';
    for (let attempt = 0; attempt < 3 && !eventText.includes('event: routing.changed'); attempt++) {
      const chunk = await reader.read();
      eventText += decoder.decode(chunk.value);
      if (chunk.done) break;
    }
    expect(eventText).toContain('event: routing.changed');
    await reader.cancel();
    server.close();
  });

  it('allows only one of two concurrent writes with the same revision', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');
    const originalEntries = original.entries.map(entry => ({
      modelDbId: entry.modelDbId,
      priority: entry.priority,
      enabled: entry.enabled,
    }));
    const reversedEntries = [...originalEntries].reverse().map((entry, index) => ({
      ...entry,
      priority: index + 1,
    }));

    const [first, second] = await Promise.all([
      request(app, 'PUT', '/api/fallback', {
        expectedRevision: original.revision,
        entries: reversedEntries,
      }, getUnifiedApiKey()),
      request(app, 'PUT', '/api/fallback', {
        expectedRevision: original.revision,
        entries: originalEntries,
      }, getUnifiedApiKey()),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const { body: current } = await request(app, 'GET', '/api/fallback');
    const restore = originalEntries.map((entry, index) => ({ ...entry, priority: index + 1 }));
    const restored = await request(app, 'PUT', '/api/fallback', {
      expectedRevision: current.revision,
      entries: restore,
    }, getUnifiedApiKey());
    expect(restored.status).toBe(200);
  });

  it('exposes sanitized routing traces only to authenticated clients', async () => {
    const unauthorized = await request(app, 'GET', '/api/fallback/traces', undefined, '');
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app, 'GET', '/api/fallback/traces', undefined, getUnifiedApiKey());
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({ schemaVersion: 'glory-routing-trace-v1' });
    expect(Array.isArray((authorized.body as { traces: unknown[] }).traces)).toBe(true);
    expect(JSON.stringify(authorized.body)).not.toContain('apiKey');
    expect(JSON.stringify(authorized.body)).not.toContain('secret');
  });

  it('does not expose removed sort presets or monthly budget endpoints', async () => {
    const sortResponse = await request(app, 'POST', '/api/fallback/sort/speed');
    const budgetResponse = await request(app, 'GET', '/api/fallback/token-usage');
    expect(sortResponse.status).toBe(404);
    expect(budgetResponse.status).toBe(404);
  });
});
