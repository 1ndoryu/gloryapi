import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getUnifiedApiKey, initDb } from '../../db/index.js';
import type { AddressInfo } from 'node:net';

type AuthResponse = { error: { type: string } };

async function request<T = AuthResponse>(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address');
  const addr = address as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: unknown = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json as T, headers: res.headers, raw: data };
}

describe('Proxy authentication and CORS', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('requires the unified API key for loopback chat completions', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('does not grant CORS access to arbitrary browser origins', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'https://attacker.example',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the local dashboard origin through CORS', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'http://localhost:5173',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('echoes a bounded bridge request id without accepting arbitrary header content', async () => {
    const { status, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      Authorization: `Bearer ${getUnifiedApiKey()}`,
      'X-Glory-Request-Id': 'req_bridge_01',
    });

    expect(status).not.toBe(401);
    expect(headers.get('x-glory-request-id')).toBe('req_bridge_01');
  });
});
