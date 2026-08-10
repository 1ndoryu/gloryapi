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

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: {
      name: string;
    };
  };

// OpenAI's multimodal envelope: clients like opencode / continue.dev send
// content as an array of typed blocks even for text-only messages. We accept
// it on the wire and flatten to string for providers that don't support it
// (Cohere, Cloudflare). See server/src/lib/content.ts.
export type ChatContentBlock = { type: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  reasoning_content?: string;
  reasoning?: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionRequest extends ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type ChatCompletionResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
};

export type ChatCompletionChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
};

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  estimatedCostSavings: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- Rate Limit Types ----

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}
