// ---- Platform & Model Types ----

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
// Moonshot and MiniMax direct integrations were dropped in migrateModelsV4
// (see server/src/db/index.ts). HuggingFace was dropped in V4 and re-added
// in V13 via the router.huggingface.co Inference Providers meta-router.
export type Platform =
  | 'google'
  | 'groq'
  | 'cerebras'
  | 'sambanova'
  | 'nvidia'
  | 'mistral'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'zhipu'
  | 'ollama'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'huggingface'
  | 'opencode-zen'
  | 'opencode-go'
  | 'commandcode'
  // New free providers added 2026-07-20
  | 'siliconflow'
  | 'bluesminds'
  | 'bazaarlink'
  | 'hyperbolic'
  | 'deepinfra'
  | 'scaleway'
  | 'nebius'
  | 'novita'
  | 'morph'
  | 'publicai'
  | 'nousresearch'
  | 'reka'
  | 'sensenova'
  | 'puter'
  // Added 2026-07-20
  | 'tokenrouter'
  | 'bynara'
  | 'andoryyu';

export const REGISTRY_SCHEMA_VERSION = 'glory-registry-v1' as const;

export type ProviderLifecycle = 'active' | 'archived' | 'draft';
export type ProviderAdapterKind = 'openai-compatible' | 'google-gemini' | 'cohere' | 'cloudflare-workers-ai';

export interface CapabilityProfile {
  streaming: boolean;
  tools: boolean;
  reasoning: boolean;
  multimodal: boolean;
  maxContextWindow: number | null;
}

export interface CredentialRef {
  platform: Platform;
  fingerprint: string;
  label?: string;
  status?: KeyStatus;
}

export interface ProviderDefinition {
  platform: Platform;
  displayName: string;
  lifecycle: ProviderLifecycle;
  enabled: boolean;
  adapter: ProviderAdapterKind;
  endpoint: string;
  authScheme: 'bearer' | 'account-and-token';
  capabilities: CapabilityProfile;
  credentialCount: number;
}

export interface ModelDefinition {
  platform: Platform;
  modelId: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number | null;
  capabilities: CapabilityProfile;
}

export interface RegistrySnapshot {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  providers: ProviderDefinition[];
  models: ModelDefinition[];
}

export const SETTINGS_SCHEMA_VERSION = 'glory-settings-v1' as const;

export type SettingPrimitive = boolean | number | string;
export type SettingValueType = 'boolean' | 'integer' | 'number' | 'duration-ms' | 'string';
export type SettingScope = 'routing' | 'health' | 'provider' | 'logging' | 'security';

export interface SettingDefinition {
  key: string;
  type: SettingValueType;
  defaultValue: SettingPrimitive;
  min?: number;
  max?: number;
  description: string;
  scope: SettingScope;
  sensitive: boolean;
  requiresRestart: boolean;
}

export interface SettingValue extends SettingDefinition {
  value: SettingPrimitive;
}

export interface SettingsSnapshot {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  revision: number;
  settings: SettingValue[];
}

export interface CapabilityOverrides {
  streaming?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  multimodal?: boolean;
  maxContextWindow?: number | null;
}

export interface ProviderSettingsOverrides {
  baseUrl?: string;
  timeoutMs?: number;
  authScheme?: 'bearer' | 'account-and-token';
  capabilities?: CapabilityOverrides;
}

export interface ModelSettingsOverrides {
  alias?: string;
  timeoutMs?: number;
  capabilities?: CapabilityOverrides;
}

export type SettingValueSource = 'default' | 'provider' | 'model';

export interface EffectiveProviderSettings {
  baseUrl: string;
  timeoutMs: number;
  authScheme: 'bearer' | 'account-and-token';
  capabilities: CapabilityProfile;
  sources: {
    baseUrl: SettingValueSource;
    timeoutMs: SettingValueSource;
    authScheme: SettingValueSource;
    capabilities: SettingValueSource;
  };
}

export interface EffectiveModelSettings {
  alias: string | null;
  timeoutMs: number;
  capabilities: CapabilityProfile;
  sources: {
    alias: SettingValueSource;
    timeoutMs: SettingValueSource;
    capabilities: SettingValueSource;
  };
}

export interface ProviderSettingsEntry {
  platform: Platform;
  lifecycle: ProviderLifecycle;
  providerOverrides: ProviderSettingsOverrides;
  effective: EffectiveProviderSettings;
  models: Array<{
    modelId: string;
    displayName: string;
    overrides: ModelSettingsOverrides;
    effective: EffectiveModelSettings;
  }>;
}

export interface ProviderSettingsSnapshot {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  revision: number;
  providers: ProviderSettingsEntry[];
}

export const ROUTING_SCHEMA_VERSION = 'glory-routing-v1' as const;

export interface RoutingPolicyEntry {
  modelDbId: number;
  priority: number;
  enabled: boolean;
}

export interface RoutingRuntimeModel {
  attemptId: string;
  modelDbId: number;
  platform: Platform;
  modelId: string;
  startedAt: string;
}

export interface RoutingRuntimeCompletion {
  modelDbId: number;
  platform: Platform;
  modelId: string;
  completedAt: string;
}

export interface RoutingRuntimeSnapshot {
  schemaVersion: 'glory-routing-runtime-v1';
  inFlight: RoutingRuntimeModel[];
  lastCompleted: RoutingRuntimeCompletion | null;
}

export type RoutingTraceStatus = 'completed' | 'failed';
export type RoutingTraceAttemptOutcome = 'success' | 'error' | 'rejected';

export interface RoutingTraceAttempt {
  platform: Platform;
  modelId: string;
  outcome: RoutingTraceAttemptOutcome;
  reason: string | null;
  durationMs: number;
}

export interface RoutingTraceSnapshot {
  schemaVersion: 'glory-routing-trace-v1';
  traceId: string;
  status: RoutingTraceStatus;
  startedAt: string;
  completedAt: string;
  attempts: RoutingTraceAttempt[];
  finalModel: { platform: Platform; modelId: string } | null;
}

export interface RoutingPolicySnapshot {
  schemaVersion: typeof ROUTING_SCHEMA_VERSION;
  revision: number;
  entries: RoutingPolicyEntry[];
  runtime?: RoutingRuntimeSnapshot;
}

export interface ModelIdentity {
  id: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  sizeLabel: string;
}

export interface ModelRanking {
  intelligenceRank: number;
  speedRank: number;
}

export interface ModelLimits {
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  contextWindow: number | null;
}

export interface Model extends ModelIdentity, ModelRanking, ModelLimits {
  enabled: boolean;
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
}
export type {
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionOptions,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatContent,
  ChatContentBlock,
  ChatMessage,
  ChatToolCall,
  ChatToolCallFunction,
  ChatToolChoice,
  ChatToolDefinition,
  ChatToolFunctionDefinition,
  TokenUsage,
} from './chat-types.js';

export type {
  AnalyticsSummary,
  PlatformStats,
  RateLimitStatus,
  RequestLog,
  TimelinePoint,
} from './analytics-types.js';
