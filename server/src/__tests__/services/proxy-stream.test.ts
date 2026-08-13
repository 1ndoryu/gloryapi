import type { Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { streamProxyResponse } from '../../services/proxy-stream.js'

function responseMock(): Response {
  return {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as Response
}

function routeWithChunks(chunks: unknown[]) {
  return {
    displayName: 'CommandCode',
    modelDbId: 1,
    platform: 'commandcode',
    modelId: 'deepseek/deepseek-v4-flash',
    keyId: 1,
    provider: {
      async *streamChatCompletion() {
        for (const chunk of chunks) yield chunk
      },
    },
  } as never
}

describe('stream proxy reasoning telemetry', () => {
  it('prefers provider-reported reasoning tokens from the final usage chunk', async () => {
    const onSuccess = vi.fn()
    await streamProxyResponse({
      route: routeWithChunks([
        { choices: [{ delta: { reasoning_content: '123456789' } }] },
        { choices: [{ delta: { content: 'respuesta' } }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
            completion_tokens_details: { reasoning_tokens: 17 },
          },
        },
      ]),
      messages: [{ role: 'user', content: 'hola' }],
      options: {},
      res: responseMock(),
      attempt: 0,
      onSuccess,
      onMidStreamError: vi.fn(),
    })

    expect(onSuccess).toHaveBeenCalledWith(3, {
      reasoningTokens: 17,
      reasoningTokensSource: 'provider',
    })
  })

  it('marks the value as estimated when the stream has reasoning but no usage details', async () => {
    const onSuccess = vi.fn()
    await streamProxyResponse({
      route: routeWithChunks([
        { choices: [{ delta: { reasoning_content: '123456789' } }] },
        { choices: [{ delta: { content: 'ok' } }] },
      ]),
      messages: [{ role: 'user', content: 'hola' }],
      options: {},
      res: responseMock(),
      attempt: 0,
      onSuccess,
      onMidStreamError: vi.fn(),
    })

    expect(onSuccess).toHaveBeenCalledWith(1, {
      reasoningTokens: 3,
      reasoningTokensSource: 'estimated',
    })
  })

  it('does not let provisional zero usage suppress observed reasoning deltas', async () => {
    const onSuccess = vi.fn()
    await streamProxyResponse({
      route: routeWithChunks([
        { choices: [{ delta: { reasoning_content: '123456789' } }], usage: { completion_tokens_details: { reasoning_tokens: 0 } } },
        { choices: [{ delta: { content: 'respuesta' } }] },
        { choices: [], usage: { completion_tokens_details: { reasoning_tokens: 0 } } },
      ]),
      messages: [{ role: 'user', content: 'hola' }],
      options: {},
      res: responseMock(),
      attempt: 0,
      onSuccess,
      onMidStreamError: vi.fn(),
    })

    expect(onSuccess).toHaveBeenCalledWith(3, {
      reasoningTokens: 3,
      reasoningTokensSource: 'estimated',
    })
  })
})
