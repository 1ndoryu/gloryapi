import { normalizeProxyError, type ProxyError } from './proxy-contract.js';

export type ProxyErrorCategory =
  | 'request'
  | 'authentication'
  | 'schema'
  | 'rate_limit'
  | 'timeout'
  | 'cold_start'
  | 'stream'
  | 'provider'
  | 'routing';

export type ProxyErrorCode =
  | 'request_invalid'
  | 'request_too_large'
  | 'authentication_failed'
  | 'schema_incompatible'
  | 'rate_limited'
  | 'request_timeout'
  | 'cold_start_timeout'
  | 'stream_truncated'
  | 'request_cancelled'
  | 'provider_unavailable'
  | 'provider_not_found'
  | 'provider_error'
  | 'model_downgrade'
  | 'foreign_toolset'
  | 'no_route';

export interface ProxyErrorClassification {
  category: ProxyErrorCategory;
  code: ProxyErrorCode;
  retryable: boolean;
  cooldownEligible: boolean;
  status: number;
  safeMessage: string;
}

export interface ProxyErrorClassificationOptions {
  coldStartRetryMs?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageOf(error: ProxyError): string {
  return error.message.toLowerCase();
}

function statusOf(error: ProxyError): number | null {
  if (typeof error.status === 'number' && Number.isInteger(error.status)) return error.status;
  const match = messageOf(error).match(/(?:api error|status)\s+(\d{3})/i) ?? messageOf(error).match(/\b(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function isTimeoutMessage(message: string): boolean {
  return message.includes('timeout')
    || message.includes('timed out')
    || message.includes('etimedout')
    || message.includes('aborted')
    || message.includes('deadline exceeded');
}

function classification(
  category: ProxyErrorCategory,
  code: ProxyErrorCode,
  retryable: boolean,
  status: number,
  safeMessage: string,
  cooldownEligible = true,
): ProxyErrorClassification {
  return { category, code, retryable, cooldownEligible, status, safeMessage };
}

/**
 * Convert provider/runtime failures into a bounded public contract.
 * The original Error is deliberately never copied into the result's message.
 */
export function classifyProxyError(
  value: unknown,
  options: ProxyErrorClassificationOptions = {},
): ProxyErrorClassification {
  const error = normalizeProxyError(value);
  const message = messageOf(error);
  const status = statusOf(error);

  if (error.cancelled === true) {
    return classification('stream', 'request_cancelled', false, 499, 'Request cancelled.');
  }
  if (error.modelDowngrade === true) {
    return classification(
      'provider',
      error.foreignToolset === true ? 'foreign_toolset' : 'model_downgrade',
      true,
      502,
      'Provider returned a different model than requested.',
      false,
    );
  }
  if (error.streamAbort === true) {
    return classification('stream', 'stream_truncated', true, 502, 'Provider stream terminated before completion.');
  }

  const looksLikeSchemaMismatch = message.includes('unknown name')
    || message.includes('unknown field')
    || message.includes('cannot find field')
    || message.includes('thought_signature')
    || message.includes('function_declarations');
  if (status === 400 && looksLikeSchemaMismatch) {
    // Schema incompatibility is fallbackable, but it is not a retryable
    // transport failure: the proxy handles it separately and must not put the
    // provider/key on cooldown.
    return classification('schema', 'schema_incompatible', false, 502, 'Provider schema is incompatible with this request.');
  }

  if (status === 401 || status === 403 || message.includes('invalid api key') || message.includes('unauthorized')) {
    return classification('authentication', 'authentication_failed', true, 502, 'Provider authentication failed.');
  }

  if (status === 402 || status === 429 || message.includes('rate limit') || message.includes('too many requests')
    || message.includes('quota') || message.includes('resource_exhausted')
    || message.includes('insufficient credits') || message.includes('insufficient balance')) {
    return classification('rate_limit', 'rate_limited', true, 429, 'Provider rate limit or quota reached.');
  }

  if (status === 413 || message.includes('payload too large') || message.includes('request body too large')
    || message.includes('request entity too large') || message.includes('content too large')) {
    return classification('request', 'request_too_large', true, 413, 'Provider rejected the request because it is too large.');
  }

  if (isTimeoutMessage(message) || status === 408) {
    const coldStart = typeof options.coldStartRetryMs === 'number' && options.coldStartRetryMs > 0;
    if (coldStart) {
      return classification('cold_start', 'cold_start_timeout', true, 504, 'Provider cold start did not complete in time.');
    }
    return classification('timeout', 'request_timeout', true, 504, 'Provider request timed out.');
  }

  if (status === 404 || message.includes('not found') || message.includes('no endpoints found')) {
    return classification('provider', 'provider_not_found', true, 502, 'Provider model or endpoint was not found.');
  }

  if ((status !== null && status >= 500 && status <= 599)
    || message.includes('econnrefused') || message.includes('econnreset')
    || message.includes('unavailable') || message.includes('connection')) {
    return classification('provider', 'provider_unavailable', true, 503, 'Provider is temporarily unavailable.');
  }

  if (status === 400 || status === 422) {
    return classification('request', 'request_invalid', false, 400, 'Provider rejected the request.');
  }

  return classification('provider', 'provider_error', false, 502, 'Provider request failed.');
}

export function isProxyErrorClassification(value: unknown): value is ProxyErrorClassification {
  if (!isRecord(value)) return false;
  return typeof value.category === 'string'
    && typeof value.code === 'string'
    && typeof value.retryable === 'boolean'
    && typeof value.cooldownEligible === 'boolean'
    && typeof value.status === 'number'
    && typeof value.safeMessage === 'string';
}
