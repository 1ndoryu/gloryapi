export type RequestHistoryItem = {
  id: number
  platform: string
  modelId: string
  displayName: string
  status: 'success' | 'error'
  inputTokens: number
  outputTokens: number
  latencyMs: number
  error: string | null
  errorPreview: string | null
  resultBrief: string
  createdAt: string
  apiKeyId: number | null
  apiKeyLabel: string | null
}

export type AnalyticsSummary = {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
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
