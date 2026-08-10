import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CohereProvider } from '../../providers/cohere.js';

type CohereRequestBody = {
  messages: unknown[];
  tools?: unknown[];
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

describe('CohereProvider', () => {
  let provider: CohereProvider;

  beforeEach(() => {
    provider = new CohereProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('cohere');
    expect(provider.name).toBe('Cohere');
  });

  it('should call compatibility API and return OpenAI response', async () => {
    let capturedUrl = '';
    let capturedBody: CohereRequestBody;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = parseBody<CohereRequestBody>(init);
      return jsonResponse({
        id: 'cohere-123',
        object: 'chat.completion',
        created: 123,
        model: 'command-a-03-2025',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Cohere!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'command-r-plus-08-2024',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        }],
      },
    );

    expect(capturedUrl).toContain('/compatibility/v1/chat/completions');
    expect(capturedBody.tools).toHaveLength(1);
    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello from Cohere!');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result._routed_via?.platform).toBe('cohere');
  });

  it('should validate key', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await provider.validateKey('valid')).toBe(true);
  });
});
