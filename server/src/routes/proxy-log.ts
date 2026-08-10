import { getDb } from '../db/index.js'

export function logProxyRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  keyId: number | null = null,
): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, api_key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error, keyId)
  } catch (err) {
    console.error('Failed to log request:', err)
  }
}
