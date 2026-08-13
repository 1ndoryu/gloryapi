import { getDb } from '../db/index.js';
import {
  REGISTRY_SCHEMA_VERSION,
  type CapabilityProfile,
  type ModelDefinition,
  type Platform,
  type ProviderAdapterKind,
  type ProviderDefinition,
  type RegistrySnapshot,
} from '@gloryapi/shared/types.js';

export const ACTIVE_PROVIDER_PLATFORMS = ['andoryyu', 'opencode-zen', 'tokenharbor', 'opencode-go', 'commandcode'] as const;
export const ARCHIVED_PROVIDER_PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface',
  'siliconflow', 'bluesminds', 'bazaarlink', 'hyperbolic', 'deepinfra',
  'scaleway', 'nebius', 'novita', 'morph', 'publicai', 'nousresearch',
  'reka', 'sensenova', 'puter', 'tokenrouter', 'bynara',
] as const;
export const KNOWN_PROVIDER_PLATFORMS = [
  ...ACTIVE_PROVIDER_PLATFORMS,
  ...ARCHIVED_PROVIDER_PLATFORMS,
] as const;

const activeCapabilities: CapabilityProfile = {
  streaming: true,
  tools: true,
  reasoning: true,
  multimodal: false,
  maxContextWindow: 131072,
};

// TokenHarbor is only enabled for the capabilities demonstrated by its
// OpenAI-compatible contract and the live health/chat checks. Tools,
// reasoning controls and context size stay fail-closed until separately
// verified against that provider.
const tokenharborCapabilities: CapabilityProfile = {
  streaming: true,
  tools: false,
  reasoning: false,
  multimodal: false,
  maxContextWindow: null,
};

export const ACTIVE_PROVIDER_DEFINITIONS: Array<Omit<ProviderDefinition, 'credentialCount'>> = [
  {
    platform: 'andoryyu',
    displayName: 'Andoryyu FreeBuff',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://andoryyu-freebuff2api.andoryyu.workers.dev',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
    // Timeout efectivo del upstream: 120 s. Los prompts grandes (Codex con
    // contexto enorme) tardan >15 s en recibir el primer chunk; con 15 s el
    // fetch abortaba y se clasificaba como request_timeout -> 429 recurrente.
    timeoutMs: 120_000,
  },
  {
    platform: 'opencode-zen',
    displayName: 'OpenCode Zen',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/v1',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
    timeoutMs: 120_000,
  },
  {
    platform: 'tokenharbor',
    displayName: 'TokenHarbor',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://tokenharbor.ai/v1',
    authScheme: 'bearer',
    capabilities: tokenharborCapabilities,
    timeoutMs: 120_000,
  },
  {
    platform: 'opencode-go',
    displayName: 'OpenCode Go',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
    timeoutMs: 120_000,
  },
  {
    platform: 'commandcode',
    displayName: 'CommandCode',
    lifecycle: 'active',
    enabled: true,
    adapter: 'openai-compatible',
    endpoint: 'https://api.commandcode.ai/provider/v1',
    authScheme: 'bearer',
    // CommandCode expone tanto modelos de texto (DeepSeek) como modelos con
    // visión nativa (Muse Spark 1.2). La capability `multimodal` se declara a
    // nivel de proveedor porque el endpoint acepta bloques image_url; el
    // bridge decide por modelo concreto si reenvía la imagen o la describe.
    capabilities: { ...activeCapabilities, multimodal: true },
    timeoutMs: 120_000,
  },
];

function archivedDisplayName(platform: string): string {
  return `${platform[0].toUpperCase()}${platform.slice(1)} (archived)`;
}

function archivedCapabilities(): CapabilityProfile {
  return {
    streaming: false,
    tools: false,
    reasoning: false,
    multimodal: false,
    maxContextWindow: null,
  };
}

export interface ProviderDraftInput {
  /** Draft slugs may be new; activation still requires a registered adapter. */
  platform: string;
  displayName: string;
  adapter: ProviderAdapterKind;
  endpoint: string;
  authScheme: 'bearer' | 'account-and-token';
  capabilities: CapabilityProfile;
}

export interface ProviderModelDraftInput {
  platform: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  capabilities: CapabilityProfile;
}

export function replaceProviderModelDrafts(platform: string, models: ProviderModelDraftInput[]): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM provider_model_drafts WHERE platform = ?').run(platform);
    const insert = db.prepare(`
      INSERT INTO provider_model_drafts (platform, model_id, display_name, context_window, capabilities_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const model of models) {
      insert.run(model.platform, model.modelId, model.displayName, model.contextWindow, JSON.stringify(model.capabilities));
    }
  })();
}

export function getProviderModelDrafts(platform: string): Array<Omit<ProviderModelDraftInput, 'platform'>> {
  const rows = getDb().prepare(`
    SELECT model_id, display_name, context_window, capabilities_json
    FROM provider_model_drafts WHERE platform = ? ORDER BY display_name, model_id
  `).all(platform) as Array<{ model_id: string; display_name: string; context_window: number | null; capabilities_json: string }>;
  return rows.map(row => ({
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    capabilities: JSON.parse(row.capabilities_json) as CapabilityProfile,
  }));
}

export function isActiveProviderPlatform(platform: string): boolean {
  return (ACTIVE_PROVIDER_PLATFORMS as readonly string[]).includes(platform);
}

export function getRegistrySnapshot(): RegistrySnapshot {
  const db = getDb();
  const runtimeRows = db.prepare('SELECT platform, enabled FROM provider_runtime_state').all() as Array<{ platform: string; enabled: number }>;
  const runtimeMap = new Map(runtimeRows.map(row => [row.platform, row.enabled === 1]));
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) AS count
    FROM api_keys
    GROUP BY platform
  `).all() as Array<{ platform: string; count: number }>;
  const keyCountMap = new Map(keyCounts.map(row => [row.platform, row.count]));

  const providers: ProviderDefinition[] = ACTIVE_PROVIDER_DEFINITIONS.map(provider => ({
    ...provider,
    enabled: runtimeMap.get(provider.platform) ?? true,
    credentialCount: keyCountMap.get(provider.platform) ?? 0,
  }));
  for (const platform of ARCHIVED_PROVIDER_PLATFORMS) {
    const credentialCount = keyCountMap.get(platform) ?? 0;
    if (credentialCount === 0) continue;
    providers.push({
      platform,
      displayName: archivedDisplayName(platform),
      lifecycle: 'archived',
      enabled: false,
      adapter: 'openai-compatible',
      endpoint: '',
      authScheme: 'bearer',
      capabilities: archivedCapabilities(),
      credentialCount,
    });
  }

  const draftRows = db.prepare(`
    SELECT platform, display_name, adapter, endpoint, auth_scheme, capabilities_json
    FROM provider_registry
    WHERE lifecycle = 'draft'
    ORDER BY created_at ASC
  `).all() as Array<{
    platform: string;
    display_name: string;
    adapter: string;
    endpoint: string;
    auth_scheme: string;
    capabilities_json: string;
  }>;
  for (const draft of draftRows) {
    const existingIndex = providers.findIndex(provider => provider.platform === draft.platform);
    if (existingIndex >= 0) providers.splice(existingIndex, 1);
    let capabilities = archivedCapabilities();
    try {
      const parsed: unknown = JSON.parse(draft.capabilities_json);
      if (isCapabilityProfile(parsed)) capabilities = parsed;
    } catch {
      // Malformed persisted definitions remain visible as an inert draft.
    }
    providers.push({
      platform: draft.platform as Platform,
      displayName: draft.display_name,
      lifecycle: 'draft',
      enabled: runtimeMap.get(draft.platform) ?? false,
      adapter: draft.adapter as ProviderAdapterKind,
      endpoint: draft.endpoint,
      authScheme: draft.auth_scheme as ProviderDefinition['authScheme'],
      capabilities,
      credentialCount: keyCountMap.get(draft.platform) ?? 0,
    });
  }

  const capabilityByPlatform = new Map(providers.map(provider => [provider.platform, provider.capabilities]));
  const rows = db.prepare(`
    SELECT platform, model_id, display_name, enabled, context_window
    FROM models
    ORDER BY intelligence_rank ASC, speed_rank ASC, id ASC
  `).all() as Array<{
    platform: string;
    model_id: string;
    display_name: string;
    enabled: number;
    context_window: number | null;
  }>;
  const models: ModelDefinition[] = rows.map(row => {
    const providerCapabilities = capabilityByPlatform.get(row.platform as Platform) ?? activeCapabilities;
    return {
      platform: row.platform as Platform,
      modelId: row.model_id,
      displayName: row.display_name,
      enabled: row.enabled === 1,
      contextWindow: row.context_window,
      capabilities: {
        ...providerCapabilities,
        // A null provider limit is intentional: do not infer an unverified
        // context window from catalog metadata for fail-closed providers.
        maxContextWindow: providerCapabilities.maxContextWindow === null
          ? null
          : (row.context_window ?? providerCapabilities.maxContextWindow),
      },
    };
  });

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    providers,
    models,
  };
}

function isCapabilityProfile(value: unknown): value is CapabilityProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.streaming === 'boolean'
    && typeof candidate.tools === 'boolean'
    && typeof candidate.reasoning === 'boolean'
    && typeof candidate.multimodal === 'boolean'
    && (candidate.maxContextWindow === null || typeof candidate.maxContextWindow === 'number');
}

export function saveProviderDraft(input: ProviderDraftInput): void {
  const db = getDb();
  const existing = db.prepare('SELECT lifecycle FROM provider_registry WHERE platform = ?').get(input.platform) as { lifecycle: string } | undefined;
  if (existing?.lifecycle === 'active') throw new Error('Active provider definitions cannot be replaced by a draft');
  db.prepare(`
    INSERT INTO provider_registry (
      platform, display_name, lifecycle, adapter, endpoint, auth_scheme, capabilities_json,
      health_verified_at, chat_verified_at, capabilities_verified_at, updated_at
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, NULL, NULL, NULL, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET
      display_name = excluded.display_name,
      lifecycle = 'draft',
      adapter = excluded.adapter,
      endpoint = excluded.endpoint,
      auth_scheme = excluded.auth_scheme,
      capabilities_json = excluded.capabilities_json,
      health_verified_at = NULL,
      chat_verified_at = NULL,
      capabilities_verified_at = NULL,
      updated_at = datetime('now')
  `).run(
    input.platform,
    input.displayName,
    input.adapter,
    input.endpoint,
    input.authScheme,
    JSON.stringify(input.capabilities),
  );
  db.prepare(`
    INSERT INTO provider_runtime_state (platform, enabled, updated_at) VALUES (?, 0, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET enabled = 0, updated_at = datetime('now')
  `).run(input.platform);
}

export function setProviderEnabled(platform: string, enabled: boolean): void {
  if (!isActiveProviderPlatform(platform)) throw new Error('Only an active provider can be toggled');
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_runtime_state (platform, enabled, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(platform) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')
    `).run(platform, enabled ? 1 : 0);
    db.prepare(`UPDATE fallback_config SET enabled = ? WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)`)
      .run(enabled ? 1 : 0, platform);
  })();
}

export function removeProviderDraft(platform: string): boolean {
  const result = getDb().prepare("DELETE FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'").run(platform);
  return result.changes > 0;
}
