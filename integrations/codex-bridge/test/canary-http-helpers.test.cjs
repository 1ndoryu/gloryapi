const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const test = require('node:test');
const { requestResponsesStream } = require('../../../scripts/canary/http-helpers.cjs');

test('canary cancels a 200 response whose content type is not SSE', async () => {
  let cancelled = false;
  const response = {
    ok: true,
    status: 200,
    headers: { get: name => name === 'content-type' ? 'application/json' : null },
    body: new ReadableStream({ cancel() { cancelled = true; } }),
  };
  await assert.rejects(
    requestResponsesStream('http://canary.invalid', {}, 1024, async () => response),
    /did not use text\/event-stream/,
  );
  assert.equal(cancelled, true);
});
