function boundedString(value, fallback = null, maxLength = 128) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

const SAFE_CLASSIFICATIONS = new Set([
  'request_invalid',
  'request_too_large',
  'authentication_failed',
  'schema_incompatible',
  'schema_mismatch',
  'rate_limited',
  'request_timeout',
  'cold_start_timeout',
  'stream_truncated',
  'request_cancelled',
  'provider_unavailable',
  'provider_not_found',
  'provider_error',
  'model_downgrade',
  'foreign_toolset',
  'no_route',
  'retryable',
  'capability_not_supported',
  'cancelled',
]);

function safeClassification(value) {
  const text = boundedString(value, null, 64);
  if (!text) return null;
  return SAFE_CLASSIFICATIONS.has(text) || /^http_[45]\d{2}$/.test(text)
    ? text
    : 'provider_error';
}

/**
 * Project the authenticated GloryAPI trace contract into safe audit evidence.
 * Trace ids, timestamps, prompts, bodies and credentials are intentionally
 * omitted; the router already allowlists attempt classifications and bounds
 * durations before retaining them.
 */
function summarizeRoutingTrace(trace) {
  if (!trace || !Array.isArray(trace.attempts)) return null;
  return {
    status: boundedString(trace.status, 'unknown', 32),
    attempts: trace.attempts.map(attempt => ({
      platform: boundedString(attempt.platform, 'unknown'),
      model: boundedString(attempt.modelId, 'unknown'),
      status: boundedString(attempt.outcome, 'unknown', 32),
      classification: safeClassification(attempt.reason),
      durationMs: Number.isFinite(attempt.durationMs)
        ? Math.max(0, Math.min(Math.floor(attempt.durationMs), 10 * 60 * 1_000))
        : null,
    })),
    finalModel: trace.finalModel
      ? {
          platform: boundedString(trace.finalModel.platform, 'unknown'),
          model: boundedString(trace.finalModel.modelId, 'unknown'),
        }
      : null,
  };
}

function traceIds(traces) {
  return new Set((Array.isArray(traces) ? traces : [])
    .map(trace => trace && trace.traceId)
    .filter(traceId => typeof traceId === 'string'));
}

function findNewTrace(traces, previousIds, predicate = () => true) {
  const known = previousIds instanceof Set ? previousIds : traceIds(previousIds);
  return (Array.isArray(traces) ? traces : [])
    .find(trace => trace && !known.has(trace.traceId) && predicate(trace)) || null;
}

module.exports = { summarizeRoutingTrace, traceIds, findNewTrace };
