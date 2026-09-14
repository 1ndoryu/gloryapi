import { describe, it, expect } from 'vitest';
import { translateChatRequestToResponses, clampResponsesEffort } from '../../providers/responses/translate-request.js';
import { translateResponsesResponse } from '../../providers/responses/translate-response.js';
import { translateResponsesStream } from '../../providers/responses/translate-stream.js';

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

describe('clampResponsesEffort', () => {
  it('maps max down to the provider limit', () => {
    expect(clampResponsesEffort('max', 'muse', new Map(), 'high')).toBe('high');
    expect(clampResponsesEffort('high', 'muse', new Map(), 'high')).toBe('high');
    expect(clampResponsesEffort('high', 'muse-spark-1.3', new Map([['muse', 'medium']]), 'high')).toBe('medium');
  });
});

describe('translateChatRequestToResponses', () => {
  it('maps text user/system/tool messages to input items', () => {
    const body = translateChatRequestToResponses({
      model: 'muse-spark-1.3-contributor',
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'respondo' },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
      options: {},
    });
    expect(body.model).toBe('muse-spark-1.3-contributor');
    expect(body.stream).toBe(false);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: 'system', content: 'you are helpful' });
    expect(input[1]).toMatchObject({ role: 'user', content: 'hola' });
    expect(input[2]).toMatchObject({ role: 'assistant' });
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' });
  });

  it('preserves images as input_image parts (native vision)', () => {
    const body = translateChatRequestToResponses({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      }],
      options: {},
    });
    const input = body.input as Array<{ content: unknown[] }>;
    expect(input[0].content).toEqual([
      { type: 'input_text', text: 'describe' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc' },
    ]);
  });

  it('drops unsupported tool types instead of aborting the request', () => {
    const body = translateChatRequestToResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      options: {
        tools: [
          { type: 'function', function: { name: 'ok_tool', description: '', parameters: {} } },
          { type: 'web_search', name: 'web' } as unknown as { type: 'function'; function: { name: string } },
          { type: 'function', function: {} as { name: string } },
        ],
      },
    });
    expect(body.tools).toEqual([{ type: 'function', name: 'ok_tool', description: '', parameters: {} }]);
  });

  it('defaults missing tool parameters to an empty object schema', () => {
    const body = translateChatRequestToResponses({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      options: {
        tools: [{
          type: 'function',
          function: { name: 'no_params', description: 'without parameters' },
        }],
      },
    });
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'no_params',
      description: 'without parameters',
      parameters: { type: 'object', properties: {} },
    }]);
  });

  it('maps assistant tool calls to function_call items and options to responses params', () => {
    const body = translateChatRequestToResponses({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"madrid"}' } }],
      }],
      options: {
        max_tokens: 2048,
        reasoning_effort: 'max',
        tools: [{ type: 'function', function: { name: 'get_weather', description: '', parameters: {} } }],
        tool_choice: 'auto',
      },
      reasoningEffort: 'high',
      stream: true,
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] });
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_x', name: 'get_weather', arguments: '{"city":"madrid"}' });
    expect(body.max_output_tokens).toBe(2048);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.stream).toBe(true);
    // The Responses API flattens the function schema (top-level name).
    expect(body.tools).toEqual([
      { type: 'function', name: 'get_weather', description: '', parameters: {} },
    ]);
  });
});

describe('translateResponsesResponse', () => {
  it('maps message + reasoning + function_call output into chat contract', () => {
    const chat = translateResponsesResponse({
      id: 'resp_1',
      created_at: 1700000000,
      model: 'muse-spark-1.3-contributor',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking hard' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'la respuesta' }] },
        { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"madrid"}' },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 12 },
      },
    }, 'muse-spark-1.3-contributor');

    expect(chat.object).toBe('chat.completion');
    expect(chat.model).toBe('muse-spark-1.3-contributor');
    expect(chat.choices[0].message.content).toBe('la respuesta');
    expect(chat.choices[0].message.reasoning_content).toBe('thinking hard');
    expect(chat.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"madrid"}' },
    });
    expect(chat.choices[0].finish_reason).toBe('tool_calls');
    expect(chat.usage.completion_tokens_details?.reasoning_tokens).toBe(12);
    expect(chat.usage.prompt_tokens_details?.cached_tokens).toBe(2);
  });

  it('finishes with length on max_output_tokens incompletion', () => {
    const chat = translateResponsesResponse({
      id: 'resp_2', created_at: 1, model: 'm', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'corto' }] }],
      usage: {},
    }, 'm');
    expect(chat.choices[0].finish_reason).toBe('length');
  });

  it('falls back to stop and null content for empty output', () => {
    const chat = translateResponsesResponse({ id: 'r', created_at: 1, model: 'm', status: 'completed', output: [], usage: {} }, 'm');
    expect(chat.choices[0].message.content).toBeNull();
    expect(chat.choices[0].finish_reason).toBe('stop');
  });
});

describe('translateResponsesStream', () => {
  it('maps SSE events into chat chunks with reasoning, content, tools and usage', async () => {
    const response = sseBody([
      ['response.created', { type: 'response.created', response: { id: 'r' } }],
      ['response.output_item.added', { type: 'response.output_item.added', item_id: 'rs_1', output_index: 0, item: { type: 'reasoning' } }],
      ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'pensando' }],
      ['response.output_item.added', { type: 'response.output_item.added', item_id: 'msg_1', output_index: 1, item: { type: 'message' } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'hola' }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_7', name: 'f' } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"a":' }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '1}' }],
      ['response.completed', {
        type: 'response.completed',
        response: {
          id: 'r', status: 'completed', output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'pensando' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hola' }] },
            { type: 'function_call', call_id: 'call_7', name: 'f', arguments: '{"a":1}' },
          ],
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, output_tokens_details: { reasoning_tokens: 2 } },
        },
      }],
    ]);

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of translateResponsesStream({
      response,
      providerName: 'OpenCode Go',
      upstreamModel: 'muse-spark-1.3-contributor',
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>);
    }

    const deltas = chunks.map(c => (c.choices as Array<{ delta: Record<string, unknown> }>)[0].delta);
    expect(deltas[0]).toMatchObject({ role: 'assistant' });
    expect(deltas[1]).toMatchObject({ reasoning_content: 'pensando' });
    expect(deltas[2]).toMatchObject({ content: 'hola' });
    const toolDeltas = deltas.filter(d => d.tool_calls);
    // Buffered args: announce (id + name once, empty args) then a single
    // flush with the complete arguments — never progressive deltas, so a
    // chunk split can never corrupt a value mid-number.
    expect(toolDeltas).toHaveLength(2);
    expect((toolDeltas[0].tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
      index: 2, id: 'call_7', type: 'function', function: { name: 'f', arguments: '' },
    });
    expect((toolDeltas[1].tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
      index: 2,
      function: { arguments: '{"a":1}' },
    });
    expect((toolDeltas[1].tool_calls as Array<Record<string, unknown>>)[0]).not.toHaveProperty('id');
    expect(((toolDeltas[1].tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).name).toBeUndefined();
    const last = chunks[chunks.length - 1];
    expect((last.choices as Array<{ finish_reason: string }>)[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 5 });
  });

  it('keeps the tool name when the gateway sends the item id inside the item (real opencode-go shape)', async () => {
    // Regression: the real upstream puts the item id/name inside `item` on
    // response.output_item.added (no top-level item_id). Keying the state by
    // event.item_id made the later argument deltas miss and emit a tool call
    // with an empty name, which the chat client rejects with
    // `The tool "" does not exist` and then retries in a loop.
    const response = sseBody([
      ['response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 2,
        item: { id: 'fc_real', type: 'function_call', status: 'in_progress', name: 'get_time', call_id: 'call_real', arguments: '' },
      }],
      ['response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_real',
        output_index: 2,
        delta: '{}',
      }],
      ['response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_real',
        output_index: 2,
        arguments: '{}',
        name: 'get_time',
      }],
      ['response.completed', {
        type: 'response.completed',
        response: {
          id: 'r', status: 'completed',
          output: [{ id: 'fc_real', type: 'function_call', name: 'get_time', call_id: 'call_real', arguments: '{}' }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }],
    ]);

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of translateResponsesStream({
      response,
      providerName: 'OpenCode Go',
      upstreamModel: 'muse-spark-1.3-contributor',
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>);
    }
    const toolDeltas = chunks
      .map(c => (c.choices as Array<{ delta: Record<string, unknown> }>)[0].delta)
      .filter(d => d.tool_calls);
    expect(toolDeltas.length).toBeGreaterThan(0);
    const first = (toolDeltas[0].tool_calls as Array<Record<string, unknown>>)[0];
    expect((first.function as Record<string, unknown>).name).toBe('get_time');
    // Appending clients concatenate every arguments string: announce carries
    // '' and the flush the complete object, so the assembled call is exact.
    const assembled = toolDeltas
      .map(d => ((d.tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).arguments as string)
      .join('');
    expect(assembled).toBe('{}');
  });

  it('throws a retryable error on response.failed', async () => {
    const response = sseBody([
      ['response.created', { type: 'response.created', response: { id: 'r' } }],
      ['response.failed', { type: 'response.failed', response: { id: 'r', error: { message: 'boom' } } }],
    ]);
    await expect(async () => {
      const generator = translateResponsesStream({ response, providerName: 'OpenCode Go', upstreamModel: 'm' });
      for await (const _ of generator) { /* drain */ }
    }).rejects.toThrow(/boom/);
  });
});
