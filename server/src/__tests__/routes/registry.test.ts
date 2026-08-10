import { describe, expect, it, beforeAll } from 'vitest'
import type { Express } from 'express'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../app.js'
import { getDb, initDb } from '../../db/index.js'
import type { RegistrySnapshot } from '@gloryapi/shared/types.js'

async function requestJson(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose an address')
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
    app = createApp()
  })

  it('returns the versioned active catalog without secret material', async () => {
    const snapshot = await requestRegistry(app)

    expect(snapshot.schemaVersion).toBe('glory-registry-v1')
    expect(snapshot.providers.map(provider => provider.platform)).toEqual([
      'andoryyu', 'opencode-zen', 'opencode-go',
    ])
    expect(snapshot.models.map(model => `${model.platform}:${model.modelId}`)).toEqual([
      'andoryyu:deepseek-v4-flash',
      'opencode-zen:deepseek-v4-flash-free',
      'opencode-go:deepseek-v4-flash',
    ])
    expect(snapshot.providers.every(provider => provider.lifecycle === 'active')).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('encrypted_key')
    expect(JSON.stringify(snapshot)).not.toContain('apiKey')
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
    expect(snapshot.models).toHaveLength(3)
  })
})
