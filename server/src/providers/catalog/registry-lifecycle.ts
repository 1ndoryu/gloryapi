import { getDb } from '../../db/index.js'
import { ACTIVE_PROVIDER_DEFINITIONS, isActiveProviderPlatform } from '../registry.js'
import { getConfiguredProviderFromDb } from '../../services/provider-configuration.js'
import { materializeConfigurationModels, updateConfigurationProvider } from '../../services/configuration-v2.js'
import { getProviderModelDrafts } from '../registry.js'

export type ProviderVerification = 'health' | 'chat' | 'capabilities'

export function recordProviderVerification(platform: string, verification: ProviderVerification): void {
  const column: Record<ProviderVerification, string> = {
    health: 'health_verified_at',
    chat: 'chat_verified_at',
    capabilities: 'capabilities_verified_at',
  }
  const row = getDb().prepare("SELECT lifecycle FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'").get(platform)
  if (!row) throw new Error('Provider draft not found')
  getDb().prepare(`UPDATE provider_registry SET ${column[verification]} = datetime('now'), updated_at = datetime('now') WHERE platform = ?`).run(platform)
}

export function activateProviderDraft(platform: string): void {
  const row = getDb().prepare(`
    SELECT lifecycle, health_verified_at, chat_verified_at, capabilities_verified_at
    FROM provider_registry WHERE platform = ?
  `).get(platform) as {
    lifecycle: string
    health_verified_at: string | null
    chat_verified_at: string | null
    capabilities_verified_at: string | null
  } | undefined
  if (!row || row.lifecycle !== 'draft') throw new Error('Provider draft not found')
  if (!row.health_verified_at || !row.chat_verified_at || !row.capabilities_verified_at) {
    throw new Error('Provider activation requires health, chat, and capabilities verification')
  }
  const configured = getConfiguredProviderFromDb(getDb(), platform)
  if (configured) {
    if (configured.adapter !== 'openai-compatible') throw new Error('Provider adapter is not registered for operational activation')
    materializeConfigurationModels(
      platform,
      getProviderModelDrafts(platform).map(model => ({
        modelId: model.modelId,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        nativeVision: model.capabilities.multimodal,
        supportsReasoning: model.capabilities.reasoning,
      })),
      { actor: 'registry-api', source: 'provider-model-selection' },
    )
    updateConfigurationProvider(platform, { lifecycle: 'active', enabled: true, actor: 'registry-api', source: 'provider-activation' })
  } else if (!isActiveProviderPlatform(platform)) throw new Error('Provider adapter is not registered for operational activation')
  const definition = ACTIVE_PROVIDER_DEFINITIONS.find(candidate => candidate.platform === platform)
  const draft = getDb().prepare('SELECT adapter, endpoint FROM provider_registry WHERE platform = ?').get(platform) as { adapter: string; endpoint: string } | undefined
  if (!configured && (!definition || !draft || draft.adapter !== definition.adapter || draft.endpoint !== definition.endpoint)) {
    throw new Error('Provider definition does not match the registered adapter')
  }
  getDb().prepare("UPDATE provider_registry SET lifecycle = 'active', updated_at = datetime('now') WHERE platform = ?").run(platform)
  getDb().prepare(`
    INSERT INTO provider_runtime_state (platform, enabled, updated_at) VALUES (?, 1, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET enabled = 1, updated_at = datetime('now')
  `).run(platform)
}
