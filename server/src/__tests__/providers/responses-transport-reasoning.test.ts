import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { translateChatRequestToResponses, DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS } from '../../providers/responses/translate-request.js';
import { extractReasoningItems } from '../../providers/responses/translate-response.js';
import { translateResponsesStream } from '../../providers/responses/translate-stream.js';
import { ResponsesReasoningCache, clearResponsesReasoningCache } from '../../providers/responses/reasoning-cache.js';

function sseBody(frames: Array<[string, Record<string, unknown>] | string>): Response {
  const payload = frames
    .map(frame => {
      if (typeof frame === 'string') return `data: ${frame}\n\n`;
      const [event, data] = frame;
      return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    })
    .join('');
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }));
}

describe('OpenAICompatProvider responses transport', () => {
  const provider = new OpenAICompatProvider({
    platform: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    endpointKinds: { muse: 'responses' },
  });

  it('hits /responses and returns the translated chat response', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'resp_1', created_at: 1700000000, model: 'muse-spark-1.3-contributor', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hola' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });

    const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hola' }], 'muse-spark-1.3-contributor', { requestId: 'req_1' });
    expect(capturedUrl).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(capturedBody.model).toBe('muse-spark-1.3-contributor');
    expect(result.choices[0].message.content).toBe('hola');
    expect(result._routed_via).toMatchObject({ platform: 'opencode-go', model: 'muse-spark-1.3-contributor' });
    vi.restoreAllMocks();
  });

  it('streams /responses SSE as chat chunks', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      void url; void init;
      return sseBody([
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'hola' }],
        ['response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: {} } }],
      ]);
    });
    const chunks = [];
    const provider2 = new OpenAICompatProvider({
      platform: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      endpointKinds: { muse: 'responses' },
    });
    for await (const chunk of provider2.streamChatCompletion('key', [{ role: 'user', content: 'hola' }], 'muse-spark-1.3-contributor')) {
      chunks.push(chunk);
    }
    expect(chunks.some(c => c.choices[0].delta.content === 'hola')).toBe(true);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
    vi.restoreAllMocks();
  });
});

describe('responses stateless reasoning (039A-1)', () => {
  beforeEach(() => {
    clearResponsesReasoningCache();
    vi.restoreAllMocks();
  });

  it('always requests encrypted reasoning state and a default output budget', () => {
    const body = translateChatRequestToResponses({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hola' }],
      options: {},
    });
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.max_output_tokens).toBe(DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS);
  });

  it('keeps an explicit max_tokens instead of the default', () => {
    const body = translateChatRequestToResponses({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hola' }],
      options: { max_tokens: 2048 },
    });
    expect(body.max_output_tokens).toBe(2048);
  });

  it('clamps tiny max_tokens to the gateway floor (039A-1e)', () => {
    // The bridge completion audit sends max_tokens: 8; Go rejects
    // max_output_tokens < 16, which 400'd every audit against Muse.
    const body = translateChatRequestToResponses({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hola' }],
      options: { max_tokens: 8 },
    });
    expect(body.max_output_tokens).toBe(16);
  });

  it('replays previous reasoning first and omits state on fallback', () => {
    const withReplay = translateChatRequestToResponses({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'sigue' }],
      options: {},
      previousReasoning: [
        { id: 'rs_1', encrypted_content: 'blob-1' },
        { id: '', encrypted_content: 'sin-id' },
      ],
    });
    const input = withReplay.input as Array<Record<string, unknown>>;
    // The Go gateway requires `summary` back on replayed reasoning items
    // (`input[0]` missing required field `summary` otherwise).
    expect(input[0]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'blob-1', summary: [] });
    expect(input.some(item => (item as Record<string, unknown>).encrypted_content === 'sin-id')).toBe(false);

    const fallback = translateChatRequestToResponses({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'sigue' }],
      options: {},
      previousReasoning: [{ id: 'rs_1', encrypted_content: 'blob-1' }],
      omitState: true,
    });
    expect(fallback).not.toHaveProperty('store');
    expect(fallback).not.toHaveProperty('include');
    expect((fallback.input as Array<Record<string, unknown>>).some(item => item.type === 'reasoning')).toBe(false);
  });

  it('extracts opaque reasoning items bounded and fail-open', () => {
    expect(extractReasoningItems(null)).toEqual([]);
    const items = extractReasoningItems({
      output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'a'.repeat(10), summary: [] },
        { type: 'reasoning', id: '', encrypted_content: 'sin-id' },
        { type: 'reasoning', id: 'rs_2' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hola' }] },
      ],
    });
    expect(items).toEqual([{ id: 'rs_1', encrypted_content: 'a'.repeat(10), summary: [] }]);
  });

  it('matches a continued conversation by history prefix, not by exact equality', () => {
    const cache = new ResponsesReasoningCache();
    const first = [
      { role: 'user' as const, content: 'arregla el boton volver' },
    ];
    expect(cache.store(first, 'muse-spark-1.3-contributor', [{ id: 'rs_1', encrypted_content: 'blob' }])).toBe(true);
    const continued = [
      { role: 'user' as const, content: 'arregla el boton volver' },
      { role: 'assistant' as const, content: 'voy a revisar', tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'call_1', content: 'ok' },
      { role: 'user' as const, content: 'continua' },
    ];
    expect(cache.lookup(continued, 'muse-spark-1.3-contributor')).toEqual([{ id: 'rs_1', encrypted_content: 'blob', summary: [] }]);
    expect(cache.lookup([{ role: 'user' as const, content: 'otro tema distinto' }], 'muse-spark-1.3-contributor')).toBeUndefined();
  });

  it('expires entries and evicts the oldest under pressure', () => {
    const cache = new ResponsesReasoningCache();
    const base = Date.now();
    cache.store([{ role: 'user' as const, content: 'a' }], 'm', [{ id: 'r1', encrypted_content: 'x' }], base);
    expect(cache.lookup([{ role: 'user' as const, content: 'a' }], 'm', base + 31 * 60 * 1000)).toBeUndefined();
    for (let i = 0; i < 105; i += 1) {
      cache.store([{ role: 'user' as const, content: `tema-${i}` }], 'm', [{ id: `r${i}`, encrypted_content: 'x' }], base + i);
    }
    expect(cache.size).toBeLessThanOrEqual(100);
  });

  it('collects reasoning blobs from stream events without changing chat chunks', async () => {
    const collector: { reasoningItems?: Array<{ id: string; encrypted_content: string }> } = {};
    const response = sseBody([
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_9', type: 'reasoning' } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'm', output_index: 1, content_index: 0, delta: 'hola' }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_9', type: 'reasoning', encrypted_content: 'blob-9' } }],
      ['response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ id: 'rs_9', type: 'reasoning', encrypted_content: 'blob-9' }], usage: {} } }],
    ]);
    const chunks = [];
    for await (const chunk of translateResponsesStream({
      response,
      providerName: 'OpenCode Go',
      upstreamModel: 'muse-spark-1.3-contributor',
      collector,
    })) {
      chunks.push(chunk);
    }
    expect(collector.reasoningItems).toEqual([{ id: 'rs_9', encrypted_content: 'blob-9', summary: [] }]);
    expect(chunks.some(c => (c.choices[0].delta as Record<string, unknown>).content === 'hola')).toBe(true);
  });

  it('retries once without state on 400 unknown parameter and replays on the next turn', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      bodies.push(JSON.parse(String((init as RequestInit)?.body)));
      if (calls === 1) {
        const errBody = { error: { message: 'unknown parameter: store' } };
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          clone: () => ({ json: () => Promise.resolve(errBody) }),
          json: () => Promise.resolve(errBody),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'resp_fallback', created_at: 1, model: 'muse-spark-1.3-contributor', status: 'completed',
          output: [
            { type: 'reasoning', id: 'rs_n', encrypted_content: 'blob-n' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });
    const provider = new OpenAICompatProvider({
      platform: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      endpointKinds: { muse: 'responses' },
    });
    const messages = [{ role: 'user' as const, content: 'hola fallback' }];
    const result = await provider.chatCompletion('key', messages, 'muse-spark-1.3-contributor', {});
    expect(result.choices[0].message.content).toBe('ok');
    expect(calls).toBe(2);
    expect(bodies[0]).toHaveProperty('store', false);
    expect(bodies[1]).not.toHaveProperty('store');

    // The reasoning captured above is replayed on the continued turn.
    bodies.length = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit)?.body)));
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'resp_next', created_at: 1, model: 'muse-spark-1.3-contributor', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sigo' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });
    const continued = [
      { role: 'user' as const, content: 'hola fallback' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'continua' },
    ];
    await provider.chatCompletion('key', continued, 'muse-spark-1.3-contributor', {});
    const replayed = (bodies[0].input as Array<Record<string, unknown>>)[0];
    expect(replayed).toMatchObject({ type: 'reasoning', id: 'rs_n', encrypted_content: 'blob-n', summary: [] });
  });

  it('drops a rejected replay and succeeds without it (fail-open)', async () => {
    // Regression 039A-1b: the Go gateway answers
    // `[invalid_request_error] input[0] missing required field summary`
    // when the replayed shape is wrong. The request must then succeed
    // without replay instead of surfacing a 400 to VS Code.
    const { storeResponsesReasoning } = await import('../../providers/responses/reasoning-cache.js');
    const history = [{ role: 'user' as const, content: 'tema fail-open' }];
    storeResponsesReasoning(history, 'muse-spark-1.3-contributor', [{ id: 'rs_x', encrypted_content: 'blob-x', summary: [] }]);

    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit)?.body)));
      if (bodies.length === 1) {
        const errBody = { error: { message: '[invalid_request_error] `input[0]` missing required field `summary`' } };
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          clone: () => ({ json: () => Promise.resolve(errBody) }),
          json: () => Promise.resolve(errBody),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'resp_ok', created_at: 1, model: 'muse-spark-1.3-contributor', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recuperado' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });
    const provider = new OpenAICompatProvider({
      platform: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      endpointKinds: { muse: 'responses' },
    });
    const result = await provider.chatCompletion('key', [...history, { role: 'user' as const, content: 'sigue' }], 'muse-spark-1.3-contributor', {});
    expect(result.choices[0].message.content).toBe('recuperado');
    expect(bodies).toHaveLength(2);
    expect((bodies[1].input as Array<Record<string, unknown>>).some(item => item.type === 'reasoning')).toBe(false);
  });
});
