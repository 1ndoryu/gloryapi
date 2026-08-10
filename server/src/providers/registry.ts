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

export const ACTIVE_PROVIDER_PLATFORMS = ['andoryyu', 'opencode-zen', 'opencode-go'] as const;
export const ARCHIVED_PROVIDER_PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'commandcode',
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

export const ACTIVE_PROVIDER_DEFINITIONS: Array<Omit<ProviderDefinition, 'credentialCount'>> = [
  {
    platform: 'andoryyu',
    displayName: 'Andoryyu FreeBuff',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://andoryyu-freebuff2api.andoryyu.workers.dev',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
  },
  {
    platform: 'opencode-zen',
    displayName: 'OpenCode Zen',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/v1',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
  },
  {
    platform: 'opencode-go',
    displayName: 'OpenCode Go',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authScheme: 'bearer',
    capabilities: activeCapabilities,
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
  platform: Platform;
  displayName: string;
  adapter: ProviderAdapterKind;
  endpoint: string;
  authScheme: 'bearer' | 'account-and-token';
  capabilities: CapabilityProfile;
}

export function isActiveProviderPlatform(platform: string): boolean {
  return (ACTIVE_PROVIDER_PLATFORMS as readonly string[]).includes(platform);
}

export function getRegistrySnapshot(): RegistrySnapshot {
  const db = getDb();
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) AS count
    FROM api_keys
    GROUP BY platform
  `).all() as Array<{ platform: string; count: number }>;
  const keyCountMap = new Map(keyCounts.map(row => [row.platform, row.count]));

  const providers: ProviderDefinition[] = ACTIVE_PROVIDER_DEFINITIONS.map(provider => ({
    ...provider,
    credentialCount: keyCountMap.get(provider.platform) ?? 0,
  }));
  for (const platform of ARCHIVED_PROVIDER_PLATFORMS) {
    const credentialCount = keyCountMap.get(platform) ?? 0;
    if (credentialCount === 0) continue;
    providers.push({
      platform,
      displayName: archivedDisplayName(platform),
      lifecycle: 'archived',
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
      adapter: draft.adapter as ProviderAdapterKind,
      endpoint: draft.endpoint,
      authScheme: draft.auth_scheme as ProviderDefinition['authScheme'],
      capabilities,
      credentialCount: keyCountMap.get(draft.platform) ?? 0,
    });
  }

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
  const models: ModelDefinition[] = rows.map(row => ({
    platform: row.platform as Platform,
    modelId: row.model_id,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    contextWindow: row.context_window,
    capabilities: {
      ...activeCapabilities,
      maxContextWindow: row.context_window,
    },
  }));

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
}

export function removeProviderDraft(platform: string): boolean {
  const result = getDb().prepare("DELETE FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'").run(platform);
  return result.changes > 0;
}

export type ProviderVerification = 'health' | 'chat' | 'capabilities';

export function recordProviderVerification(platform: string, verification: ProviderVerification): void {
  const column: Record<ProviderVerification, string> = {
    health: 'health_verified_at',
    chat: 'chat_verified_at',
    capabilities: 'capabilities_verified_at',
  };
  const row = getDb().prepare("SELECT lifecycle FROM provider_registry WHERE platform = ? AND lifecycle = 'draft'").get(platform);
  if (!row) throw new Error('Provider draft not found');
  getDb().prepare(`UPDATE provider_registry SET ${column[verification]} = datetime('now'), updated_at = datetime('now') WHERE platform = ?`).run(platform);
}

export function activateProviderDraft(platform: string): void {
  const row = getDb().prepare(`
    SELECT lifecycle, health_verified_at, chat_verified_at, capabilities_verified_at
    FROM provider_registry WHERE platform = ?
  `).get(platform) as {
    lifecycle: string;
    health_verified_at: string | null;
    chat_verified_at: string | null;
    capabilities_verified_at: string | null;
  } | undefined;
  if (!row || row.lifecycle !== 'draft') throw new Error('Provider draft not found');
  if (!row.health_verified_at || !row.chat_verified_at || !row.capabilities_verified_at) {
    throw new Error('Provider activation requires health, chat, and capabilities verification');
  }
  if (!isActiveProviderPlatform(platform)) {
    throw new Error('Provider adapter is not registered for operational activation');
  }
  const definition = ACTIVE_PROVIDER_DEFINITIONS.find(candidate => candidate.platform === platform);
  const draft = getDb().prepare('SELECT adapter, endpoint FROM provider_registry WHERE platform = ?').get(platform) as { adapter: string; endpoint: string } | undefined;
  if (!definition || !draft || draft.adapter !== definition.adapter || draft.endpoint !== definition.endpoint) {
    throw new Error('Provider definition does not match the registered adapter');
  }
  getDb().prepare("UPDATE provider_registry SET lifecycle = 'active', updated_at = datetime('now') WHERE platform = ?").run(platform);
}
