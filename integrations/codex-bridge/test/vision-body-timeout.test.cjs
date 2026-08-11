const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { config: baseConfig } = require('../bridge/config');
const { createVisionAdapter } = require('../bridge/vision');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('vision aborts a response that sends headers and leaves the body open', async (t) => {
  let requests = 0;
  let closedResponses = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      requests += 1;
      response.once('close', () => { closedResponses += 1; });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"choices":[');
    });
  });
  const port = await listen(upstream);
  const cacheFile = path.join(os.tmpdir(), `glory-vision-timeout-${process.pid}-${Date.now()}.json`);
  const adapter = createVisionAdapter({
    config: {
      ...baseConfig,
      limits: { ...baseConfig.limits },
      vision: {
        ...baseConfig.vision,
        baseUrl: `http://127.0.0.1:${port}`,
        completionsPath: '/chat/completions',
        timeoutMs: 100,
        maxResponseBytes: 1024,
        cacheFile,
      },
    },
    assertSafeVisionEndpoint: value => new URL(value),
    formatRemoteFailure: () => {},
    log: () => {},
  });
  t.after(async () => {
    fs.rmSync(cacheFile, { force: true });
    await new Promise(resolve => upstream.close(resolve));
  });

  const started = Date.now();
  const result = await adapter.describeImage('data:image/png;base64,iVBORw0KGgo=', 'describe');
  assert.equal(result, null);
  assert.equal(requests, 3, 'vision keeps its bounded retry policy');
  for (let attempt = 0; attempt < 30 && closedResponses < requests; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(closedResponses, requests, 'each timed-out response must be aborted');
  assert.ok(Date.now() - started < 3000, 'vision body timeout must remain bounded');
});

test('vision clears per-attempt timers after success and HTTP failures', async (t) => {
  const originalFetch = global.fetch;
  const signals = [];
  let call = 0;
  global.fetch = async (_endpoint, options) => {
    signals.push(options.signal);
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'temporary' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const cacheFile = path.join(os.tmpdir(), `glory-vision-timers-${process.pid}-${Date.now()}.json`);
  const adapter = createVisionAdapter({
    config: {
      ...baseConfig,
      limits: { ...baseConfig.limits },
      vision: {
        ...baseConfig.vision,
        timeoutMs: 40,
        maxResponseBytes: 1024,
        cacheFile,
      },
    },
    assertSafeVisionEndpoint: value => new URL(value),
    formatRemoteFailure: () => {},
    log: () => {},
  });
  t.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(cacheFile, { force: true });
  });

  assert.equal(await adapter.describeImage('data:image/png;base64,iVBORw0KGgo=', 'success'), 'ok');
  assert.equal(await adapter.describeImage('data:image/png;base64,iVBORw0KGgo=', 'http failure'), null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(signals.length, 4, 'one success plus the three bounded HTTP retries');
  assert.deepEqual(signals.map(signal => signal.aborted), [false, false, false, false]);
});
