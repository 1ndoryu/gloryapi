/** Registro local de peticiones fallidas para diagnóstico.
 * Extraído de `openai-compat.ts` (límite 300 líneas). */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAILED_REQUESTS_LOG = process.env.GLORYAPI_FAILED_REQUESTS_LOG
  ? process.env.GLORYAPI_FAILED_REQUESTS_LOG
  : join(dirname(fileURLToPath(import.meta.url)), '../../../data/failed_requests.log');

export function logFailedRequest(provider: string, status: number, body: unknown, errorText: string): void {
  try {
    mkdirSync(dirname(FAILED_REQUESTS_LOG), { recursive: true });
    appendFileSync(FAILED_REQUESTS_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      provider,
      status,
      body,
      error: errorText.slice(0, 2000),
    }) + '\n');
  } catch (e) {
    console.error(`[${provider}] failed to write ${FAILED_REQUESTS_LOG}:`, e);
  }
}
