import { describe, expect, it, beforeAll } from 'vitest'
import type { Express } from 'express'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../app.js'
import { getDb, initDb } from '../../db/index.js'
import type { RegistrySnapshot } from '@gloryapi/shared/types.js'

let adminKey = ''

async function requestJson(app: Express, method: string, path: string, body?: unknown, authenticated = true): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose an address')
    const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' }
    if (authenticated) headers.Authorization = `Bearer ${adminKey}`
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as unknown }
  } finally {
    server.close()
  }
}

async function requestRegistry(app: Express): Promise<RegistrySnapshot> {
  const response = await requestJson(app, 'GET', '/api/registry')
  if (response.status !== 200) throw new Error(`Registry request failed: ${response.status}`)
  return response.body as RegistrySnapshot
}

describe('Provider registry API', () => {
  let app: Express

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:', { catalogMode: 'operational' })
    adminKey = (getDb().prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string }).value
    app = createApp()
  })

  it('requires the admin key for registry reads and mutations', async () => {
    const requests: Array<[string, string]> = [
      ['GET', '/api/registry'],
      ['GET', '/api/registry/templates'],
      ['GET', '/api/registry/providers/andoryyu/models'],
      ['GET', '/api/registry/providers/andoryyu/export'],
      ['POST', '/api/registry/providers'],
      ['POST', '/api/registry/providers/andoryyu/models/select'],
      ['POST', '/api/registry/providers/andoryyu/verify'],
      ['POST', '/api/registry/providers/andoryyu/activate'],
      ['POST', '/api/registry/providers/andoryyu/duplicate'],
      ['PUT', '/api/registry/providers/andoryyu'],
      ['DELETE', '/api/registry/providers/andoryyu'],
      ['PATCH', '/api/registry/providers/andoryyu/state'],
    ]
    for (const [method, path] of requests) {
      const body = method === 'GET' ? undefined : {}
      expect((await requestJson(app, method, path, body, false)).status).toBe(401)
    }
  })

  it('returns the versioned active catalog without secret material', async () => {
    const snapshot = await requestRegistry(app)

    expect(snapshot.schemaVersion).toBe('glory-registry-v1')
    expect(snapshot.providers.map(provider => provider.platform)).toEqual([
      'andoryyu', 'opencode-zen', 'tokenharbor', 'opencode-go',
    ])
    expect(snapshot.models.map(model => `${model.platform}:${model.modelId}`)).toEqual([
      'andoryyu:deepseek-v4-flash',
      'opencode-zen:deepseek-v4-flash-free',
      'tokenharbor:deepseek-v4-flash:free',
      'opencode-go:deepseek-v4-flash',
    ])
    expect(snapshot.providers.every(provider => provider.lifecycle === 'active')).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('encrypted_key')
    expect(JSON.stringify(snapshot)).not.toContain('apiKey')
  })

  it('keeps TokenHarbor capabilities fail-closed until they are verified', async () => {
    const snapshot = await requestRegistry(app)
    const provider = snapshot.providers.find(entry => entry.platform === 'tokenharbor')
    const model = snapshot.models.find(entry => entry.platform === 'tokenharbor')

    expect(provider?.capabilities).toEqual({
      streaming: true,
      tools: false,
      reasoning: false,
      multimodal: false,
      maxContextWindow: null,
    })
    expect(model?.capabilities).toEqual(provider?.capabilities)
  })

  it('creates an inert draft and rejects activation without verification', async () => {
    const draft = {
      platform: 'google',
      displayName: 'Google draft',
      adapter: 'google-gemini',
      endpoint: 'https://generativelanguage.googleapis.com',
      authScheme: 'bearer',
      capabilities: {
        streaming: true,
        tools: true,
        reasoning: true,
        multimodal: true,
        maxContextWindow: 1_000_000,
      },
    }
    const created = await requestJson(app, 'POST', '/api/registry/providers', draft)
    expect(created.status).toBe(201)

    const snapshot = await requestRegistry(app)
    expect(snapshot.providers.find(provider => provider.platform === 'google')).toMatchObject({
      lifecycle: 'draft',
      displayName: 'Google draft',
    })

    const capabilityCheck = await requestJson(app, 'POST', '/api/registry/providers/google/verify', {
      check: 'capabilities',
    })
    expect(capabilityCheck.status).toBe(200)

    const activation = await requestJson(app, 'POST', '/api/registry/providers/google/activate')
    expect(activation.status).toBe(409)
    expect(activation.body).toMatchObject({ error: { message: expect.stringContaining('verification') } })

    const insecure = await requestJson(app, 'PUT', '/api/registry/providers/google', {
      ...draft,
      endpoint: 'http://localhost:8080',
    })
    expect(insecure.status).toBe(400)

    const removed = await requestJson(app, 'DELETE', '/api/registry/providers/google')
    expect(removed.status).toBe(200)
  })

  it('reports archived credentials without reactivating their provider', async () => {
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, encryption_scheme, fingerprint)
      VALUES ('groq', 'archived fixture', 'ciphertext', '', '', 'dpapi-current-user', 'fixture-fingerprint')
    `).run()

    const snapshot = await requestRegistry(app)
    const archived = snapshot.providers.find(provider => provider.platform === 'groq')
    expect(archived).toMatchObject({ lifecycle: 'archived', credentialCount: 1, endpoint: '' })
    expect(snapshot.models).toHaveLength(4)
  })

  it('exposes declarative templates and accepts a new provider as an inert draft', async () => {
    const templates = await requestJson(app, 'GET', '/api/registry/templates')
    expect(templates.status).toBe(200)
    expect((templates.body as { schemaVersion: string }).schemaVersion).toBe('glory-provider-templates-v1')
    expect((templates.body as { templates: Array<{ id: string }> }).templates.map(template => template.id)).toContain('openai-chat')

    const draft = await requestJson(app, 'POST', '/api/registry/providers', {
      platform: 'new-provider-fixture',
      displayName: 'New Provider Fixture',
      adapter: 'openai-compatible',
      endpoint: 'https://provider.example/v1',
      authScheme: 'bearer',
      capabilities: { streaming: true, tools: true, reasoning: false, multimodal: false, maxContextWindow: 131072 },
    })
    expect(draft.status).toBe(201)
    const snapshot = await requestRegistry(app)
    expect(snapshot.providers.find(provider => provider.platform === 'new-provider-fixture')).toMatchObject({
      lifecycle: 'draft',
      credentialCount: 0,
    })
    const activation = await requestJson(app, 'POST', '/api/registry/providers/new-provider-fixture/activate')
    expect(activation.status).toBe(409)
  })

  it('exports sanitized definitions and duplicates without credentials', async () => {
    const exported = await requestJson(app, 'GET', '/api/registry/providers/andoryyu/export')
    expect(exported.status).toBe(200)
    expect(JSON.stringify(exported.body)).not.toMatch(/encrypted|apiKey|secret/i)
    const duplicated = await requestJson(app, 'POST', '/api/registry/providers/andoryyu/duplicate', {
      platform: 'andoryyu-copy',
    })
    expect(duplicated.status).toBe(201)
    expect((duplicated.body as { credentialCount: number }).credentialCount).toBe(0)
    const snapshot = await requestRegistry(app)
    expect(snapshot.providers.find(provider => provider.platform === 'andoryyu-copy')).toMatchObject({ lifecycle: 'draft' })
  })

  it('persists only explicitly selected model drafts', async () => {
    const selected = await requestJson(app, 'POST', '/api/registry/providers/andoryyu/models/select', {
      models: [{
        modelId: 'fixture-model',
        displayName: 'Fixture Model',
        contextWindow: 32768,
        capabilities: { streaming: true, tools: false, reasoning: false, multimodal: false, maxContextWindow: 32768 },
      }],
    })
    expect(selected.status).toBe(201)
    const drafts = await requestJson(app, 'GET', '/api/registry/providers/andoryyu/models')
    expect(drafts.status).toBe(200)
    expect((drafts.body as { models: Array<{ modelId: string }> }).models).toEqual([{
      modelId: 'fixture-model',
      displayName: 'Fixture Model',
      contextWindow: 32768,
      capabilities: { streaming: true, tools: false, reasoning: false, multimodal: false, maxContextWindow: 32768 },
    }])
    expect((await requestRegistry(app)).models).toHaveLength(4)
  })

  it('requires an explicit key and never auto-selects discovered models', async () => {
    const missingKey = await requestJson(app, 'GET', '/api/registry/providers/andoryyu/models/discover')
    expect(missingKey.status).toBe(400)
    const keyId = Number((getDb().prepare("SELECT id FROM api_keys WHERE platform = 'andoryyu' LIMIT 1").get() as { id: number } | undefined)?.id)
    const unavailable = await requestJson(app, 'GET', `/api/registry/providers/andoryyu/models/discover?keyId=${keyId}`)
    expect([400, 404, 502]).toContain(unavailable.status)
  })

  it('protects the compact control status endpoint', async () => {
    const unauthorized = await requestJson(app, 'GET', '/api/control/status', undefined, false)
    expect(unauthorized.status).toBe(401)
    const key = getDb().prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string }
    const server = app.listen(0)
    try {
      const address = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/api/control/status`, { headers: { Authorization: `Bearer ${key.value}` } })
      expect(response.status).toBe(200)
      const body = await response.json() as { schemaVersion: string; models: unknown[] }
      expect(body.schemaVersion).toBe('glory-control-status-v1')
      expect(body.models).toHaveLength(4)
    } finally {
      server.close()
    }
  })

  it('persists provider enablement and updates routing flags atomically', async () => {
    const before = await requestRegistry(app)
    expect(before.providers.find(provider => provider.platform === 'andoryyu')?.enabled).toBe(true)
    const disabled = await requestJson(app, 'PATCH', '/api/registry/providers/andoryyu/state', { enabled: false })
    expect(disabled.status).toBe(200)
    expect((await requestRegistry(app)).providers.find(provider => provider.platform === 'andoryyu')?.enabled).toBe(false)
    const row = getDb().prepare(`SELECT fc.enabled FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id WHERE m.platform = 'andoryyu'`).get() as { enabled: number }
    expect(row.enabled).toBe(0)
    const enabled = await requestJson(app, 'PATCH', '/api/registry/providers/andoryyu/state', { enabled: true })
    expect(enabled.status).toBe(200)
    expect((await requestRegistry(app)).providers.find(provider => provider.platform === 'andoryyu')?.enabled).toBe(true)
  })
})
