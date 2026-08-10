import { beforeAll, describe, expect, it } from 'vitest'
import type { Express } from 'express'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../app.js'
import { getUnifiedApiKey, initDb } from '../../db/index.js'

describe('data-plane model discovery', () => {
  let app: Express

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    initDb(':memory:')
    app = createApp()
  })

  it('requires the data-plane key for /v1/models and preserves dual aliases when authorized', async () => {
    const server = app.listen(0)
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose an address')
      const base = `http://127.0.0.1:${(address as AddressInfo).port}`
      const unauthorized = await fetch(`${base}/v1/models`)
      expect(unauthorized.status).toBe(401)
      expect((await unauthorized.json()) as unknown).toMatchObject({ error: { type: 'authentication_error' } })

      const authorized = await fetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${getUnifiedApiKey()}` },
      })
      expect(authorized.status).toBe(200)
      const body = await authorized.json() as { data: unknown[]; models: unknown[] }
      expect(body.models).toEqual(body.data)
    } finally {
      server.close()
    }
  })
})
