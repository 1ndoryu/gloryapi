export interface FallbackEntryIdentity {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
}

export interface FallbackEntryRanking {
  priority: number
  effectivePriority: number
  intelligenceRank: number
  speedRank: number
  penalty: number
  rateLimitHits: number
}

export interface FallbackEntryUsage {
  enabled: boolean
  arenaElo: number | null
  artificialAnalysisCodingIndex: number | null
  rpmLimit: number | null
  rpdLimit: number | null
  keyCount: number
  totalRequests: number
  successRate: number | null
}

export interface FallbackEntry
  extends FallbackEntryIdentity,
    FallbackEntryRanking,
    FallbackEntryUsage {}

export interface FallbackRuntime {
  inFlight: Array<{ attemptId: string; platform: string; modelId: string; startedAt: string }>
  lastCompleted: { platform: string; modelId: string; completedAt: string } | null
}

export interface BridgeVisionModel {
  routeId: string
  id: string
  provider: string
  displayName: string
  baseUrl: string
  completionsPath: string
  authPlatform: string
  contextWindow: number | null
  priority: number
  enabled: boolean
}

export interface FallbackSnapshot {
  schemaVersion: 'glory-routing-v1'
  revision: number
  entries: FallbackEntry[]
  visionModels?: BridgeVisionModel[]
  runtime?: FallbackRuntime
}

/* [ISP] La superficie completa de un modelo configurado se compone de partes
 * cohesivas (identidad + afinamiento + ruteo) en lugar de una interface plana
 * con 11 campos, para respetar el SPI sin romper la API de los consumidores. */
export interface ConfiguredModelIdentity {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  pickerId: string | null
}

export interface ConfiguredModelRuntime {
  enabled: boolean
  contextWindow: number | null
  nativeVision: boolean
  supportsReasoning: boolean
}

export interface ConfiguredModelRouting {
  routeIds: string[]
  bridgeVisible: boolean
}

export interface ConfiguredModel
  extends ConfiguredModelIdentity,
    ConfiguredModelRuntime,
    ConfiguredModelRouting {}

export interface ConfigurationRouteMember {
  modelDbId: number
  priority: number
  enabled: boolean
}

export interface ConfigurationRoute {
  routeId: string
  name: string
  kind: 'auto' | 'pinned' | 'policy'
  enabled: boolean
  visible: boolean
  members: ConfigurationRouteMember[]
}

export interface ConfigurationFieldDefinition {
  key: string
  label: string
  description: string
  type: 'text' | 'integer' | 'duration-ms' | 'boolean' | 'enum' | 'json-map'
  section: string
  scope: 'provider' | 'model' | 'route'
  min?: number
  max?: number
  options?: Array<{ value: string; label: string }>
  requiresRestart: boolean
  sensitive: boolean
  consumer: string
}

export interface ConfigurationProvider {
  platform: string
  displayName: string
  lifecycle: 'active' | 'archived' | 'draft'
  adapter: string
  endpoint: string
  authScheme: string
  enabled: boolean
  timeoutMs: number
  capabilities: { streaming: boolean; tools: boolean; reasoning: boolean; multimodal: boolean; maxContextWindow: number | null }
  transport: { messageProfile: string; includeStreamUsage: boolean; bufferUntilContent: boolean; bufferUntilDone: boolean; maxReasoningEffort: string; modelAliases: Record<string, string>; modelReasoningLimits: Record<string, string>; extraHeadersProfile: string }
  failurePolicy: { cooldownMs: number; rateLimitCooldownMs?: number; recordPenalty: boolean; recordProviderFailure: boolean }
}

export interface ConfigurationSchema {
  schemaVersion: string
  fields: ConfigurationFieldDefinition[]
}

export interface BridgeCatalogProjection {
  schemaVersion: string
  revision: number
  hash: string
  generatedAt: string
  entries: Array<{ id: string; wireModel: string; pickerId: string | null; provider: string; displayName: string; contextWindow: number | null; nativeVision?: boolean; acceptsImageInput?: boolean }>
  visionModels: BridgeVisionModel[]
  sync: { state: 'synced' | 'stale' | 'missing' | 'invalid'; path: string; checkedAt: string; revision: number | null; hash: string | null; errors: string[] }
}

export interface ConfigurationSnapshot {
  schemaVersion: 'glory-configuration-v2'
  revision: number
  routes: ConfigurationRoute[]
  models: ConfiguredModel[]
  providers: ConfigurationProvider[]
  schema: ConfigurationSchema
  bridge: BridgeCatalogProjection
}