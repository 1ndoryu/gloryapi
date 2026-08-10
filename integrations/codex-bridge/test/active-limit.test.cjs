const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`bridge exited early (${child.exitCode})`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('bridge health timeout');
}

test('active request cap fails closed instead of creating an unbounded queue', async (t) => {
  const upstream = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"id":"slow","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
    }, 250);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const bridgeProbe = http.createServer();
  const bridgePort = await listen(bridgeProbe);
  await new Promise(resolve => bridgeProbe.close(resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'bridge', 'server.js')], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_CLIENT_TOKEN: 'test-client',
      GLORY_API_KEY: 'test-upstream',
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      VISION_DISABLE: '1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  });
  const base = `http://127.0.0.1:${bridgePort}`;
  await waitForHealth(`${base}/health`, child);
  const request = () => fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-client' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'slow' }] }] }),
  }).then(async response => ({ status: response.status, body: await response.text() }));
  const results = await Promise.all(Array.from({ length: 40 }, request));
  const busy = results.filter(result => result.status === 429);
  assert.ok(busy.length > 0, 'at least one request must observe bridge_busy');
  assert.ok(busy.every(result => /bridge_busy/.test(result.body)));
});
