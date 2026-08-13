export type ReasoningTokensSource = 'provider' | 'estimated' | 'none'

export type ReasoningTelemetry = {
  reasoningTokens: number
  reasoningTokensSource: ReasoningTokensSource
}

type UsageRecord = {
  reasoning_tokens?: unknown
  completion_tokens_details?: { reasoning_tokens?: unknown }
  output_tokens_details?: { reasoning_tokens?: unknown }
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

/**
 * Providers disagree on where reasoning usage lives. Prefer an explicit value
 * from the provider and keep the fallback estimator visibly labelled.
 */
export function extractProviderReasoningTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const value = usage as UsageRecord
  const candidates = [
    value.reasoning_tokens,
    value.completion_tokens_details?.reasoning_tokens,
    value.output_tokens_details?.reasoning_tokens,
  ]
  for (const candidate of candidates) {
    const tokens = nonNegativeInteger(candidate)
    if (tokens !== null) return tokens
  }
  return null
}

export function estimateReasoningTokens(text: unknown): number {
  return typeof text === 'string' && text.length > 0 ? Math.ceil(text.length / 4) : 0
}

export function reasoningTelemetryFromUsage(usage: unknown): ReasoningTelemetry {
  const providerTokens = extractProviderReasoningTokens(usage)
  return providerTokens === null
    ? { reasoningTokens: 0, reasoningTokensSource: 'none' }
    : { reasoningTokens: providerTokens, reasoningTokensSource: 'provider' }
}
