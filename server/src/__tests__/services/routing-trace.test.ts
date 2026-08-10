import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginRoutingTrace,
  finishRoutingTrace,
  getRecentRoutingTraces,
  recordRoutingTraceAttempt,
  resetRoutingTracesForTests,
} from '../../services/routing-trace.js';

describe('Routing traces', () => {
  const firstRoute = { platform: 'andoryyu' as const, modelId: 'deepseek-v4-flash' };
  const secondRoute = { platform: 'opencode-zen' as const, modelId: 'deepseek-v4-flash-free' };

  beforeEach(() => resetRoutingTracesForTests());

  it('records sanitized attempts and the final model without sensitive payloads', () => {
    const traceId = beginRoutingTrace();
    recordRoutingTraceAttempt(traceId, firstRoute, 'error', 'HTTP 429: secret-token', 12.8);
    recordRoutingTraceAttempt(traceId, secondRoute, 'success', null, 7.4);
    finishRoutingTrace(traceId, 'completed', secondRoute);

    const [trace] = getRecentRoutingTraces();
    expect(trace).toMatchObject({
      schemaVersion: 'glory-routing-trace-v1',
      status: 'completed',
      finalModel: secondRoute,
    });
    expect(trace.attempts).toEqual([
      { ...firstRoute, outcome: 'error', reason: 'provider_error', durationMs: 12 },
      { ...secondRoute, outcome: 'success', reason: null, durationMs: 7 },
    ]);
    expect(JSON.stringify(trace)).not.toContain('apiKey');
    expect(JSON.stringify(trace)).not.toContain('secret-token');
  });

  it('bounds retained traces and removes in-flight state when finished', () => {
    for (let index = 0; index < 55; index++) {
      const traceId = beginRoutingTrace();
      finishRoutingTrace(traceId, 'failed');
    }
    expect(getRecentRoutingTraces()).toHaveLength(50);
  });
});
