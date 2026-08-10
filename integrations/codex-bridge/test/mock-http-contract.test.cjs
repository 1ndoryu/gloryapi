const assert = require('node:assert/strict');
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
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`bridge exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

test('mock upstream validates health, auth, limits and the internal web loop', async (t) => {
  const upstreamBodies = [];
  const upstreamAuthorizations = [];
  const upstreamRequestIds = [];
  const hangingResponses = new Set();
  const upstream = http.createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      upstreamAuthorizations.push(request.headers.authorization);
      upstreamRequestIds.push(request.headers['x-glory-request-id']);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      upstreamBodies.push(body);
      if (JSON.stringify(body.messages).includes('hang-body')) {
        hangingResponses.add(response);
        response.on('close', () => hangingResponses.delete(response));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"choices":[');
        return;
      }
      const hasToolResult = body.messages.some((message) => message.role === 'tool');
      const message = hasToolResult
        ? { role: 'assistant', content: 'Respuesta final después de consumir el resultado seguro.' }
        : {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_web_test',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"http://127.0.0.1/private"}' },
            }],
          };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ index: 0, message, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => {
    for (const response of hangingResponses) response.destroy();
    return new Promise((resolve) => upstream.close(resolve));
  });

  const bridgePort = await reservePort();
  const requestLog = path.join(os.tmpdir(), `freellm-bridge-test-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_MAX_BODY_BYTES: '4096',
      BRIDGE_UPSTREAM_TIMEOUT_MS: '300',
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      BRIDGE_REQUEST_LOG: requestLog,
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
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

  const base = `http://127.0.0.1:${bridgePort}`;
  const health = await waitForHealth(`${base}/health`, child);
  assert.equal(health.service, 'gloryapi-codex-bridge');
  assert.equal(health.model, 'deepseek-v4-flash');
  assert.equal(health.upstream, undefined);

  const models = await fetch(`${base}/v1/models`);
  assert.equal(models.status, 200);
  const modelsBody = await models.json();
  assert.deepEqual(modelsBody.models, modelsBody.data);
  assert.equal(modelsBody.models[0].owned_by, 'gloryapi');
  assert.equal(modelsBody.models[0].slug, modelsBody.models[0].id);

  const wrongMethod = await fetch(`${base}/v1/models`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get('allow') || '', /GET/);

  const longPath = await fetch(`${base}/${'x'.repeat(600)}`);
  assert.equal(longPath.status, 414);

  const unauthorizedReady = await fetch(`${base}/ready`);
  assert.equal(unauthorizedReady.status, 401);

  const ready = await fetch(`${base}/ready`, {
    headers: { Authorization: 'Bearer test' },
  });
  assert.equal(ready.status, 200);
  const readinessBody = await ready.json();
  assert.equal(readinessBody.ready, true);
  assert.equal(readinessBody.gloryApiContract, 'chat-completions-v1');

  const capabilities = await fetch(`${base}/v1/capabilities`, {
    headers: { Authorization: 'Bearer test' },
  });
  assert.equal(capabilities.status, 200);
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilitiesBody.schema, 'glory-codex-capabilities-v2');
  assert.equal(capabilitiesBody.lifecycle.schema, 'glory-codex-lifecycle-v1');
  assert.equal(capabilitiesBody.lifecycle.state, 'ready');
  assert.equal(capabilitiesBody.lifecycle.acceptingRequests, true);
  assert.deepEqual(capabilitiesBody.lifecycle.transitions, ['starting', 'ready', 'blocked', 'draining', 'stopped']);
  assert.equal(capabilitiesBody.capabilities.customTools, true);
  assert.equal(capabilitiesBody.capabilities.vision, false);
  assert.equal(capabilitiesBody.upstream, undefined);

  const unauthorized = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);

  const oversized = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: 'x'.repeat(5000),
  });
  assert.equal(oversized.status, 413);

  const wrongContentType = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer test' },
    body: '{}',
  });
  assert.equal(wrongContentType.status, 415);

  const unsupportedInput = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'missing item type' }] }],
    }),
  });
  assert.equal(unsupportedInput.status, 400);
  const unsupportedInputBody = await unsupportedInput.json();
  assert.equal(unsupportedInputBody.error.code, 'invalid_request');

  const result = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abre la URL' }] }],
      tools: [{ type: 'web_search', name: 'web_search' }],
    }),
  });
  assert.equal(result.status, 200);
  const bridgeRequestId = result.headers.get('x-glory-request-id');
  assert.match(bridgeRequestId || '', /^req_[a-f0-9]{32}$/);
  const events = await result.text();
  assert.equal(upstreamBodies.length, 2);
  const toolMessage = upstreamBodies[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /descarga directa de URL está deshabilitada/);
  assert.match(toolMessage.content, /Contenido web no confiable/);
  assert.match(events, /Respuesta final después de consumir el resultado seguro/);
  assert.doesNotMatch(events, /function_call_output/);
  assert.doesNotMatch(events, /Contenido de http:\/\/127\.0\.0\.1\/private/);

  const nonStreaming = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abre la URL' }] }],
      tools: [{ type: 'web_search', name: 'web_search' }],
    }),
  });
  assert.equal(nonStreaming.status, 200);
  const responseBody = await nonStreaming.json();
  assert.equal(upstreamBodies.length, 4);
  assert.equal(responseBody.output[0].content[0].text, 'Respuesta final después de consumir el resultado seguro.');
  assert.equal(responseBody.output.some((item) => item.type === 'function_call_output'), false);
  assert.ok(upstreamAuthorizations.length >= 4);
  assert.ok(upstreamAuthorizations.every((value) => value === 'Bearer upstream-test'));
  assert.ok(upstreamRequestIds.length >= 4);
  assert.ok(upstreamRequestIds.every((value) => /^req_[a-f0-9]{32}$/.test(value || '')));
  assert.equal(upstreamRequestIds[0], bridgeRequestId);
  assert.equal(upstreamRequestIds[1], bridgeRequestId);
  assert.notEqual(upstreamRequestIds[2], bridgeRequestId);
  assert.equal(upstreamAuthorizations.includes('Bearer test'), false);

  const hangingStartedAt = Date.now();
  const hanging = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hang-body' }] }],
    }),
  });
  assert.equal(hanging.status, 502, JSON.stringify(upstreamBodies.at(-1)));
  assert.match(JSON.stringify(await hanging.json()), /upstream timed out after 300 ms/);
  assert.ok(Date.now() - hangingStartedAt < 2000, 'the hanging body must be aborted promptly');
});
