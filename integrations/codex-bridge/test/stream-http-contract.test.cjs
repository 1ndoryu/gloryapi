const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
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

function requestBody(text) {
  return {
    model: 'deepseek-v4-flash',
    stream: true,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }],
  };
}

test('sidecar rejects truncated SSE, preserves fragmented UTF-8, and aborts on client close', async (t) => {
  let cancellationStarted;
  let cancellationClosed;
  const started = new Promise((resolve) => { cancellationStarted = resolve; });
  const closed = new Promise((resolve) => { cancellationClosed = resolve; });

  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = body.messages?.[0]?.content?.[0]?.text || body.messages?.[0]?.content || '';
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });

      const chunkFor = (content) => JSON.stringify({
        id: 'fixture-stream',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });

      if (text.includes('fragmented')) {
        const payload = Buffer.from(`data: ${chunkFor('🙂')}\r\n\r\ndata: [DONE]\r\n\r\n`, 'utf8');
        const split = payload.findIndex((value) => value === 0xf0);
        response.write(payload.subarray(0, split));
        setTimeout(() => { response.end(payload.subarray(split)); }, 10);
        return;
      }

      if (text.includes('truncated')) {
        response.end(`data: ${chunkFor('partial')}\n\n`);
        return;
      }

      if (text.includes('stall')) {
        // Headers without a subsequent SSE frame reproduce the upstream
        // failure that a bare fetch could leave waiting forever.
        return;
      }

      if (text.includes('cancel')) {
        cancellationStarted();
        response.write(`data: ${chunkFor('before cancel')}\n\n`);
        response.on('close', () => cancellationClosed());
        return;
      }

      response.end(`data: ${chunkFor('ok')}\n\ndata: [DONE]\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridgePortServer = http.createServer();
  await listen(bridgePortServer);
  const bridgePort = bridgePortServer.address().port;
  await new Promise((resolve) => bridgePortServer.close(resolve));
  const requestLog = path.join(os.tmpdir(), `glory-bridge-stream-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      BRIDGE_REQUEST_LOG: requestLog,
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      VISION_DISABLE: '1',
      BRIDGE_STREAM_IDLE_TIMEOUT_MS: '1000',
      BRIDGE_STREAM_TOTAL_TIMEOUT_MS: '5000',
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

  const base = `http://127.0.0.1:${bridgePort}`;
  await waitForHealth(`${base}/health`, child);
  const fragmented = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(requestBody('fragmented')),
  });
  const fragmentedEvents = await fragmented.text();
  assert.equal(fragmented.status, 200);
  assert.match(fragmentedEvents, /🙂/u);
  assert.match(fragmentedEvents, /response.completed/);

  const truncated = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(requestBody('truncated')),
  });
  const truncatedEvents = await truncated.text();
  assert.equal(truncated.status, 200);
  assert.match(truncatedEvents, /response.failed/);
  assert.doesNotMatch(truncatedEvents, /response.completed/);

  const stalled = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(requestBody('stall')),
  });
  const stalledEvents = await stalled.text();
  assert.equal(stalled.status, 200);
  assert.match(stalledEvents, /response.failed/);
  assert.doesNotMatch(stalledEvents, /response.completed/);

  const cancellation = http.request(`${base}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test',
      'Content-Length': Buffer.byteLength(JSON.stringify(requestBody('cancel'))),
    },
  });
  cancellation.on('error', (error) => {
    if (error.code !== 'ECONNRESET') throw error;
  });
  cancellation.end(JSON.stringify(requestBody('cancel')));
  await started;
  cancellation.destroy();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream cancellation was not observed')), 1500)),
  ]);
});
