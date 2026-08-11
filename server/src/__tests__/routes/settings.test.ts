import { beforeAll, describe, expect, it } from 'vitest'
import type { Express } from 'express'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../app.js'
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js'
import { getSettingNumber } from '../../settings/registry.js'
import { getAdminAuthToken } from '../../lib/admin-auth.js'
import type { ProviderSettingsSnapshot, SettingsSnapshot } from '@gloryapi/shared/types.js'

async function requestJson(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  authorization?: string,
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose an address')
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${authorization === undefined ? getAdminAuthToken() : authorization}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as unknown }
  } finally {
    server.close()
  }
}

function asSnapshot(body: unknown): SettingsSnapshot {
  return body as SettingsSnapshot
}

describe('Settings API', () => {
  let app: Express

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:', { catalogMode: 'operational' })
    app = createApp()
  })

  it('returns a versioned typed snapshot with safe defaults', async () => {
    const response = await requestJson(app, 'GET', '/api/settings')
    expect(response.status).toBe(200)

    const snapshot = asSnapshot(response.body)
    expect(snapshot.schemaVersion).toBe('glory-settings-v1')
    expect(snapshot.revision).toBe(0)
    expect(snapshot.settings.map(setting => setting.key)).toEqual([
      'routing.maxAttempts',
      'routing.maxDurationMs',
      'routing.nearLimitThreshold',
      'routing.stickyTtlMs',
      'routing.stickyRotationMs',
      'health.checkIntervalMs',
      'health.providerFailureThreshold',
      'health.providerCooldownMs',
    ])
    expect(snapshot.settings.find(setting => setting.key === 'routing.maxAttempts')).toMatchObject({
      type: 'integer',
      defaultValue: 6,
      value: 6,
      min: 1,
      max: 12,
      requiresRestart: false,
    })
    expect(JSON.stringify(snapshot)).not.toContain('apiKey')
    expect(JSON.stringify(snapshot)).not.toContain('encrypted_key')
  })

  it('rejects unauthenticated writes and commits valid updates atomically', async () => {
    const unauthorized = await requestJson(app, 'PATCH', '/api/settings', {
      expectedRevision: 0,
      values: { 'routing.maxAttempts': 4 },
    }, '')
    expect(unauthorized.status).toBe(401)

    const updated = await requestJson(app, 'PATCH', '/api/settings', {
      expectedRevision: 0,
      values: {
        'routing.maxAttempts': 4,
        'routing.nearLimitThreshold': 0.9,
      },
    }, getUnifiedApiKey())
    expect(updated.status).toBe(200)
    expect(asSnapshot(updated.body)).toMatchObject({ revision: 1 })
    expect(getSettingNumber('routing.maxAttempts')).toBe(4)
    expect(getSettingNumber('routing.nearLimitThreshold')).toBe(0.9)

    const invalid = await requestJson(app, 'PATCH', '/api/settings', {
      expectedRevision: 1,
      values: {
        'routing.maxAttempts': 5,
        'routing.nearLimitThreshold': 0.2,
      },
    }, getUnifiedApiKey())
    expect(invalid.status).toBe(400)
    expect(getSettingNumber('routing.maxAttempts')).toBe(4)
    expect(getDb().prepare("SELECT value FROM settings WHERE key = 'settings_revision'").get()).toEqual({ value: '1' })
  })

  it('exposes inherited provider/model settings and applies safe overrides', async () => {
    const initial = await requestJson(app, 'GET', '/api/settings/providers')
    expect(initial.status).toBe(200)
    const initialSnapshot = initial.body as ProviderSettingsSnapshot
    const andoryyu = initialSnapshot.providers.find(provider => provider.platform === 'andoryyu')
    expect(andoryyu?.effective.sources.baseUrl).toBe('default')
    // El timeout efectivo ahora usa el timeout canónico del registry (120 s)
    // en vez del default de 15 s, para que prompts grandes no aborten.
    expect(andoryyu?.effective.timeoutMs).toBe(120_000)

    const providerUpdate = await requestJson(app, 'PATCH', '/api/settings/providers/andoryyu', {
      expectedRevision: initialSnapshot.revision,
      values: {
        overrides: {
          baseUrl: 'https://example.test/api',
          timeoutMs: 30_000,
          capabilities: { reasoning: false },
        },
      },
    }, getUnifiedApiKey())
    expect(providerUpdate.status).toBe(200)
    const providerSnapshot = providerUpdate.body as ProviderSettingsSnapshot
    const updatedProvider = providerSnapshot.providers.find(provider => provider.platform === 'andoryyu')
    expect(updatedProvider?.effective).toMatchObject({
      baseUrl: 'https://example.test/api',
      timeoutMs: 30_000,
      capabilities: { reasoning: false },
      sources: { baseUrl: 'provider', timeoutMs: 'provider', capabilities: 'provider' },
    })

    const modelUpdate = await requestJson(app, 'PATCH', '/api/settings/providers/andoryyu/models/deepseek-v4-flash', {
      expectedRevision: providerSnapshot.revision,
      values: { overrides: { alias: 'deepseek/flash-custom', timeoutMs: 45_000, capabilities: { tools: false } } },
    }, getUnifiedApiKey())
    expect(modelUpdate.status).toBe(200)
    const modelSnapshot = modelUpdate.body as ProviderSettingsSnapshot
    const model = modelSnapshot.providers.find(provider => provider.platform === 'andoryyu')?.models[0]
    expect(model?.effective).toMatchObject({
      alias: 'deepseek/flash-custom',
      timeoutMs: 45_000,
      capabilities: { reasoning: false, tools: false },
      sources: { alias: 'model', timeoutMs: 'model', capabilities: 'model' },
    })

    const unsafe = await requestJson(app, 'PATCH', '/api/settings/providers/andoryyu', {
      expectedRevision: modelSnapshot.revision,
      values: { overrides: { baseUrl: 'http://localhost:8080' } },
    }, getUnifiedApiKey())
    expect(unsafe.status).toBe(400)
    expect((await requestJson(app, 'GET', '/api/settings/providers')).body).toMatchObject({ revision: modelSnapshot.revision })
  })

  it('rejects unknown values and stale revisions without partial writes', async () => {
    const current = (await requestJson(app, 'GET', '/api/settings')).body as SettingsSnapshot
    const unknown = await requestJson(app, 'PATCH', '/api/settings', {
      expectedRevision: current.revision,
      values: { 'security.arbitraryCode': true },
    }, getUnifiedApiKey())
    expect(unknown.status).toBe(400)

    const stale = await requestJson(app, 'PATCH', '/api/settings', {
      expectedRevision: Math.max(0, current.revision - 1),
      values: { 'health.providerCooldownMs': 120_000 },
    }, getUnifiedApiKey())
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({
      error: { code: 'settings_revision_conflict' },
      currentRevision: current.revision,
    })
    expect(getSettingNumber('health.providerCooldownMs')).toBe(5 * 60_000)
  })

  it('exposes a bounded sanitized audit trail only with admin auth', async () => {
    expect((await requestJson(app, 'GET', '/api/settings/audit', undefined, '')).status).toBe(401)
    const response = await requestJson(app, 'GET', '/api/settings/audit?limit=10', undefined, getUnifiedApiKey())
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ schemaVersion: 'glory-settings-audit-v1' })
    expect((response.body as { entries: Array<{ keys: string[] }> }).entries.some(entry => entry.keys.includes('routing.maxAttempts'))).toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('apiKey')
  })
})
