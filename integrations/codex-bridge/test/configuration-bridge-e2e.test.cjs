const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bridgeFile = path.resolve(__dirname, '..', 'bridge', 'server.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`bridge exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

function catalogEnvelope() {
  const entries = [
    {
      id: 'auto',
      wireModel: 'auto',
      pickerId: 'codex-auto-review',
      provider: 'auto',
      displayName: 'Auto (router de GloryAPI)',
      nativeVision: false,
      supportsReasoning: true,
      contextWindow: 150000,
      routeId: 'route:auto',
    },
    {
      id: 'fixture/pinned',
      wireModel: 'fixture/pinned',
      pickerId: 'gpt-5.6-sol',
      provider: 'fixture',
      displayName: 'Fixture fijado',
      nativeVision: false,
      supportsReasoning: true,
      contextWindow: 150000,
      routeId: 'route:model:fixture',
    },
  ];
  const hashEntries = entries.map(({ routeId: _routeId, ...entry }) => entry);
  return {
    schemaVersion: 'glory-bridge-model-catalog-v2',
    state: 'published',
    revision: 9,
    hash: crypto.createHash('sha256').update(JSON.stringify(hashEntries)).digest('hex'),
    entries,
  };
}

function requestBody(model) {
  return {
    model,
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prueba E2E' }] }],
  };
}

async function post(base, model) {
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bridge-test' },
    body: JSON.stringify(requestBody(model)),
  });
  return { status: response.status, body: await response.json() };
}

async function stop(child) {
  if (child.exitCode != null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;
}

test('catalog, Auto, pinned model and restart remain coherent in an isolated bridge', async t => {
  const requests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ body, headers: request.headers });
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Routed-Via': `fixture/${body.model}` });
      response.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: `respuesta ${body.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await reservePort();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-bridge-e2e-'));
  const catalogFile = path.join(runtime, 'bridge-model-catalog.json');
  const requestLog = path.join(runtime, 'bridge.log');
  fs.writeFileSync(catalogFile, `${JSON.stringify(catalogEnvelope())}\n`, 'utf8');

  const env = {
    ...process.env,
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_CLIENT_TOKEN: 'bridge-test',
    GLORY_API_KEY: 'upstream-test',
    BRIDGE_MODEL_CATALOG_FILE: catalogFile,
    BRIDGE_REQUEST_LOG: requestLog,
    GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    VISION_DISABLE: '1',
  };
  const start = () => spawn(process.execPath, [bridgeFile], { env, stdio: 'ignore' });
  let child = start();
  t.after(async () => {
    await stop(child);
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(runtime, { recursive: true, force: true });
  });

  let health = await waitForHealth(`http://127.0.0.1:${bridgePort}/health`, child);
  assert.equal(health.catalog.state, 'published');
  assert.equal(health.catalog.revision, 9);
  assert.equal(health.catalog.entries, 2);

  const models = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`).then(response => response.json());
  assert.deepEqual(models.data.map(model => model.id), ['auto', 'fixture/pinned']);
  const explicit = await post(`http://127.0.0.1:${bridgePort}`, 'fixture/pinned');
  assert.equal(explicit.status, 200);
  assert.match(explicit.body.output?.[0]?.content?.[0]?.text || '', /fixture\/pinned/);
  const automatic = await post(`http://127.0.0.1:${bridgePort}`, 'auto');
  assert.equal(automatic.status, 200);
  assert.match(automatic.body.output?.[0]?.content?.[0]?.text || '', /auto/);
  assert.deepEqual(requests.map(request => request.body.model), ['fixture/pinned', 'auto']);

  await stop(child);
  child = start();
  health = await waitForHealth(`http://127.0.0.1:${bridgePort}/health`, child);
  assert.equal(health.catalog.state, 'published');
  assert.equal(health.catalog.revision, 9);
  const afterRestart = await post(`http://127.0.0.1:${bridgePort}`, 'fixture/pinned');
  assert.equal(afterRestart.status, 200);
  assert.equal(requests.at(-1).body.model, 'fixture/pinned');
});
