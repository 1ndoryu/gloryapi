import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

function response(model: string, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 429,
    statusText: ok ? 'OK' : 'Rate Limited',
    json: () => Promise.resolve(ok
      ? {
          id: 'id', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
      : {
          model,
          error: { message: 'free-models-per-day-high-balance', model },
        }),
  } as unknown as Response;
}

describe('OpenAI-compatible effective model contract', () => {
  it('rejects a successful response that silently downgrades a tool request', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response('ling-3.0-tiny:free'));

    await expect(provider.chatCompletion(
      'key',
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-flash',
      { tools: [{ type: 'function', function: { name: 'foreign_tool' } }] },
    )).rejects.toMatchObject({
      modelDowngrade: true,
      effectiveModel: 'ling-3.0-tiny:free',
      foreignToolset: true,
    });
  });

  it('detects a downgrade reported inside a rate-limit response', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response('ling-3.0-tiny:free', false));

    await expect(provider.chatCompletion(
      'key',
      [{ role: 'user', content: 'hi' }],
      'deepseek-v4-flash',
      { tools: [{ type: 'function', function: { name: 'foreign_tool' } }] },
    )).rejects.toMatchObject({
      modelDowngrade: true,
      effectiveModel: 'ling-3.0-tiny:free',
      foreignToolset: true,
    });
  });
});
