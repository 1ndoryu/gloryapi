const assert = require('node:assert/strict');
const test = require('node:test');
const { ReadableStream } = require('node:stream/web');
const { contentLengthOf, readResponseTextLimited, readResponseJsonLimited } = require('../bridge/response-body');

test('response body reader rejects an oversized declared body before allocation', async () => {
  let cancelled = false;
  const response = {
    headers: { get: name => name === 'content-length' ? '100' : null },
    body: new ReadableStream({ cancel() { cancelled = true; } }),
  };
  assert.equal(contentLengthOf(response), 100);
  await assert.rejects(readResponseTextLimited(response, 8, 'test response'), /test response exceeds 8 bytes/);
  assert.equal(cancelled, true);
});

test('response body reader bounds streamed bytes and cancels on overflow', async () => {
  let cancelled = false;
  const response = {
    headers: { get: () => null },
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() { cancelled = true; },
    }),
  };
  await assert.rejects(readResponseTextLimited(response, 8, 'test response'), /test response exceeds 8 bytes/);
  assert.equal(cancelled, true);
});

test('response body reader parses bounded JSON', async () => {
  const response = new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await readResponseJsonLimited(response, 100, 'json response'), { ok: true });
});
