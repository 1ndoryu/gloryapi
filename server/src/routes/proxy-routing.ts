import crypto from 'crypto'
import { Router } from 'express'
import type { ChatMessage } from '@gloryapi/shared/types.js'
import { getDb, getUnifiedApiKey } from '../db/index.js'
import { getSettingNumber } from '../settings/registry.js'

export const AUTO_MODEL_ID = 'auto'

export const MODEL_FALLBACK_OVERRIDES: Record<string, Array<{ platform: string; modelId: string }>> = {
  'deepseek-v4-flash': [
    { platform: 'andoryyu', modelId: 'deepseek-v4-flash' },
    { platform: 'opencode-zen', modelId: 'deepseek-v4-flash-free' },
    { platform: 'tokenharbor', modelId: 'deepseek-v4-flash:free' },
    { platform: 'opencode-go', modelId: 'deepseek-v4-flash' },
  ],
  // A provider-qualified :free ID must remain pinned to its provider. A
  // request for the generic deepseek-v4-flash ID may use the broader chain
  // above; this explicit ID must not silently become another model.
  'deepseek-v4-flash:free': [
    { platform: 'tokenharbor', modelId: 'deepseek-v4-flash:free' },
  ],
}

export const PROVIDER_FAILURE_POLICY: Record<string, {
  cooldownMs: number
  /** Cooldown escalado cuando el fallo es rate_limited (429) en vez de
   * transitorio. Pools con cuota diaria (opencode-zen ~4M tokens/día) agotan
   * la cuota: reintentarlos a los 5 min martillea un pool seco. */
  rateLimitCooldownMs?: number
  recordPenalty: boolean
  recordProviderFailure: boolean
}> = {
  // Proveedores gratuitos (andoryyu, opencode-zen): vale la pena reintentarlos
  // cada ~5 min. No acumulan penalty dinámico (recordPenalty:false) para que el
  // reintento sea determinista en primera pasada; la cadencia de 5 min la dan el
  // cooldown de key (cooldownMs) y el cooldown de proveedor (recordProviderFailure).
  // Mientras están en cooldown, opencode-go sirve sin interrumpir la ejecución.
  // andoryyu es un worker con pool de cuentas (cuota por sesión, límite exacto
  // desconocido): 5 min de cadencia es suficiente porque el worker rota cuentas
  // internamente y sus fallos son sobre todo 503 transitorios.
  andoryyu: { cooldownMs: 300_000, recordPenalty: false, recordProviderFailure: true },
  // opencode-zen: un 429 casi siempre es cuota diaria agotada (4M tokens/día).
  // Escalar a 4h evita martillar el pool y deja que opencode-go sirva mientras.
  'opencode-zen': { cooldownMs: 300_000, rateLimitCooldownMs: 4 * 60 * 60 * 1000, recordPenalty: false, recordProviderFailure: true },
  // TokenHarbor is a free gateway route; treat failures as transient and
  // avoid hammering the same key while the public pool recovers.
  tokenharbor: { cooldownMs: 300_000, recordPenalty: false, recordProviderFailure: true },
  // Proveedor de pago (opencode-go): último recurso casi nunca falla. Nunca se
  // penaliza (no se hunde en la cola), no entra en cooldown de proveedor y su
  // cooldown de key es 0: tras un fallo puntual se vuelve a intentar de inmediato
  // en el mismo request (la purga de skipKeys en el catch de routeRequest lo
  // rehabilita) para que la ejecución nunca se interrumpa por un fallo ajeno.
  'opencode-go': { cooldownMs: 0, recordPenalty: false, recordProviderFailure: false },
}

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
