import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { replaceNullAssistantContent, stripEmptyReasoning, fillMissingToolReasoning } from '../../providers/openai-message-normalization.js';

describe('OpenAICompatProvider - content normalization', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
    });
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

  it('stripEmptyReasoning drops empty reasoning fields that strict gateways reject (039A-1g)', () => {
    const normalized = stripEmptyReasoning([
      { role: 'assistant', content: 'answer', reasoning_content: '' },
      { role: 'assistant', content: 'answer', reasoning_content: 'real trace', reasoning: '' },
      { role: 'user', content: 'hi' },
    ]);

    expect('reasoning_content' in normalized[0]).toBe(false);
    expect(normalized[0].content).toBe('answer');
    expect(normalized[1].reasoning_content).toBe('real trace');
    expect('reasoning' in normalized[1]).toBe(false);
    expect(normalized[2].content).toBe('hi');
  });

  it('stripEmptyReasoning drops foreign reasoning on tool-call turns (gateway-issued carrier rule)', () => {
    const toolCall = { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } };
    const normalized = stripEmptyReasoning([
      { role: 'assistant', content: 'looking up', reasoning_content: 'foreign trace', tool_calls: [toolCall] },
    ]);

    expect('reasoning_content' in normalized[0]).toBe(false);
    expect(normalized[0].tool_calls).toHaveLength(1);
    expect(normalized[0].content).toBe('looking up');
  });

  it('fillMissingToolReasoning marks empty tool-call reasoning so DeepSeek thinking accepts cross-model histories (089A-4)', () => {
    const toolCall = (id: string) => ({ id, type: 'function', function: { name: 'lookup', arguments: '{}' } });
    const normalized = fillMissingToolReasoning([
      { role: 'assistant', content: '', reasoning_content: '', tool_calls: [toolCall('call_1')] },
      { role: 'assistant', content: '', tool_calls: [toolCall('call_2'), toolCall('call_3')] },
      { role: 'assistant', content: '', reasoning_content: 'real trace', tool_calls: [toolCall('call_4')] },
      { role: 'assistant', content: '', reasoning: 'bare trace', tool_calls: [toolCall('call_5')] },
      { role: 'assistant', content: 'plain answer', reasoning_content: '' },
      { role: 'user', content: 'hi' },
    ]);

    expect(normalized[0].reasoning_content).toMatch(/^\[cross-model continuation/);
    expect(normalized[1].reasoning_content).toMatch(/^\[cross-model continuation/);
    expect(normalized[2].reasoning_content).toBe('real trace');
    expect(normalized[3].reasoning_content).toBe('bare trace');
    expect(normalized[3].reasoning).toBe('bare trace');
    expect(normalized[4].reasoning_content).toBe('');
    expect(normalized[5].content).toBe('hi');
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

  it('mirrors bare reasoning into reasoning_content (CommandCode style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'answer', reasoning: 'thinking trace' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('answer');
    expect(result.choices[0].message.reasoning_content).toBe('thinking trace');
    expect(result.choices[0].message.reasoning).toBe('thinking trace');
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