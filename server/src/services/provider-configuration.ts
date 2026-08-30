import type Database from 'better-sqlite3';
import type { CapabilityProfile, ProviderAdapterKind, ProviderLifecycle } from '@gloryapi/shared/types.js';

export type ProviderMessageProfile = 'none' | 'null-assistant' | 'deepseek-thinking';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface ProviderTransportOptions {
  messageProfile: ProviderMessageProfile;
  includeStreamUsage: boolean;
  bufferUntilContent: boolean;
  bufferUntilDone: boolean;
  maxReasoningEffort: ReasoningEffort;
  modelAliases: Record<string, string>;
  modelReasoningLimits: Record<string, ReasoningEffort>;
  extraHeadersProfile: 'none' | 'openrouter';
}

export interface ProviderFailurePolicy {
  cooldownMs: number;
  rateLimitCooldownMs?: number;
  recordPenalty: boolean;
  recordProviderFailure: boolean;
}

/* [por que] ISP (large-interface-isp): ConfiguredProvider tenia 11 campos en una
 * sola interfaz. Se separan identidad, conexion y comportamiento para que cada
 * consumidor dependa solo del subcontrato que usa; ConfiguredProvider se
 * conserva como interseccion (misma API) para no romper a los consumidores. */
export interface ProviderIdentity {
  platform: string;
  displayName: string;
  lifecycle: ProviderLifecycle;
  adapter: ProviderAdapterKind;
  enabled: boolean;
}

export interface ProviderConnection {
  endpoint: string;
  authScheme: 'bearer' | 'account-and-token';
  timeoutMs: number;
}

export interface ProviderBehavior {
  capabilities: CapabilityProfile;
  transport: ProviderTransportOptions;
  failurePolicy: ProviderFailurePolicy;
}

export type ConfiguredProvider = ProviderIdentity & ProviderConnection & ProviderBehavior;

const DEFAULT_CAPABILITIES: CapabilityProfile = {
  streaming: true,
  tools: true,
  reasoning: true,
  multimodal: false,
  maxContextWindow: 131072,
};

const DEEPSEEK_THINKING_TRANSPORT: ProviderTransportOptions = {
  messageProfile: 'deepseek-thinking',
  includeStreamUsage: false,
  bufferUntilContent: false,
  bufferUntilDone: false,
  maxReasoningEffort: 'max',
  modelAliases: {},
  modelReasoningLimits: { mimo: 'high', minimax: 'high' },
  extraHeadersProfile: 'none',
};

const DEFAULT_FAILURE_POLICY: ProviderFailurePolicy = {
  cooldownMs: 300000,
  recordPenalty: false,
  recordProviderFailure: true,
};

/**
 * These rows are bootstrap data for an empty/legacy database, not a runtime
 * allowlist. Once inserted, the database owns the provider lifecycle and all
 * subsequent edits go through ConfigurationService.
 */
const BOOTSTRAP_PROVIDERS: Array<Omit<ConfiguredProvider, 'enabled'>> = [
  {
    platform: 'andoryyu',
    displayName: 'Andoryyu FreeBuff',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://andoryyu-freebuff2api.andoryyu.workers.dev',
    authScheme: 'bearer',
    timeoutMs: 120000,
    capabilities: { ...DEFAULT_CAPABILITIES },
    transport: {
      ...DEEPSEEK_THINKING_TRANSPORT,
      bufferUntilDone: true,
      modelAliases: { 'deepseek-v4-flash': 'deepseek/deepseek-v4-flash' },
    },
    failurePolicy: { ...DEFAULT_FAILURE_POLICY },
  },
  {
    platform: 'opencode-zen',
    displayName: 'OpenCode Zen',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/v1',
    authScheme: 'bearer',
    timeoutMs: 120000,
    capabilities: { ...DEFAULT_CAPABILITIES },
    transport: { ...DEEPSEEK_THINKING_TRANSPORT },
    failurePolicy: { ...DEFAULT_FAILURE_POLICY, rateLimitCooldownMs: 14400000 },
  },
  {
    platform: 'tokenharbor',
    displayName: 'TokenHarbor',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://tokenharbor.ai/v1',
    authScheme: 'bearer',
    timeoutMs: 120000,
    capabilities: { streaming: true, tools: false, reasoning: false, multimodal: false, maxContextWindow: null },
    transport: {
      ...DEEPSEEK_THINKING_TRANSPORT,
      modelAliases: { 'deepseek-v4-flash:free': 'deepseek-v4-flash' },
    },
    failurePolicy: { ...DEFAULT_FAILURE_POLICY },
  },
  {
    platform: 'opencode-go',
    displayName: 'OpenCode Go',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authScheme: 'bearer',
    timeoutMs: 120000,
    capabilities: { ...DEFAULT_CAPABILITIES },
    transport: { ...DEEPSEEK_THINKING_TRANSPORT },
    failurePolicy: { cooldownMs: 0, recordPenalty: false, recordProviderFailure: false },
  },
  {
    platform: 'commandcode',
    displayName: 'CommandCode',
    lifecycle: 'active',
    adapter: 'openai-compatible',
    endpoint: 'https://api.commandcode.ai/provider/v1',
    authScheme: 'bearer',
    timeoutMs: 120000,
    capabilities: { ...DEFAULT_CAPABILITIES, multimodal: true },
    transport: {
      messageProfile: 'none',
      includeStreamUsage: true,
      bufferUntilContent: false,
      bufferUntilDone: false,
      maxReasoningEffort: 'max',
      modelAliases: {},
      modelReasoningLimits: {},
      extraHeadersProfile: 'none',
    },
    failurePolicy: { cooldownMs: 30000, rateLimitCooldownMs: 120000, recordPenalty: false, recordProviderFailure: true },
  },
];

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeCapabilities(value: unknown): CapabilityProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_CAPABILITIES };
  const candidate = value as Partial<CapabilityProfile>;
  return {
    streaming: candidate.streaming === true,
    tools: candidate.tools === true,
    reasoning: candidate.reasoning === true,
    multimodal: candidate.multimodal === true,
    maxContextWindow: candidate.maxContextWindow === null || typeof candidate.maxContextWindow === 'number'
      ? candidate.maxContextWindow
      : null,
  };
}

function normalizeTransport(value: unknown): ProviderTransportOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEEPSEEK_THINKING_TRANSPORT };
  const candidate = value as Partial<ProviderTransportOptions>;
  const effort = ['low', 'medium', 'high', 'max'].includes(String(candidate.maxReasoningEffort))
    ? candidate.maxReasoningEffort as ReasoningEffort
    : 'high';
  return {
    messageProfile: candidate.messageProfile === 'null-assistant' || candidate.messageProfile === 'deepseek-thinking'
      ? candidate.messageProfile
      : 'none',
    includeStreamUsage: candidate.includeStreamUsage === true,
    bufferUntilContent: candidate.bufferUntilContent === true,
    bufferUntilDone: candidate.bufferUntilDone === true,
    maxReasoningEffort: effort,
    modelAliases: candidate.modelAliases && typeof candidate.modelAliases === 'object' ? candidate.modelAliases as Record<string, string> : {},
    modelReasoningLimits: candidate.modelReasoningLimits && typeof candidate.modelReasoningLimits === 'object'
      ? candidate.modelReasoningLimits as Record<string, ReasoningEffort>
      : {},
    extraHeadersProfile: candidate.extraHeadersProfile === 'openrouter' ? 'openrouter' : 'none',
  };
}

function normalizeFailurePolicy(value: unknown): ProviderFailurePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_FAILURE_POLICY };
  const candidate = value as Partial<ProviderFailurePolicy>;
  const cooldownMs = typeof candidate.cooldownMs === 'number' && Number.isInteger(candidate.cooldownMs) && candidate.cooldownMs >= 0
    ? candidate.cooldownMs
    : DEFAULT_FAILURE_POLICY.cooldownMs;
  const rateLimitCooldownMs = typeof candidate.rateLimitCooldownMs === 'number' && Number.isInteger(candidate.rateLimitCooldownMs) && candidate.rateLimitCooldownMs >= 0
    ? candidate.rateLimitCooldownMs
    : undefined;
  return {
    cooldownMs,
    ...(rateLimitCooldownMs === undefined ? {} : { rateLimitCooldownMs }),
    recordPenalty: candidate.recordPenalty === true,
    recordProviderFailure: candidate.recordProviderFailure !== false,
  };
}

export function ensureProviderConfiguration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuration_providers (
      platform TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived', 'draft')),
      adapter TEXT NOT NULL CHECK (adapter IN ('openai-compatible', 'google-gemini', 'cohere', 'cloudflare-workers-ai')),
      endpoint TEXT NOT NULL,
      auth_scheme TEXT NOT NULL CHECK (auth_scheme IN ('bearer', 'account-and-token')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      timeout_ms INTEGER NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 1000 AND 300000),
      capabilities_json TEXT NOT NULL,
      transport_json TEXT NOT NULL,
      failure_policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_configuration_providers_enabled ON configuration_providers(enabled, lifecycle);
  `);

  const insert = db.prepare(`
    INSERT INTO configuration_providers (
      platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled,
      timeout_ms, capabilities_json, transport_json, failure_policy_json
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(platform) DO NOTHING
  `);
  for (const provider of BOOTSTRAP_PROVIDERS) {
    insert.run(
      provider.platform,
      provider.displayName,
      provider.lifecycle,
      provider.adapter,
      provider.endpoint,
      provider.authScheme,
      provider.timeoutMs,
      json(provider.capabilities),
      json(provider.transport),
      json(provider.failurePolicy),
    );
  }

  // Backfill fields added after the first V2 rollout without overwriting any
  // value already managed by the user. This keeps old databases compatible
  // with the dynamic adapter while preserving their transport choices.
  const existingTransport = db.prepare('SELECT platform, transport_json FROM configuration_providers').all() as Array<{ platform: string; transport_json: string }>;
  for (const row of existingTransport) {
    const bootstrap = BOOTSTRAP_PROVIDERS.find(provider => provider.platform === row.platform);
    if (!bootstrap) continue;
    const current = parseJson<Record<string, unknown>>(row.transport_json, {});
    let changed = false;
    for (const key of ['bufferUntilContent', 'bufferUntilDone']) {
      if (!Object.hasOwn(current, key)) {
        current[key] = bootstrap.transport[key as 'bufferUntilContent' | 'bufferUntilDone'];
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE configuration_providers SET transport_json = ?, updated_at = datetime(\'now\') WHERE platform = ?').run(json(current), row.platform);
  }
}

function mapProvider(row: {
  platform: string;
  display_name: string;
  lifecycle: ProviderLifecycle;
  adapter: ProviderAdapterKind;
  endpoint: string;
  auth_scheme: 'bearer' | 'account-and-token';
  enabled: number;
  timeout_ms: number;
  capabilities_json: string;
  transport_json: string;
  failure_policy_json: string;
}): ConfiguredProvider {
  return {
    platform: row.platform,
    displayName: row.display_name,
    lifecycle: row.lifecycle,
    adapter: row.adapter,
    endpoint: row.endpoint,
    authScheme: row.auth_scheme,
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms,
    capabilities: normalizeCapabilities(parseJson(row.capabilities_json, DEFAULT_CAPABILITIES)),
    transport: normalizeTransport(parseJson(row.transport_json, DEEPSEEK_THINKING_TRANSPORT)),
    failurePolicy: normalizeFailurePolicy(parseJson(row.failure_policy_json, DEFAULT_FAILURE_POLICY)),
  };
}

export function getConfiguredProviders(db: Database.Database): ConfiguredProvider[] {
  const rows = db.prepare(`
    SELECT platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled,
           timeout_ms, capabilities_json, transport_json, failure_policy_json
    FROM configuration_providers ORDER BY platform
  `).all() as Parameters<typeof mapProvider>[0][];
  return rows.map(mapProvider);
}

export function getConfiguredProviderFromDb(db: Database.Database, platform: string): ConfiguredProvider | undefined {
  const row = db.prepare(`
    SELECT platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled,
           timeout_ms, capabilities_json, transport_json, failure_policy_json
    FROM configuration_providers WHERE platform = ?
  `).get(platform) as Parameters<typeof mapProvider>[0] | undefined;
  return row ? mapProvider(row) : undefined;
}

export { BOOTSTRAP_PROVIDERS, DEFAULT_CAPABILITIES, DEFAULT_FAILURE_POLICY };
