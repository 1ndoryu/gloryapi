import { getDb } from '../db/index.js'

export type ProxyRequestTelemetry = {
  requestKind?: string
  parentRequestId?: string | null
  cachedInputTokens?: number
  cacheWriteTokens?: number
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
        api_key_id, request_kind, parent_request_id, cached_input_tokens, cache_write_tokens
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    )
  } catch (err) {
    console.error('Failed to log request:', err)
  }
}
