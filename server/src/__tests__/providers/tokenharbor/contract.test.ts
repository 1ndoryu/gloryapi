import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatProvider } from '../../../providers/openai-compat.js'

describe('TokenHarbor provider contract', () => {
  it('maps the public free model id to the upstream model id', async () => {
    let requestBody: { model?: string } | undefined
    const provider = new OpenAICompatProvider({
      platform: 'tokenharbor',
      name: 'TokenHarbor',
      baseUrl: 'https://tokenharbor.ai/v1',
      modelAliases: { 'deepseek-v4-flash:free': 'deepseek-v4-flash' },
    })
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as { model?: string }
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      } as unknown as Response
    })

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'deepseek-v4-flash:free')

    expect(requestBody?.model).toBe('deepseek-v4-flash')
  })
})
