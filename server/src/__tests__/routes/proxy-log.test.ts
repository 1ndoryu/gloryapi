import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, initDb } from '../../db/index.js'
import { logProxyRequest } from '../../routes/proxy-log.js'

describe('Proxy request reasoning telemetry', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:')
  })

  it('persists requested effort and measured reasoning tokens', () => {
    logProxyRequest(
      'commandcode',
      'deepseek/deepseek-v4-flash',
      'success',
      1200,
      80,
      900,
      null,
      null,
      {
        reasoningEffort: 'high',
        reasoningTokens: 37,
        reasoningTokensSource: 'provider',
      },
    )

    const row = getDb().prepare(`
      SELECT reasoning_effort, reasoning_tokens, reasoning_tokens_source
      FROM requests
      ORDER BY id DESC
      LIMIT 1
    `).get() as {
      reasoning_effort: string
      reasoning_tokens: number
      reasoning_tokens_source: string
    }

    expect(row).toEqual({
      reasoning_effort: 'high',
      reasoning_tokens: 37,
      reasoning_tokens_source: 'provider',
    })
  })
})
