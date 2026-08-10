import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('OpenAI-compatible stream state machine', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
    });
  });

  function response(chunks: Uint8Array[]): Response {
    return {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  async function collect(): Promise<unknown[]> {
    const chunks: unknown[] = [];
    for await (const chunk of provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('parses fragmented UTF-8 and CRLF frames', async () => {
    const payload = `data: ${JSON.stringify({
      id: 'chunk-1', object: 'chat.completion.chunk', created: 1, model: 'model',
      choices: [{ index: 0, delta: { content: '🙂' }, finish_reason: null }],
    })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(payload);
    const split = bytes.findIndex((byte, index) => index > 0 && byte === 0x80);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response([bytes.slice(0, split), bytes.slice(split)]));

    const chunks = await collect();
    expect((chunks[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content).toBe('🙂');
  });

  it('rejects malformed JSON instead of silently completing a partial stream', async () => {
    const bytes = new TextEncoder().encode('data: {not-json}\n\ndata: [DONE]\n\n');
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response([bytes]));
    await expect(collect()).rejects.toThrow(/malformed SSE JSON/);
  });

  it('rejects a stream that closes without [DONE] and accepts tool-only output', async () => {
    const toolChunk = `data: ${JSON.stringify({
      id: 'chunk-tool', object: 'chat.completion.chunk', created: 1, model: 'model',
      choices: [{ index: 0, delta: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }],
    })}\n\n`;
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response([new TextEncoder().encode(`${toolChunk}data: [DONE]\n\n`)]));
    const chunks = await collect();
    expect((chunks[0] as { choices: Array<{ delta: { tool_calls: unknown[] } }> }).choices[0].delta.tool_calls).toHaveLength(1);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response([new TextEncoder().encode(toolChunk)]));
    await expect(collect()).rejects.toThrow(/stream truncated/);
  });

  it('fails with cancellation and does not classify cancellation as retryable', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(response([]));

    const generator = provider.streamChatCompletion(
      'key',
      [{ role: 'user', content: 'hi' }],
      'model',
      { signal: controller.signal },
    );
    await expect(generator.next()).rejects.toThrow(/stream cancelled/);
  });
});
