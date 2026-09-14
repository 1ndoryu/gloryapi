import { describe, it, expect } from 'vitest';
import { coerceIntegralFloatArgs } from '../../providers/responses/coerce-tool-args.js';
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

describe('coerceIntegralFloatArgs', () => {
  it('coerces integral floats for integer schema fields in tool args', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' }, list: { type: 'array', items: { type: 'integer' } } } };
    expect(coerceIntegralFloatArgs('{"n":3.0,"list":[1.0,2.5]}', schema)).toBe('{"n":3,"list":[1,2.5]}');
    expect(coerceIntegralFloatArgs('not json', schema)).toBe('not json');
    expect(coerceIntegralFloatArgs('{"a":1.5}', {})).toBe('{"a":1.5}');
  });
});

describe('tool call argument buffering', () => {
  it('buffers split function_call_arguments deltas with the same call id', async () => {
    const response = sseBody([
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_s', type: 'function_call', call_id: 'call_s', name: 'f', arguments: '' } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_s', output_index: 0, delta: '{"a":' }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_s', output_index: 0, delta: '1,"b":2.0}' }],
      ['response.completed', {
        type: 'response.completed',
        response: {
          id: 'r', status: 'completed',
          output: [{ type: 'function_call', call_id: 'call_s', name: 'f', arguments: '{"a":1,"b":2}' }],
          usage: {},
        },
      }],
    ]);
    const chunks = [];
    for await (const chunk of translateResponsesStream({ response, providerName: 'P', upstreamModel: 'm' })) {
      chunks.push(chunk);
    }
    const toolDeltas = chunks
      .map(c => (c.choices[0].delta as Record<string, unknown>))
      .filter(d => d.tool_calls) as Array<{ tool_calls: Array<{ function: { arguments: string } }> }>;
    // Split deltas merge into one flush; the integral float 2.0 normalizes
    // to 2 so strict downstream integer schemas accept the call.
    expect(toolDeltas[toolDeltas.length - 1].tool_calls[0].function.arguments).toBe('{"a":1,"b":2}');
  });
});

describe('translateResponsesStream edge cases', () => {
  it('coerces integral floats in buffered stream tool arguments', async () => {
    const response = sseBody([
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'schedule', arguments: '' } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"hou' }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: 'r":9.0}' }],
      ['response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: {} } }],
    ]);
    const chunks = [];
    for await (const chunk of translateResponsesStream({ response, providerName: 'P', upstreamModel: 'm' })) {
      chunks.push(chunk);
    }
    const toolDeltas = chunks
      .map(c => (c.choices[0].delta as Record<string, unknown>))
      .filter(d => d.tool_calls) as Array<{ tool_calls: Array<{ function: { arguments: string } }> }>;
    expect(toolDeltas[toolDeltas.length - 1].tool_calls[0].function.arguments).toBe('{"hour":9}');
  });

  it('ignores incomplete event lines and unknown event types', async () => {
    const raw = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"ok"}\n\n'
      + 'event: response.output_text.delta\nincomplete-line\n\n'
      + 'event: something.unknown\ndata: {"type":"something.unknown"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{}}}\n\n';
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }));
    const chunks = [];
    for await (const chunk of translateResponsesStream({ response, providerName: 'P', upstreamModel: 'm' })) {
      chunks.push(chunk);
    }
    expect(chunks.some(c => (c.choices[0].delta as Record<string, unknown>).content === 'ok')).toBe(true);
  });

  it('closes the stream when the reader ends without response.completed', async () => {
    let reads = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        reads += 1;
        if (reads > 3) {
          controller.close();
          return;
        }
        // Complete frames over several pulls cover the !done read path.
        controller.enqueue(new TextEncoder().encode(`data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"x${reads}"}\n\n`));
      },
    }));
    const chunks = [];
    let failure: unknown;
    try {
      for await (const chunk of translateResponsesStream({ response, providerName: 'P', upstreamModel: 'm' })) {
        chunks.push(chunk);
      }
    } catch (error) {
      failure = error;
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(String((failure as Error)?.message ?? failure)).toMatch(/truncated/);
  });

  it('emits the remainder when a chunk ends mid-line (buffer carry-over)', async () => {
    const part1 = '{"type":"response.output_text.delta","item_id":"m","output_index":0,"content_in';
    const part2 = 'dex":0,"delta":"hola"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{}}}\n\n';
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${part1}`));
        controller.enqueue(new TextEncoder().encode(part2));
        controller.close();
      },
    }));
    const contents: unknown[] = [];
    for await (const chunk of translateResponsesStream({ response, providerName: 'P', upstreamModel: 'm' })) {
      contents.push((chunk.choices[0].delta as Record<string, unknown>).content);
    }
    expect(contents).toContain('hola');
  });
});
