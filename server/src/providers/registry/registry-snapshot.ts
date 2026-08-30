import { getDb } from '../../db/index.js';
import { getConfiguredProviders } from '../../services/provider-configuration.js';
import {
  REGISTRY_SCHEMA_VERSION,
  type CapabilityProfile,
  type ModelDefinition,
  type Platform,
  type ProviderAdapterKind,
  type ProviderDefinition,
  type RegistrySnapshot,
} from '@gloryapi/shared/types.js';

import {
  ACTIVE_PROVIDER_DEFINITIONS,
  ARCHIVED_PROVIDER_PLATFORMS,
  activeCapabilities,
} from './provider-definitions.js';

// Construcción del snapshot del registro, extraída de registry.ts para mantener
// ese módulo bajo el límite de líneas (un hallazgo limite-lineas-* real). Solo
// proviene de lecturas; la mutación del registro sigue viviendo en registry.ts.

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

function isCapabilityProfile(value: unknown): value is CapabilityProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.streaming === 'boolean'
    && typeof candidate.tools === 'boolean'
    && typeof candidate.reasoning === 'boolean'
    && typeof candidate.multimodal === 'boolean'
    && (candidate.maxContextWindow === null || typeof candidate.maxContextWindow === 'number');
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
  // The compiled definitions are bootstrap compatibility only. Operational
  // values come from configuration_providers so a new OpenAI-compatible
  // provider can be added without changing this registry.
  let configuredProviders: ReturnType<typeof getConfiguredProviders> = [];
  try { configuredProviders = getConfiguredProviders(db); } catch { configuredProviders = []; }
  for (const configured of configuredProviders) {
    const provider = {
      platform: configured.platform as Platform,
      displayName: configured.displayName,
      lifecycle: configured.lifecycle,
      enabled: configured.enabled,
      adapter: configured.adapter,
      endpoint: configured.endpoint,
      authScheme: configured.authScheme,
      capabilities: configured.capabilities,
      timeoutMs: configured.timeoutMs,
      credentialCount: keyCountMap.get(configured.platform) ?? 0,
    } satisfies ProviderDefinition;
    const existingIndex = providers.findIndex(candidate => candidate.platform === configured.platform);
    if (existingIndex >= 0) providers[existingIndex] = provider;
    else providers.push(provider);
  }
  for (const platform of ARCHIVED_PROVIDER_PLATFORMS) {
    const credentialCount = keyCountMap.get(platform) ?? 0;
    if (credentialCount === 0) continue;
    // A platform can be both a runtime-configured active provider AND a legacy
    // archived slug (e.g. NVIDIA re-added and activated after archiving). The
    // live configuration wins: keep the active entry and do not append the
    // archived stand-in, so downstream lookups (capabilityByPlatform, model
    // capability inheritance) see a single, non-fail-closed definition.
    if (providers.some(provider => provider.platform === platform)) continue;
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
    SELECT platform, model_id, display_name, enabled, context_window,
           native_vision, supports_reasoning, capabilities_explicit
    FROM models
    ORDER BY intelligence_rank ASC, speed_rank ASC, id ASC
  `).all() as Array<{
    platform: string;
    model_id: string;
    display_name: string;
    enabled: number;
    context_window: number | null;
    native_vision: number;
    supports_reasoning: number;
    capabilities_explicit: number;
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
        // Model-level capability flags are the durable source of truth. A
        // provider may accept a feature while one of its models does not.
        multimodal: row.capabilities_explicit === 1 ? row.native_vision === 1 : providerCapabilities.multimodal,
        reasoning: row.capabilities_explicit === 1 ? row.supports_reasoning === 1 : providerCapabilities.reasoning,
        // A null provider limit is intentional: do not infer an unverified
        // context window from catalog metadata for fail-closed providers.
        // `contextWindow` is the bridge's compaction ceiling. Keep the
        // provider guarantee fail-closed and separate so publishing 150k to
        // Codex Desktop cannot silently upgrade an upstream that only
        // guarantees a smaller physical window.
        maxContextWindow: providerCapabilities.maxContextWindow === null
          ? null
          : Math.min(row.context_window ?? providerCapabilities.maxContextWindow, providerCapabilities.maxContextWindow),
      },
    };
  });

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    providers,
    models,
  };
}