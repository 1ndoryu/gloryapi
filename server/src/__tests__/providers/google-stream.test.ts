import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoogleProvider } from '../../providers/google.js'

describe('GoogleProvider streaming', () => {
  let provider: GoogleProvider

  beforeEach(() => {
    provider = new GoogleProvider()
  })

  function sseResponse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const output: T[] = []
    for await (const chunk of gen) output.push(chunk)
    return output
  }

  it('streams text deltas and emits a final stop chunk', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]))

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ))

    const text = chunks.map(chunk => chunk.choices[0].delta.content ?? '').join('')
    expect(text).toBe('Hello')
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop')
  })

  it('skips a malformed SSE frame instead of aborting the whole stream', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {oops not json\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ))

    const text = chunks.map(chunk => chunk.choices[0].delta.content ?? '').join('')
    expect(text).toBe('Hello')
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop')
  })

  it('streams functionCall parts as tool_calls with finish_reason=tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"get_weather","args":{"city":"Karachi"}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]))

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    ))

    const toolDeltas = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? [])
    expect(toolDeltas).toHaveLength(1)
    expect(toolDeltas[0].function.name).toBe('get_weather')
    expect(toolDeltas[0].function.arguments).toBe('{"city":"Karachi"}')
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls')
  })
})
