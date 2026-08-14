import { getDb } from '../db/index.js'

export type ProxyRequestTelemetry = {
  requestKind?: string
  parentRequestId?: string | null
  cachedInputTokens?: number
  cacheWriteTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | null
  reasoningTokens?: number
  reasoningTokensSource?: 'provider' | 'estimated' | 'none'
  requestedModel?: string | null
  routeId?: string | null
  configurationRevision?: number
  selectionReason?: string | null
  selectionConfidence?: 'persisted' | 'legacy' | 'unknown' | null
}

export function logProxyRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  keyId: number | null = null,
  telemetry: ProxyRequestTelemetry = {},
): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO requests (
        platform, model_id, status, input_tokens, output_tokens, latency_ms, error,
        api_key_id, request_kind, parent_request_id, cached_input_tokens, cache_write_tokens,
        reasoning_effort, reasoning_tokens, reasoning_tokens_source,
        requested_model, route_id, configuration_revision, selection_reason, selection_confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      platform,
      modelId,
      status,
      inputTokens,
      outputTokens,
      latencyMs,
      error,
      keyId,
      telemetry.requestKind || 'main',
      telemetry.parentRequestId || null,
      Math.max(0, telemetry.cachedInputTokens || 0),
      Math.max(0, telemetry.cacheWriteTokens || 0),
      telemetry.reasoningEffort || null,
      Math.max(0, telemetry.reasoningTokens || 0),
      telemetry.reasoningTokensSource || 'none',
      telemetry.requestedModel || null,
      telemetry.routeId || null,
      Math.max(0, telemetry.configurationRevision || 0),
      telemetry.selectionReason || null,
      telemetry.selectionConfidence || null,
    )
  } catch (err) {
    console.error('Failed to log request:', err)
  }
}
