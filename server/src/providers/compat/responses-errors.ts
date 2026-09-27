/** Clasificadores de errores del endpoint Responses (`/responses`).
 * Extraído de `openai-compat.ts` (límite 300 líneas). */

export function responsesReplayBytes(items: Array<{ encrypted_content: string }> | undefined): number {
  if (!items) return 0;
  return items.reduce((sum, item) => sum + Buffer.byteLength(item.encrypted_content, 'utf8'), 0);
}

export function isResponsesStateError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const text = JSON.stringify(err).toLowerCase();
  return text.includes('unknown parameter') && (text.includes('store') || text.includes('include') || text.includes('reasoning'))
    || (text.includes('store') && text.includes('unexpected'))
    || (text.includes('include') && text.includes('unexpected'));
}

/** Fail-open for a malformed replay: if the gateway rejects the replayed
 * `reasoning` item itself (e.g. a newly required field), retry once without
 * any replayed state instead of failing a request that used to succeed. */
export function isResponsesReplayError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const text = JSON.stringify(err).toLowerCase();
  return text.includes('invalid_request') && (text.includes('reasoning') || text.includes('encrypted_content') || text.includes('summary'));
}
