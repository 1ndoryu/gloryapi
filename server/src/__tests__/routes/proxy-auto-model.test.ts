import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { getAdminAuthToken } from '../../lib/admin-auth.js';
import type { AddressInfo } from 'node:net';

type AutoModel = { id: string; object: string; owned_by: string };
type AutoResponse = {
  data: AutoModel[];
  models: AutoModel[];
  choices: Array<{ message: { content: string } }>;
  error: { code: string; type: string; message: string };
};

async function request<T = AutoResponse>(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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

describe('Virtual "auto" model', () => {
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

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_auto_model_test',
      label: 'auto-model',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists "auto" as the first /v1/models entry', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data[0]).toMatchObject({
      id: 'auto',
      object: 'model',
      owned_by: 'gloryapi',
    });
    expect(body.models).toEqual(body.data);
    // Real catalog models still follow.
    expect(body.data.length).toBeGreaterThan(1);
  });

  it('treats model:"auto" as auto-route instead of a 400', async () => {
    const origFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'routed via auto' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        } as unknown as Response;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('routed via auto');
  });

  it('uses the manual fallback order for model:"auto" and falls through on retryable errors', async () => {
    const addZenKey = await request(app, 'POST', '/api/keys', {
      platform: 'opencode-zen',
      key: 'zen_auto_model_test',
      label: 'auto-model-zen',
    });
    expect(addZenKey.status).toBe(201);

    const db = getDb();
    const zenModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'opencode-zen'
         AND model_id = 'mimo-v2.5-free'
    `).get() as { id: number; model_id: string };
    const groqModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'groq'
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
       LIMIT 1
    `).get() as { id: number; model_id: string };

    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(1, zenModel.id);
    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(2, groqModel.id);

    const origFetch = global.fetch;
    const upstreamCalls: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('opencode.ai/zen/v1/chat/completions')) {
        upstreamCalls.push('opencode-zen');
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: () => Promise.resolve({ error: { message: 'rate limit' } }),
        } as unknown as Response;
      }

      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamCalls.push('groq');
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto-fallback',
            object: 'chat.completion',
            created: 123,
            model: groqModel.model_id,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'manual order respected' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
          }),
        } as unknown as Response;
      }

      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('manual order respected');
    expect(upstreamCalls).toEqual(['opencode-zen', 'groq']);
    expect(headers.get('x-routed-via')).toContain(`groq/${groqModel.model_id}`);
    expect(headers.get('x-fallback-attempts')).toBe('1');
  });

  it('falls through when the first model returns 402 Payment Required', async () => {
    const addHuggingFaceKey = await request(app, 'POST', '/api/keys', {
      platform: 'huggingface',
      key: 'hf_auto_model_test',
      label: 'auto-model-hf',
    });
    expect(addHuggingFaceKey.status).toBe(201);

    const db = getDb();
    const huggingFaceModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'huggingface'
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
       LIMIT 1
    `).get() as { id: number; model_id: string };
    const groqModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'groq'
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
       LIMIT 1
    `).get() as { id: number; model_id: string };

    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(1, huggingFaceModel.id);
    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(2, groqModel.id);

    const origFetch = global.fetch;
    const upstreamCalls: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('router.huggingface.co/v1/chat/completions')) {
        upstreamCalls.push('huggingface');
        return {
          ok: false,
          status: 402,
          statusText: 'Payment Required',
          json: () => Promise.resolve({ error: { message: 'Payment Required' } }),
        } as unknown as Response;
      }

      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamCalls.push('groq');
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto-fallback-402',
            object: 'chat.completion',
            created: 123,
            model: groqModel.model_id,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'fell through after 402' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 },
          }),
        } as unknown as Response;
      }

      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('fell through after 402');
    expect(upstreamCalls).toEqual(['huggingface', 'groq']);
    expect(headers.get('x-routed-via')).toContain(`groq/${groqModel.model_id}`);
    expect(headers.get('x-fallback-attempts')).toBe('1');
  });

  it('falls through when the first model returns 403 Forbidden', async () => {
    const addOllamaKey = await request(app, 'POST', '/api/keys', {
      platform: 'ollama',
      key: 'ollama_auto_model_test',
      label: 'auto-model-ollama',
    });
    expect(addOllamaKey.status).toBe(201);

    const db = getDb();
    const ollamaModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'ollama'
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
       LIMIT 1
    `).get() as { id: number; model_id: string };
    const groqModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'groq'
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
       LIMIT 1
    `).get() as { id: number; model_id: string };

    db.prepare('UPDATE fallback_config SET priority = ?, enabled = 1 WHERE model_db_id = ?').run(1, ollamaModel.id);
    db.prepare('UPDATE fallback_config SET priority = ?, enabled = 1 WHERE model_db_id = ?').run(2, groqModel.id);

    const origFetch = global.fetch;
    const upstreamCalls: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('ollama.com/v1/chat/completions')) {
        upstreamCalls.push('ollama');
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({ error: { message: 'Forbidden' } }),
        } as unknown as Response;
      }

      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamCalls.push('groq');
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto-fallback-403',
            object: 'chat.completion',
            created: 123,
            model: groqModel.model_id,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'fell through after 403' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 },
          }),
        } as unknown as Response;
      }

      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('fell through after 403');
    expect(upstreamCalls).toEqual(['ollama', 'groq']);
    expect(headers.get('x-routed-via')).toContain(`groq/${groqModel.model_id}`);
    expect(headers.get('x-fallback-attempts')).toBe('1');
  });

  it('falls through provider-specific tool schema 400s without putting the first model on cooldown', async () => {
    const addGoogleKey = await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_auto_model_test',
      label: 'auto-model-google',
    });
    expect(addGoogleKey.status).toBe(201);

    const db = getDb();
    const googleModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'google'
         AND model_id = 'gemini-3.5-flash'
    `).get() as { id: number; model_id: string };
    const groqModel = db.prepare(`
      SELECT id, model_id
        FROM models
       WHERE platform = 'groq'
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
       LIMIT 1
    `).get() as { id: number; model_id: string };

    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(1, googleModel.id);
    db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(2, groqModel.id);

    const origFetch = global.fetch;
    const upstreamCalls: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        upstreamCalls.push('google');
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: () => Promise.resolve({
            error: {
              message: 'Invalid JSON payload received. Unknown name "futureField" at \'tools[0].function_declarations[0].parameters.properties[0].value\': Cannot find field.',
            },
          }),
        } as unknown as Response;
      }

      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamCalls.push('groq');
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto-fallback-schema',
            object: 'chat.completion',
            created: 123,
            model: groqModel.model_id,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'fell through after schema mismatch' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 },
          }),
        } as unknown as Response;
      }

      return origFetch(url, init);
    });

    const requestBody = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'set_unit',
          parameters: {
            type: 'object',
            properties: {
              unit: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
              },
            },
            required: ['unit'],
          },
        },
      }],
    };

    const first = await request(app, 'POST', '/v1/chat/completions', requestBody, authHeaders());
    expect(first.status).toBe(200);
    expect(first.body.choices[0].message.content).toBe('fell through after schema mismatch');
    expect(first.headers.get('x-routed-via')).toContain(`groq/${groqModel.model_id}`);
    expect(first.headers.get('x-fallback-attempts')).toBe('1');

    const second = await request(app, 'POST', '/v1/chat/completions', requestBody, authHeaders());
    expect(second.status).toBe(200);
    expect(second.body.choices[0].message.content).toBe('fell through after schema mismatch');
    expect(second.headers.get('x-routed-via')).toContain(`groq/${groqModel.model_id}`);
    expect(second.headers.get('x-fallback-attempts')).toBe('1');

    expect(upstreamCalls).toEqual(['google', 'groq', 'google', 'groq']);
  });

  it('still rejects an unknown model with model_not_found', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
  });
});
