import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import type { Express } from 'express'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../app.js'
import { clearDashboardSessions } from '../../lib/security/dashboard-session.js'
import { initDb } from '../../db/index.js'

async function request(app: Express, method: string, path: string, options: { origin?: string; token?: string; csrf?: string; body?: unknown } = {}) {
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not expose an address')
    const headers: Record<string, string> = {
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) as unknown }
  } finally {
    server.close()
  }
}

describe('Dashboard session control plane', () => {
  let app: Express

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:')
    app = createApp()
  })

  afterEach(() => clearDashboardSessions())

  it('bootstraps a short-lived loopback session and authorizes management reads', async () => {
    const origin = 'http://localhost:5173'
    const bootstrap = await request(app, 'POST', '/api/session/bootstrap', { origin })
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers.get('cache-control')).toContain('no-store')
    expect(bootstrap.body).toMatchObject({ schemaVersion: 'glory-dashboard-session-v1' })

    const session = bootstrap.body as { token: string; csrfToken: string; expiresAt: string }
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now())

    const models = await request(app, 'GET', '/api/models', { origin, token: session.token })
    expect(models.status).toBe(200)
    const sameOriginRead = await request(app, 'GET', '/api/models', { token: session.token })
    expect(sameOriginRead.status).toBe(200)
  })

  it('requires a matching origin and CSRF token for session mutations', async () => {
    const origin = 'http://localhost:5173'
    const bootstrap = await request(app, 'POST', '/api/session/bootstrap', { origin })
    const session = bootstrap.body as { token: string; csrfToken: string }

    const missingCsrf = await request(app, 'PATCH', '/api/settings', {
      origin,
      token: session.token,
      body: { expectedRevision: 0, values: { 'routing.maxAttempts': 5 } },
    })
    expect(missingCsrf.status).toBe(401)

    const wrongOrigin = await request(app, 'GET', '/api/models', { origin: 'http://127.0.0.1:5173', token: session.token })
    expect(wrongOrigin.status).toBe(401)

    const valid = await request(app, 'PATCH', '/api/settings', {
      origin,
      token: session.token,
      csrf: session.csrfToken,
      body: { expectedRevision: 0, values: { 'routing.maxAttempts': 5 } },
    })
    expect(valid.status).toBe(200)
  })

  it('protects routing SSE and accepts the dashboard session without CSRF on GET', async () => {
    const origin = 'http://localhost:5173'
    const bootstrap = await request(app, 'POST', '/api/session/bootstrap', { origin })
    const session = bootstrap.body as { token: string; csrfToken: string }

    const server = app.listen(0)
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose an address')
      const base = `http://127.0.0.1:${(address as AddressInfo).port}`
      const unauthorized = await fetch(`${base}/api/fallback/events`)
      expect(unauthorized.status).toBe(401)

      const authorized = await fetch(`${base}/api/fallback/events`, {
        headers: { Authorization: `Bearer ${session.token}` },
      })
      expect(authorized.status).toBe(200)
      expect(authorized.headers.get('content-type')).toContain('text/event-stream')
      const reader = authorized.body?.getReader()
      if (!reader) throw new Error('SSE response did not expose a body')
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('event: routing.ready')
      await reader.cancel()

      const mutationWithoutOrigin = await request(app, 'PATCH', '/api/settings', {
        token: session.token,
        csrf: session.csrfToken,
        body: { expectedRevision: 0, values: { 'routing.maxAttempts': 5 } },
      })
      expect(mutationWithoutOrigin.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('rejects non-loopback or untrusted origins at bootstrap', async () => {
    const blockedOrigin = await request(app, 'POST', '/api/session/bootstrap', { origin: 'https://evil.example' })
    expect(blockedOrigin.status).toBe(403)
  })
})
