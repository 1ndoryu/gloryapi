import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { getAdminAuthToken } from '../../lib/admin-auth.js';
import type { AddressInfo } from 'node:net';

type KeyEntry = { id: number; platform: string; label: string; maskedKey: string };
type KeyResponse = KeyEntry[] & { id: number; platform: string; label: string; maskedKey: string };

async function request<T = KeyResponse>(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address');
  const addr = address as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getAdminAuthToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: unknown = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as T };
}

describe('Keys API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
    expect(body.status).toBe('unknown');
    expect(body.enabled).toBe(true);

    const row = getDb().prepare(
      'SELECT encrypted_key, iv, auth_tag, encryption_scheme, fingerprint FROM api_keys WHERE id = ?',
    ).get(body.id) as {
      encrypted_key: string;
      iv: string;
      auth_tag: string;
      encryption_scheme: string;
      fingerprint: string | null;
    };
    expect(row.encryption_scheme).toBe('dpapi-current-user');
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.iv).toBe('');
    expect(row.auth_tag).toBe('');
    expect(row.encrypted_key).not.toContain('gsk_test123456789');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys accepts a credential for an explicit provider draft', async () => {
    getDb().prepare(`
      INSERT INTO provider_registry (
        platform, display_name, lifecycle, adapter, endpoint, auth_scheme, capabilities_json,
        health_verified_at, chat_verified_at, capabilities_verified_at
      ) VALUES ('draft-provider', 'Draft provider', 'draft', 'openai-compatible',
        'https://provider.example/v1', 'bearer', ?, NULL, NULL, NULL)
    `).run(JSON.stringify({
      streaming: true,
      tools: false,
      reasoning: false,
      multimodal: false,
      maxContextWindow: 32768,
    }));

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'draft-provider',
      key: 'draft-secret-123',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('draft-provider');
    expect(body.status).toBe('unknown');
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });
});
