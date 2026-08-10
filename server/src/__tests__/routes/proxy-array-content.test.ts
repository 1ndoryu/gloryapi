import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { getAdminAuthToken } from '../../lib/admin-auth.js';
import type { AddressInfo } from 'node:net';

type ArrayResponse = {
  choices: Array<{ message: { content: string | null } }>;
};
type ArrayProviderBody = {
  messages: Array<{ content: unknown }>;
  reasoning_effort?: string;
};

async function request<T = ArrayResponse>(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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

  return { status: res.status, body: json as T };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('OpenAI multimodal array content', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM provider_health').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_array_content_test',
      label: 'array-content',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts content as a string (the legacy shape)', async () => {
    // Provider call will fail (no real key), but schema validation must pass —
    // we assert it isn't rejected with a 400 zod error.
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());
    expect(status).not.toBe(400);
    if (status === 400) {
      // Diagnostic if regression: show the validation error.
      throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    }
  });

  it('accepts content as a text-only multimodal array', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello from opencode-style client' }],
      }],
    }, authHeaders());
    expect(status).not.toBe(400);
    if (status === 400) {
      throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    }
  });

  it('accepts mixed text + image_url blocks (image blocks are silently dropped)', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ],
      }],
    }, authHeaders());
    expect(status).not.toBe(400);
  });

  it('successfully routes an array-content request and gets a 200 (mocked groq)', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        // Sanity check that the array shape made it through to the upstream call.
        const body = JSON.parse(String((init as RequestInit).body));
        expect(Array.isArray(body.messages[0].content)).toBe(true);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-array', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'got it' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        } as unknown as Response;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('got it');
  });

  it('forwards reasoning_effort to the upstream provider', async () => {
    const origFetch = global.fetch;
    let capturedBody: ArrayProviderBody;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        capturedBody = JSON.parse(String((init as RequestInit).body)) as ArrayProviderBody;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-reasoning', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'thinking forwarded' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        } as unknown as Response;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('thinking forwarded');
    expect(capturedBody.reasoning_effort).toBe('high');
  });

  it('rejects an empty array as missing content', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [], // top-level empty messages
    }, authHeaders());
    expect(status).toBe(400);
  });

  it('rejects an assistant message with neither content nor tool_calls', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'assistant', content: [] }],
    }, authHeaders());
    expect(status).toBe(400);
  });
});
