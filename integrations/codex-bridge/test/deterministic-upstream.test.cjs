const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeterministicUpstream } = require('./deterministic-upstream.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function post(base, token, marker, signal) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: marker }],
    }),
    signal,
  });
}

test('deterministic upstream covers fragmented Unicode, truncation, and cancellation', async t => {
  const upstream = await createDeterministicUpstream({
    token: ['canary-andoryyu-fail', 'canary-zen'],
    port: 0,
  });
  t.after(() => new Promise(resolve => upstream.server.close(resolve)));
  const base = `http://127.0.0.1:${upstream.port}`;

  const unicode = await post(base, 'canary-zen', 'CANARY_UNICODE_CASE');
  const unicodeBody = await unicode.text();
  assert.equal(unicode.status, 200);
  assert.match(unicodeBody, /🌍/);
  assert.match(unicodeBody, /\[DONE\]/);

  const truncated = await post(base, 'canary-andoryyu-fail', 'CANARY_TRUNCATION_CASE');
  const truncatedBody = await truncated.text();
  assert.equal(truncated.status, 200);
  assert.doesNotMatch(truncatedBody, /\[DONE\]/);
  assert.equal(upstream.state.truncatedObserved, true);

  const controller = new AbortController();
  const cancelled = post(base, 'canary-andoryyu-fail', 'CANARY_CANCEL_CASE', controller.signal).catch(() => undefined);
  await sleep(50);
  controller.abort();
  await cancelled;
  for (let attempt = 0; attempt < 20 && !upstream.state.cancelObserved; attempt += 1) await sleep(25);
  assert.equal(upstream.state.cancelObserved, true);
});
