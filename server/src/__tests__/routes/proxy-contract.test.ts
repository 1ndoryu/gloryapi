import { describe, expect, it } from 'vitest';
import { chatCompletionSchema, toCanonicalChatRequest } from '../../routes/proxy-contract.js';

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
