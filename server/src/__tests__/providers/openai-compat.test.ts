import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider, replaceNullAssistantContent } from '../../providers/openai-compat.js';

type OpenAIRequestBody = {
  messages: Array<{ role: string; [key: string]: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
};

function parseBody<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T;
}

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
      extraHeaders: { 'X-Custom': 'test' },
    });
  });

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('groq');
    expect(provider.name).toBe('TestProvider');
  });

  it('should call API with correct URL and headers', async () => {
    let capturedUrl = '';
    let capturedHeaders = new Headers();
    let capturedBody: OpenAIRequestBody;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = parseBody<OpenAIRequestBody>(init);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'test-model');

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions');
    expect(capturedHeaders.get('Authorization')).toBe('Bearer my-key');
    expect(capturedHeaders.get('X-Custom')).toBe('test');
    expect(capturedBody.messages[0].role).toBe('user');
  });

  it('should pass tool-calling params through untouched', async () => {
    let capturedBody: OpenAIRequestBody;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = parseBody<OpenAIRequestBody>(init);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });

    await provider.chatCompletion(
      'my-key',
      [{ role: 'user', content: 'what is weather?' }],
      'test-model',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
        parallel_tool_calls: true,
        reasoning_effort: 'high',
      },
    );

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(capturedBody.parallel_tool_calls).toBe(true);
    expect(capturedBody.reasoning_effort).toBe('high');
  });

  it('should pass reasoning_effort through in streaming requests', async () => {
    let capturedBody: OpenAIRequestBody;
    const encoder = new TextEncoder();

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = parseBody<OpenAIRequestBody>(init);
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"id":"chunk-1","object":"chat.completion.chunk","created":123,"model":"test-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });

    const chunks: string[] = [];
    for await (const chunk of provider.streamChatCompletion(
      'my-key',
      [{ role: 'user', content: 'test' }],
      'test-model',
      { reasoning_effort: 'high' },
    )) {
      chunks.push(chunk.choices[0]?.delta?.content ?? '');
    }

    expect(capturedBody.reasoning_effort).toBe('high');
    expect(chunks).toEqual(['hi']);
  });

  it('should throw on error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Rate Limited',
      json: () => Promise.resolve({ error: { message: 'Too many requests' } }),
    } as unknown as Response);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Too many requests/);
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('replaceNullAssistantContent preserves reasoning fields while collapsing assistant null content', () => {
    const normalized = replaceNullAssistantContent([
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'thinking trace',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'user', content: 'hi' },
    ]);

    expect(normalized[0].content).toBe('');
    expect(normalized[0].reasoning_content).toBe('thinking trace');
    expect(normalized[0].tool_calls?.[0].function.name).toBe('lookup');
    expect(normalized[1].content).toBe('hi');
  });

  it('validateKey returns false on confirmed 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as unknown as Response);
    expect(await provider.validateKey('bad')).toBe(false);
  });

  it('validateKey propagates transport errors instead of swallowing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(provider.validateKey('any')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('folds reasoning_content into content when content is empty (Z.ai glm-4.5-flash style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'the actual answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('the actual answer');
  });

  it('flattens array content into a string (Mistral magistral style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('part one part two');
  });

  it('folds reasoning into content when content is empty (Ollama style — bare `reasoning` field)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning: 'ollama answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('ollama answer');
  });

  it('prefers reasoning_content over reasoning when both are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'preferred', reasoning: 'fallback' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('preferred');
  });

  it('does NOT fold reasoning_content when tool_calls are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'I am thinking about the tool',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('leaves real string content untouched', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'normal answer', reasoning_content: 'should not override' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('normal answer');
  });
});

describe('OpenAICompatProvider - platform instances', () => {
  // Mirrors the actual registrations in server/src/providers/index.ts.
  // Update both when adding/removing a platform.
  const platforms = [
    { platform: 'groq',       name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1' },
    { platform: 'cerebras',   name: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1' },
    { platform: 'sambanova',  name: 'SambaNova',     baseUrl: 'https://api.sambanova.ai/v1' },
    { platform: 'nvidia',     name: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { platform: 'mistral',    name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1' },
    { platform: 'openrouter', name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1' },
    { platform: 'github',     name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
    { platform: 'zhipu',      name: 'Zhipu AI',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { platform: 'opencode-zen', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1' },
  ] as const;

  for (const p of platforms) {
    it(`${p.name} provider should make requests to ${p.baseUrl}`, async () => {
      const provider = new OpenAICompatProvider(p);

      let capturedUrl = '';
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        capturedUrl = url as string;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'id', object: 'chat.completion', created: 1, model: 'model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        } as unknown as Response;
      });

      const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
      expect(capturedUrl).toContain(p.baseUrl);
      expect(result._routed_via?.platform).toBe(p.platform);
    });
  }
});
