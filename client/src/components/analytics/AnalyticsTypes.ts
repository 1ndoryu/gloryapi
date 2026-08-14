export type RequestHistoryItem = {
  id: number
  platform: string
  modelId: string
  displayName: string
  status: 'success' | 'error'
  inputTokens: number
  outputTokens: number
  reasoningEffort: 'low' | 'medium' | 'high' | 'max' | null
  reasoningTokens: number
  reasoningTokensSource: 'provider' | 'estimated' | 'none'
  latencyMs: number
  error: string | null
  errorPreview: string | null
  resultBrief: string
  createdAt: string
  apiKeyId: number | null
  apiKeyLabel: string | null
  requestKind: string
  parentRequestId: string | null
  parentRouteId: string | null
  parentConfigurationRevision: number | null
  parentSelectionReason: string | null
  cachedInputTokens: number
  cacheWriteTokens: number
}

export type AnalyticsSummary = {
  totalRequests: number
  mainRequests: number
  auxiliaryRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  avgLatencyMs: number
  estimatedCostSavings: number
}

export type PlatformStats = {
  platform: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

export type TimelinePoint = {
  timestamp: string
  requests: number
  successCount: number
  failureCount: number
}

export type ModelStats = PlatformStats & { displayName: string }
export type RecentError = { id: number; platform: string; modelId: string; error: string | null; latencyMs: number; createdAt: string }
export type ErrorCategory = { category: string; count: number }
export type ErrorPlatform = { platform: string; count: number }
export type ErrorDetail = { platform: string; model_id: string; error_category: string; count: number }
export type ErrorDistribution = {
  byCategory: ErrorCategory[]
  byPlatform: ErrorPlatform[]
  detailed: ErrorDetail[]
}
