import crypto from 'node:crypto';
import type { RouteResult } from './router.js';
import type { RoutingTraceAttempt, RoutingTraceSnapshot } from '@gloryapi/shared/types.js';
import { publishRoutingTrace } from './routing-events.js';

const MAX_RECENT_TRACES = 50;
type ActiveTrace = Omit<RoutingTraceSnapshot, 'completedAt'> & { completedAt: string | null };
const activeTraces = new Map<string, ActiveTrace>();
const recentTraces: RoutingTraceSnapshot[] = [];

function publish(snapshot: RoutingTraceSnapshot): void {
  publishRoutingTrace(snapshot);
}

export function beginRoutingTrace(): string {
  const traceId = crypto.randomUUID();
  activeTraces.set(traceId, {
    schemaVersion: 'glory-routing-trace-v1',
    traceId,
    status: 'failed',
    startedAt: new Date().toISOString(),
    completedAt: null,
    attempts: [],
    finalModel: null,
  });
  return traceId;
}

export function recordRoutingTraceAttempt(
  traceId: string,
  route: Pick<RouteResult, 'platform' | 'modelId'>,
  outcome: RoutingTraceAttempt['outcome'],
  reason: string | null,
  durationMs: number,
): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  const safeReason = reason && (
    reason === 'request_invalid'
    || reason === 'request_too_large'
    || reason === 'authentication_failed'
    || reason === 'schema_incompatible'
    || reason === 'schema_mismatch'
    || reason === 'rate_limited'
    || reason === 'request_timeout'
    || reason === 'cold_start_timeout'
    || reason === 'stream_truncated'
    || reason === 'request_cancelled'
    || reason === 'provider_unavailable'
    || reason === 'provider_not_found'
    || reason === 'provider_error'
    || reason === 'no_route'
    || reason === 'retryable'
    || reason === 'capability_not_supported'
    || reason === 'cancelled'
    || /^http_[45]\d{2}$/.test(reason)
  ) ? reason : reason ? 'provider_error' : null;
  trace.attempts.push({
    platform: route.platform,
    modelId: route.modelId,
    outcome,
    reason: safeReason,
    durationMs: Math.max(0, Math.min(Math.floor(durationMs), 10 * 60 * 1_000)),
  });
}

export function finishRoutingTrace(
  traceId: string,
  status: RoutingTraceSnapshot['status'],
  finalRoute?: Pick<RouteResult, 'platform' | 'modelId'>,
): void {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  activeTraces.delete(traceId);
  const completed: RoutingTraceSnapshot = {
    schemaVersion: trace.schemaVersion,
    traceId: trace.traceId,
    status,
    startedAt: trace.startedAt,
    completedAt: new Date().toISOString(),
    attempts: trace.attempts,
    finalModel: finalRoute ? { platform: finalRoute.platform, modelId: finalRoute.modelId } : null,
  };
  recentTraces.unshift(completed);
  if (recentTraces.length > MAX_RECENT_TRACES) recentTraces.length = MAX_RECENT_TRACES;
  publish(completed);
}

export function getRecentRoutingTraces(): RoutingTraceSnapshot[] {
  return recentTraces.map(trace => ({
    ...trace,
    attempts: trace.attempts.map(attempt => ({ ...attempt })),
    finalModel: trace.finalModel ? { ...trace.finalModel } : null,
  }));
}

export function resetRoutingTracesForTests(): void {
  activeTraces.clear();
  recentTraces.length = 0;
}
