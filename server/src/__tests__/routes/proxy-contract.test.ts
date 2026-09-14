import { describe, expect, it } from 'vitest';
import { chatCompletionSchema, sanitizeChatRequest, toCanonicalChatRequest } from '../../routes/proxy-contract.js';

describe('Canonical chat request adapter', () => {
  it('normalizes assistant tool calls and tool outputs without client-specific branching', () => {
    const parsed = chatCompletionSchema.parse({
      model: 'auto',
      stream: true,
      reasoning_effort: 'high',
      messages: [
        { role: 'user', content: 'Use the tool' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'reasoning',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}', name: 'lookup' },
      ],
    });

    const canonical = toCanonicalChatRequest(parsed);
    expect(canonical.requestedModel).toBe('auto');
    expect(canonical.stream).toBe(true);
    expect(canonical.messages).toMatchObject([
      { role: 'user', content: 'Use the tool' },
      { role: 'assistant', content: null, reasoning_content: 'reasoning', tool_calls: [{ id: 'call-1' }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ]);
  });

  it('keeps the adapter pure and does not carry headers, credentials, or response content', () => {
    const parsed = chatCompletionSchema.parse({ messages: [{ role: 'user', content: 'hello' }] });
    const canonical = toCanonicalChatRequest(parsed);
    expect(JSON.stringify(canonical)).not.toContain('Authorization');
    expect(JSON.stringify(canonical)).not.toContain('apiKey');
    expect(canonical).not.toHaveProperty('response');
  });
});

describe('sanitizeChatRequest', () => {
  it('drops function tools with empty names and keeps valid ones', () => {
    const body = sanitizeChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'good', description: '', parameters: {} } },
        { type: 'function', function: { name: '', description: 'broken', parameters: {} } },
        { type: 'function', function: { name: '  ', parameters: {} } },
      ],
    });
    expect(body).toMatchObject({ tools: [{ type: 'function', function: { name: 'good' } }] });
    expect(chatCompletionSchema.safeParse(body).success).toBe(true);
  });

  it('drops broken assistant tool calls and their orphaned tool results', () => {
    const body = sanitizeChatRequest({
      model: 'auto',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call-good', type: 'function', function: { name: 'keep', arguments: '{}' } },
            { id: 'call-empty-name', type: 'function', function: { name: '', arguments: '{}' } },
            { id: '', type: 'function', function: { name: 'no-id', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call-good', content: 'ok' },
        { role: 'tool', tool_call_id: 'call-empty-name', content: 'drop me' },
        { role: 'tool', tool_call_id: '', content: 'drop me too' },
      ],
    });
    const messages = body.messages as Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }>;
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls?.[0]).toMatchObject({ id: 'call-good', function: { name: 'keep' } });
    expect(messages.map(m => m.role)).toEqual(['assistant', 'tool']);
    expect(messages[1].tool_call_id).toBe('call-good');
    // The now-empty assistant message (all tool calls dropped except one kept)
    // still validates: it keeps its remaining call.
    expect(chatCompletionSchema.safeParse(body).success).toBe(true);
  });

  it('fixes tool_choice with an empty function name', () => {
    const body = sanitizeChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'function', function: { name: '' } },
    });
    expect(body.tool_choice).toBe('auto');
    expect(chatCompletionSchema.safeParse(body).success).toBe(true);
  });

  it('accepts a thinking-only assistant message (empty content + reasoning) but rejects bare empty content', () => {
    const thinkingOnly = {
      messages: [
        { role: 'user', content: 'think it through' },
        { role: 'assistant', content: '', reasoning_content: 'hidden chain of thought' },
        { role: 'user', content: 'and now the answer?' },
      ],
    };
    expect(chatCompletionSchema.safeParse(thinkingOnly).success).toBe(true);

    const bareEmpty = {
      messages: [{ role: 'assistant', content: [] }],
    };
    expect(chatCompletionSchema.safeParse(bareEmpty).success).toBe(false);
  });

  it('leaves a fully valid request untouched', () => {
    const request = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'a', description: '', parameters: {} } }],
      tool_choice: 'auto',
    };
    expect(sanitizeChatRequest(request)).toEqual(request);
  });
});
