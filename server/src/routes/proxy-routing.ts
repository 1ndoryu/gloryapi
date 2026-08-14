import crypto from 'crypto'
import { Router } from 'express'
import type { ChatMessage } from '@gloryapi/shared/types.js'
import { getDb, getUnifiedApiKey } from '../db/index.js'
import { getSettingNumber } from '../settings/registry.js'
import { getRouteModelIds, resolveClientCatalogEntry } from '../services/configuration-v2.js';
import { getConfiguredProviderFromDb, type ProviderFailurePolicy } from '../services/provider-configuration.js';

export const AUTO_MODEL_ID = 'auto'

/**
 * Compatibility read-view for older integrations and tests.
 *
 * Routing no longer reads this object. It is resolved from the persisted
 * route tables so a disabled member cannot be resurrected by a source-level
 * list. Keeping this read-view for one migration cycle avoids breaking old
 * diagnostics that import the symbol directly.
 */
export const MODEL_FALLBACK_OVERRIDES: Record<string, Array<{ platform: string; modelId: string }>> = new Proxy({}, {
  get(_target, property: string | symbol) {
    if (typeof property !== 'string') return undefined;
    try {
      const catalog = resolveClientCatalogEntry(property);
      if (!catalog) return undefined;
      const ids = getRouteModelIds(catalog.routeId);
      if (!ids.length) return [];
      return getDb().prepare(`
        SELECT platform, model_id FROM models
        WHERE id IN (${ids.map(() => '?').join(',')})
        ORDER BY CASE id ${ids.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ')} ELSE 999999 END
      `).all(...ids) as Array<{ platform: string; modelId: string }>;
    } catch {
      return undefined;
    }
  },
})

export function getProviderFailurePolicy(platform: string): ProviderFailurePolicy {
  return getConfiguredProviderFromDb(getDb(), platform)?.failurePolicy ?? {
    cooldownMs: 120000,
    recordPenalty: false,
    recordProviderFailure: true,
  };
}

/** Read-only compatibility view for old diagnostics; runtime routing uses the service. */
export const PROVIDER_FAILURE_POLICY: Record<string, ProviderFailurePolicy> = new Proxy({}, {
  get(_target, property: string | symbol) {
    return typeof property === 'string' ? getProviderFailurePolicy(property) : undefined;
  },
});

type VisibleModel = {
  display_name: string
  model_id: string
  platform: string
  context_window: number | null
  intelligence_rank?: number
  speed_rank?: number
}

export function compareVisibleModels(a: VisibleModel, b: VisibleModel): number {
  const rankA = a.intelligence_rank ?? Number.MAX_SAFE_INTEGER
  const rankB = b.intelligence_rank ?? Number.MAX_SAFE_INTEGER
  if (rankA !== rankB) return rankA - rankB

  const speedA = a.speed_rank ?? Number.MAX_SAFE_INTEGER
  const speedB = b.speed_rank ?? Number.MAX_SAFE_INTEGER
  if (speedA !== speedB) return speedA - speedB
  return a.display_name.localeCompare(b.display_name)
}

export function isAutoModel(modelId: string | undefined): boolean {
  return modelId === AUTO_MODEL_ID
}

export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length)
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length
}

const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number; stickySince: number }>()

function getSessionKey(messages: ChatMessage[]): string {
  const firstUser = messages.find(message => message.role === 'user')
  if (!firstUser || typeof firstUser.content !== 'string') return ''
  const hash = crypto.createHash('sha1').update(firstUser.content).digest('hex')
  return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`
}

export function getStickyModel(messages: ChatMessage[]): number | undefined {
  if (!messages.some(message => message.role === 'assistant')) return undefined
  const key = getSessionKey(messages)
  if (!key) return undefined

  const entry = stickySessionMap.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.lastUsed > getSettingNumber('routing.stickyTtlMs')) {
    stickySessionMap.delete(key)
    return undefined
  }
  if (Date.now() - entry.stickySince > getSettingNumber('routing.stickyRotationMs')) return undefined
  return entry.modelDbId
}

export function registerModelRoutes(router: Router): void {
  router.get('/models', (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token || !timingSafeStringEqual(token, getUnifiedApiKey())) {
      res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } })
      return
    }
    const db = getDb()
    const models = db.prepare(`
      SELECT platform, model_id, display_name, context_window, intelligence_rank, speed_rank
        FROM models
       WHERE enabled = 1
       ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
    `).all() as VisibleModel[]
    const sortedModels = [...models].sort(compareVisibleModels)
    const modelList = [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'gloryapi',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      },
      ...sortedModels.map(model => ({
        id: model.model_id,
        object: 'model',
        created: 0,
        owned_by: model.platform,
        name: model.display_name,
        context_window: model.context_window,
      })),
    ]
    // OpenAI clients consume `data`; Codex Desktop 0.146.x expects the
    // equivalent list under `models`. Keep both aliases so model discovery is
    // compatible without changing the existing VS Code/API contract.
    res.json({ object: 'list', data: modelList, models: modelList })
  })
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number): void {
  const key = getSessionKey(messages)
  if (!key) return
  const existing = stickySessionMap.get(key)
  const stickySince = existing?.modelDbId === modelDbId ? existing.stickySince : Date.now()
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now(), stickySince })

  if (stickySessionMap.size > 500) {
    const now = Date.now()
    for (const [sessionKey, value] of stickySessionMap) {
      if (now - value.lastUsed > getSettingNumber('routing.stickyTtlMs')) stickySessionMap.delete(sessionKey)
    }
  }
}
