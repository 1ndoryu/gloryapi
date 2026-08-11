const assert = require('node:assert/strict');
const test = require('node:test');
const { findNewTrace, summarizeRoutingTrace, traceIds } = require('../../../scripts/canary/routing-evidence.cjs');

test('routing evidence projects only bounded, allowlisted metadata', () => {
  const trace = {
    traceId: 'trace-secret-id',
    startedAt: '2026-08-11T00:00:00.000Z',
    attempts: [{
      platform: 'andoryyu',
      modelId: 'deepseek-v4-flash',
      outcome: 'error',
      reason: 'apiKey=secret-token',
      durationMs: 999999999,
    }],
    finalModel: { platform: 'opencode-go', modelId: 'deepseek-v4-flash' },
    status: 'completed',
  };
  const summary = summarizeRoutingTrace(trace);
  assert.deepEqual(summary.attempts[0], {
    platform: 'andoryyu',
    model: 'deepseek-v4-flash',
    status: 'error',
    classification: 'provider_error',
    durationMs: 600000,
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret|traceId|startedAt/i);
});

test('routing evidence selects only traces created after the baseline', () => {
  const oldTrace = { traceId: 'old', attempts: [] };
  const newTrace = { traceId: 'new', attempts: [] };
  assert.equal(findNewTrace([oldTrace], traceIds([oldTrace])), null);
  assert.equal(findNewTrace([newTrace, oldTrace], traceIds([oldTrace])), newTrace);
});
