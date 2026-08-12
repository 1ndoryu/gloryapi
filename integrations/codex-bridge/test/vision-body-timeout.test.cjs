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
  let attempts = 0;
  let requests = 0;
  let closedResponses = 0;
  const upstream = http.createServer((request, response) => {
    attempts += 1;
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
  for (let attempt = 0; attempt < 30 && requests < 3; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(attempts, 3, 'vision keeps its bounded retry policy');
  assert.ok(requests >= 2, 'at least the responses that reached end must be observed');
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

test('vision pins the already validated address instead of resolving the hostname again', async (t) => {
  let requests = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      requests += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'pinned' } }] }));
    });
  });
  const port = await listen(upstream);
  const cacheFile = path.join(os.tmpdir(), `glory-vision-pinned-${process.pid}-${Date.now()}.json`);
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('global fetch must not be used after DNS validation');
  };
  const adapter = createVisionAdapter({
    config: {
      ...baseConfig,
      limits: { ...baseConfig.limits },
      vision: {
        ...baseConfig.vision,
        baseUrl: `http://vision.example:${port}`,
        timeoutMs: 500,
        maxResponseBytes: 1024,
        cacheFile,
      },
    },
    assertSafeVisionEndpoint: value => new URL(value),
    resolveSafeVisionEndpoint: async value => {
      const safe = new URL(value);
      Object.defineProperty(safe, '__validatedAddresses', {
        value: [{ address: '127.0.0.1', family: 4 }],
      });
      return safe;
    },
    formatRemoteFailure: () => {},
    log: () => {},
  });
  t.after(async () => {
    global.fetch = originalFetch;
    fs.rmSync(cacheFile, { force: true });
    await new Promise(resolve => upstream.close(resolve));
  });

  assert.equal(await adapter.describeImage('data:image/png;base64,iVBORw0KGgo=', 'pin'), 'pinned');
  assert.equal(requests, 1);
  assert.equal(fetchCalls, 0);
});

test('vision coalesces identical requests and evicts by total memory bytes', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 15));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(220) } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const cacheFile = path.join(os.tmpdir(), `glory-vision-cache-bound-${process.pid}-${Date.now()}.json`);
  const adapter = createVisionAdapter({
    config: {
      ...baseConfig,
      limits: { ...baseConfig.limits },
      vision: {
        ...baseConfig.vision,
        cacheMax: 20,
        cacheMaxBytes: 512,
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

  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const results = await Promise.all([
    adapter.describeImage(image, 'coalesce'),
    adapter.describeImage(image, 'coalesce'),
    adapter.describeImage(image, 'coalesce'),
  ]);
  assert.deepEqual(results, ['x'.repeat(220), 'x'.repeat(220), 'x'.repeat(220)]);
  assert.equal(calls, 1, 'identical in-flight requests share one upstream call');

  for (const focus of ['one', 'two', 'three', 'four']) {
    await adapter.describeImage(image, focus);
  }
  const stats = adapter.getCacheStats();
  assert.ok(stats.bytes <= 512, `cache bytes ${stats.bytes} exceed configured bound`);
  assert.ok(stats.entries < 4, 'byte bound must evict older entries');
});
