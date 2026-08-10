import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

type CloudflareRequestBody = {
  model: string;
  messages: Array<{ content: string; tool_calls?: unknown[]; [key: string]: unknown }>;
};

function parseBody<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudflareProvider', () => {
  let provider: CloudflareProvider;

  beforeEach(() => {
    provider = new CloudflareProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('cloudflare');
    expect(provider.name).toBe('Cloudflare Workers AI');
  });

  it('should parse account_id:token key format', async () => {
    let capturedUrl = '';
    let capturedHeaders = new Headers();
    let capturedBody: CloudflareRequestBody;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = parseBody<CloudflareRequestBody>(init);
      return jsonResponse({
        id: 'chatcmpl-cf',
        object: 'chat.completion',
        created: 123,
        model: '@cf/meta/llama-3.1-70b-instruct',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from CF!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    });

    const result = await provider.chatCompletion(
      'abc123:my-token-here',
      [{ role: 'user', content: 'Hi' }],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedUrl).toContain('abc123');
    expect(capturedUrl).toContain('/ai/v1/chat/completions');
    expect(capturedHeaders.get('Authorization')).toBe('Bearer my-token-here');
    expect(capturedBody.model).toBe('@cf/meta/llama-3.1-70b-instruct');
    expect(result.choices[0].message.content).toBe('Hello from CF!');
  });

  it('should throw if key format is wrong', async () => {
    await expect(
      provider.chatCompletion('no-colon-here', [{ role: 'user', content: 'Hi' }], 'model')
    ).rejects.toThrow(/account_id:api_token/);
  });

  it('should convert null assistant content to empty string (CF rejects null)', async () => {
    let capturedBody: CloudflareRequestBody;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = parseBody<CloudflareRequestBody>(init);
      return jsonResponse({
        id: 'chatcmpl-cf',
        object: 'chat.completion',
        created: 123,
        model: '@cf/meta/llama-3.1-70b-instruct',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });

    await provider.chatCompletion(
      'abc123:token',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Karachi"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
      ],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedBody.messages[1].content).toBe('');
    expect(capturedBody.messages[1].tool_calls).toHaveLength(1);
  });
});
