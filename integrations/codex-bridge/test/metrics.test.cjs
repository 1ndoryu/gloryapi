const assert = require('node:assert/strict');
const test = require('node:test');
const { createMetrics } = require('../bridge/metrics');

test('metrics use bounded names/samples and expose latency percentiles only', () => {
  const metrics = createMetrics({ maxSeries: 1, maxSamples: 3 });
  metrics.observe('http.request_ms', 10);
  metrics.observe('http.request_ms', 20);
  metrics.observe('http.request_ms', 30);
  metrics.observe('http.request_ms', 40);
  metrics.observe('prompt.secret', 1);
  metrics.observe('invalid name', 1);
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot['http.request_ms'], { count: 3, min: 20, max: 40, mean: 30, p50: 30, p95: 40 });
  assert.equal(snapshot['prompt.secret'], undefined);
  assert.equal(Object.keys(snapshot).length, 1);
});
