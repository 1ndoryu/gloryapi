import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'
import { createApp } from '../../../app.js'
import { getDb, getUnifiedApiKey, initDb } from '../../../db/index.js'
import { getAdminAuthToken } from '../../../lib/admin-auth.js'

type ProxyBody = { choices?: Array<{ message?: { content?: string } }> }

async function request(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0)
  const address = server.address() as AddressInfo
  try {
    const managementHeaders = path.startsWith('/api/') && !headers.Authorization
      ? { Authorization: `Bearer ${getAdminAuthToken()}` }
      : {}
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...managementHeaders, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: await response.json() as ProxyBody, headers: response.headers }
  } finally {
    server.close()
  }
}

describe('capability-aware proxy fallback', () => {
  let app: Express

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:')
    app = createApp()
  })

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run()
  })

  it('skips TokenHarbor tools rejection and reaches OpenCode Go', async () => {
    const db = getDb()
    for (const [platform, modelId, displayName, intelligence, speed] of [
      ['tokenharbor', 'deepseek-v4-flash:free', 'DeepSeek V4 Flash (TokenHarbor Free)', 3, 3],
      ['opencode-go', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Go)', 4, 4],
    ] as const) {
      db.prepare(`
        INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(platform, modelId, displayName, intelligence, speed)
    }

    expect((await request(app, 'POST', '/api/keys', {
      platform: 'tokenharbor', key: 'tokenharbor_capability_test', label: 'capability-tokenharbor',
    })).status).toBe(201)
    expect((await request(app, 'POST', '/api/keys', {
      platform: 'opencode-go', key: 'opencode_go_capability_test', label: 'capability-go',
    })).status).toBe(201)

    const realFetch = global.fetch
    const upstreamCalls: string[] = []
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('tokenharbor.ai/v1/chat/completions')) {
        upstreamCalls.push('tokenharbor')
        throw new Error('TokenHarbor should be excluded before upstream selection')
      }
      if (urlStr.includes('opencode.ai/zen/go/v1/chat/completions')) {
        upstreamCalls.push('opencode-go')
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-capability-fallback', object: 'chat.completion', created: 123,
            model: 'deepseek-v4-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'reached compatible fallback' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
          }),
        } as unknown as Response
      }
      return realFetch(url, init)
    })

    const result = await request(app, 'POST', '/v1/chat/completions', {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    }, { Authorization: `Bearer ${getUnifiedApiKey()}` })

    expect(result.status).toBe(200)
    expect(result.body.choices?.[0]?.message?.content).toBe('reached compatible fallback')
    expect(result.headers.get('x-routed-via')).toBe('opencode-go/deepseek-v4-flash')
    expect(upstreamCalls).toEqual(['opencode-go'])
  })
})
