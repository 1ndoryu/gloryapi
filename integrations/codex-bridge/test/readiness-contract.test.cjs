const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bridgeFile = path.resolve(__dirname, '..', 'bridge', 'server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`bridge exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

test('compatible readiness exposes a fail-closed capability matrix', async (t) => {
  const port = await reservePort();
  const requestLog = path.join(os.tmpdir(), `glory-bridge-capabilities-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      BRIDGE_REQUEST_LOG: requestLog,
      VISION_DISABLE: '1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(requestLog, { force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/health`, child);
  const response = await fetch(`${base}/capabilities`, { headers: { Authorization: 'Bearer test' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.matrix.length, 1);
  assert.equal(body.matrix[0].client, 'codex-responses');
  assert.equal(body.matrix[0].capabilities.text.status, 'supported');
  assert.equal(body.matrix[0].capabilities.streaming.status, 'supported');
  assert.equal(body.matrix[0].capabilities.vision.status, 'unsupported');
  assert.equal(body.matrix[0].capabilities.codexDesktopE2E.status, 'unverified');
  assert.equal(body.matrix[0].capabilities.providerInference.status, 'unverified');
  assert.equal(body.matrix[0].capabilities.contextCompaction.status, 'unsupported');
  assert.equal(body.matrix[0].capabilities.toolOnlyTurns.status, 'adapted');
  assert.equal(body.matrix[0].capabilities.standaloneWebSearch.status, 'unsupported');
  assert.equal(body.matrix[0].capabilities.mcp.status, 'adapted');
  assert.equal(body.matrix[0].capabilities.browser.status, 'adapted');
  assert.equal(body.matrix[0].capabilities.computerUse.status, 'unsupported');
  assert.equal(body.matrix[0].capabilities.automation.status, 'adapted');
  assert.equal(body.matrix[0].capabilities.multiAgent.status, 'adapted');
  assert.equal(body.matrix[0].capabilities.longContext.status, 'unverified');
  assert.deepEqual(body.matrix[0].evidence, [
    'glory-codex-responses-fixture-v1',
    'bridge-http-contract',
    'deterministic-canary-v1',
  ]);
  assert.doesNotMatch(JSON.stringify(body), /Authorization|Bearer|https?:\/\//i);
});

test('blocked lifecycle is observable and rejects inference without upstream auth', async (t) => {
  const port = await reservePort();
  const requestLog = path.join(os.tmpdir(), `glory-bridge-lifecycle-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: '',
      BRIDGE_REQUEST_LOG: requestLog,
      VISION_DISABLE: '1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(requestLog, { force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/health`, child);
  const lifecycle = await fetch(`${base}/lifecycle`, { headers: { Authorization: 'Bearer test' } });
  assert.equal(lifecycle.status, 200);
  const lifecycleBody = await lifecycle.json();
  assert.equal(lifecycleBody.ok, false);
  assert.equal(lifecycleBody.state, 'blocked');
  assert.equal(lifecycleBody.schema, 'glory-codex-lifecycle-v1');
  assert.equal(lifecycleBody.acceptingRequests, false);
  assert.deepEqual(lifecycleBody.transitions, ['starting', 'ready', 'blocked', 'draining', 'stopped']);

  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', input: [] }),
  });
  assert.equal(response.status, 503);
  const responseBody = await response.json();
  assert.equal(responseBody.error.code, 'bridge_lifecycle_not_ready');
});

test('incompatible GloryAPI contract blocks readiness and capabilities', async (t) => {
  const port = await reservePort();
  const requestLog = path.join(os.tmpdir(), `glory-bridge-ready-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      GLORY_API_CONTRACT: 'unsupported-contract-v99',
      BRIDGE_REQUEST_LOG: requestLog,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(requestLog, { force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/health`, child);
  const headers = { Authorization: 'Bearer test' };

  const ready = await fetch(`${base}/ready`, { headers });
  assert.equal(ready.status, 503);
  const readyBody = await ready.json();
  assert.equal(readyBody.ready, false);
  assert.equal(readyBody.checks.contractCompatible, false);
  assert.equal(readyBody.gloryApiContract, 'unsupported-contract-v99');

  const capabilities = await fetch(`${base}/capabilities`, { headers });
  assert.equal(capabilities.status, 503);
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilitiesBody.error.code, 'bridge_not_ready');
});
