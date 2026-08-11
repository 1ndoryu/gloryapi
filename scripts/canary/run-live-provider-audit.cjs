#!/usr/bin/env node

/*
 * Optional live provider audit. It never edits the active Codex profile:
 * source DB -> temporary SQLite backup -> temporary GloryAPI -> temporary
 * bridge. Output is bounded routing metadata only.
 *
 * Usage:
 *   GLORYAPI_LIVE_DB_PATH=C:\path\to\gloryapi.db npm run canary:codex:live
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { readResponseTextBounded } = require('./http-helpers.cjs');
const { createSafeChildEnv } = require('./isolate-env.cjs');
const { findNewTrace, summarizeRoutingTrace, traceIds } = require('./routing-evidence.cjs');

const root = path.resolve(__dirname, '../..');
const node = process.execPath;
const dbSource = process.env.GLORYAPI_LIVE_DB_PATH?.trim();
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-live-audit-'));
const dbPath = path.join(runtimeDir, 'audit.db');
const requestLog = path.join(runtimeDir, 'bridge.requests.log');
const failedRequestLog = path.join(runtimeDir, 'failed_requests.log');
const serverEntry = path.join(root, 'server', 'dist', 'index.js');
const bridgeEntry = path.join(root, 'integrations', 'codex-bridge', 'bridge', 'server.js');
const adminToken = `live-audit-admin-${process.pid}-${Date.now()}`;
const clientToken = `live-audit-client-${process.pid}-${Date.now()}`;
const canaryRoutingToken = `live-audit-routing-${process.pid}-${Date.now()}`;
let serverProcess;
let bridgeProcess;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => null);
      if (predicate(response, body)) return body;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function spawnQuiet(command, args, env) {
  return spawn(command, args, {
    cwd: root,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(2_000).then(() => false),
  ]);
  if (exited || child.exitCode != null) return;
  try { child.kill('SIGKILL'); } catch (error) {
    throw new Error(`unable to force-stop temporary process: ${error.code || error.message}`);
  }
  const forceExited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(2_000).then(() => null),
  ]);
  if (forceExited === null && child.exitCode == null) throw new Error('temporary process did not exit');
}

async function removeRuntimeDir() {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      if (!fs.existsSync(runtimeDir)) return;
      lastError = new Error('temporary directory still exists after removal');
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`temporary audit cleanup failed: ${lastError?.code || lastError?.message || 'unknown error'}`);
}

async function backupDatabase(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Set GLORYAPI_LIVE_DB_PATH to an existing local GloryAPI database');
  }
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dbPath);
  } finally {
    source.close();
  }
}

function readUpstreamKey() {
  const helper = path.join(root, 'server', 'dist', 'scripts', 'bridge-upstream-auth.js');
  const result = spawnSync(node, [helper, '--print'], {
    cwd: root,
    env: createSafeChildEnv(process.env, { GLORYAPI_DB_PATH: dbPath }),
    encoding: 'utf8',
    windowsHide: true,
  });
  const key = result.stdout.trim();
  if (result.status !== 0 || !key) throw new Error('temporary DB did not yield an upstream credential');
  return key;
}

async function requestJsonAllowFailure(url, options) {
  const response = await fetch(url, options);
  const raw = await readResponseTextBounded(response, 128 * 1024);
  let body = null;
  try { body = JSON.parse(raw); } catch {}
  return { status: response.status, body };
}

async function requestStreamAllowFailure(url, options) {
  const response = await fetch(url, options);
  const raw = await readResponseTextBounded(response, 256 * 1024);
  const events = [];
  if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || null;
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      if (data === '[DONE]') events.push({ event, data });
      else {
        try { events.push({ event, data: JSON.parse(data) }); } catch { events.push({ event, data: null }); }
      }
    }
  }
  return { response, events };
}

async function readTraces(serverBase) {
  const response = await fetch(`${serverBase}/api/fallback/traces`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const raw = await readResponseTextBounded(response, 256 * 1024);
  if (!response.ok) throw new Error(`trace endpoint returned ${response.status}`);
  return JSON.parse(raw).traces;
}

function responseClassification(result) {
  if (result.status !== 200) return `http_${result.status}`;
  if (result.body?.output?.length) return 'completed';
  if (result.body?.error) return 'response_failed';
  return 'empty_response';
}

async function auditDirectProvider(bridgeBase, serverBase, provider) {
  const before = await readTraces(serverBase);
  const result = await requestJsonAllowFailure(`${bridgeBase}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${clientToken}`,
      'X-Glory-Canary-Provider': provider,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'LIVE_PROVIDER_AUDIT' }] }],
      max_output_tokens: 32,
    }),
  });
  const trace = findNewTrace(await readTraces(serverBase), traceIds(before));
  if (!trace) throw new Error(`no routing trace captured for ${provider}`);
  return {
    provider,
    nonStreaming: { status: result.status, classification: responseClassification(result) },
    routing: summarizeRoutingTrace(trace),
  };
}

async function auditDirectStream(bridgeBase, serverBase, provider) {
  const before = await readTraces(serverBase);
  const result = await requestStreamAllowFailure(`${bridgeBase}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${clientToken}`,
      'X-Glory-Canary-Provider': provider,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'LIVE_PROVIDER_AUDIT_STREAM' }] }],
      max_output_tokens: 32,
    }),
  });
  const trace = findNewTrace(await readTraces(serverBase), traceIds(before));
  if (!trace) throw new Error(`no streaming routing trace captured for ${provider}`);
  return {
    status: result.response.status,
    classification: result.response.status !== 200
      ? `http_${result.response.status}`
      : result.events.some(event => event.event === 'response.failed')
        ? 'response_failed'
        : result.events.some(event => event.event === 'response.completed')
          ? 'completed'
          : 'missing_terminal_event',
    done: result.events.some(event => event.data === '[DONE]'),
    routing: summarizeRoutingTrace(trace),
  };
}

async function auditNormalFallback(bridgeBase, serverBase) {
  const before = await readTraces(serverBase);
  const result = await requestJsonAllowFailure(`${bridgeBase}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'LIVE_NORMAL_FALLBACK_AUDIT' }] }],
      max_output_tokens: 32,
    }),
  });
  const trace = findNewTrace(await readTraces(serverBase), traceIds(before));
  if (!trace) throw new Error('no routing trace captured for the normal route');
  return {
    status: result.status,
    classification: responseClassification(result),
    routing: summarizeRoutingTrace(trace),
  };
}

async function main() {
  await backupDatabase(dbSource);
  const serverPort = await reservePort();
  const bridgePort = await reservePort();
  const upstreamKey = readUpstreamKey();
  const baseEnv = createSafeChildEnv(process.env);
  const serverEnv = {
    ...baseEnv,
    NODE_ENV: 'development',
    PORT: String(serverPort),
    GLORYAPI_DB_PATH: dbPath,
    ENCRYPTION_KEY: '0'.repeat(64),
    GLORYAPI_CANARY_MODE: '1',
    GLORYAPI_CANARY_ROUTING_TOKEN: canaryRoutingToken,
    GLORYAPI_ADMIN_AUTH_TOKEN: adminToken,
    GLORYAPI_FAILED_REQUESTS_LOG: failedRequestLog,
  };
  serverProcess = spawnQuiet(node, [serverEntry], serverEnv);
  const serverBase = `http://127.0.0.1:${serverPort}`;
  await waitFor(`${serverBase}/api/ping`, (response, body) => response.ok && body?.status === 'ok');

  bridgeProcess = spawnQuiet(node, [bridgeEntry], {
    ...baseEnv,
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_RUNTIME_DIR: runtimeDir,
    BRIDGE_CLIENT_TOKEN: clientToken,
    BRIDGE_UPSTREAM_API_KEY: upstreamKey,
    BRIDGE_UPSTREAM_BASE_URL: `${serverBase}/v1`,
    BRIDGE_UPSTREAM_AUTH_SCHEME: 'Bearer',
    BRIDGE_EXPECTED_UPSTREAM_CONTRACT: 'chat-completions-v1',
    BRIDGE_UPSTREAM_CONTRACT: 'chat-completions-v1',
    BRIDGE_HOST: '127.0.0.1',
    BRIDGE_MODEL: 'deepseek-v4-flash',
    BRIDGE_TOOL_PROFILE: 'generic',
    BRIDGE_CANARY_MODE: '1',
    BRIDGE_CANARY_ROUTING_TOKEN: canaryRoutingToken,
    BRIDGE_REQUEST_LOG: requestLog,
    VISION_DISABLE: '1',
  });
  const bridgeBase = `http://127.0.0.1:${bridgePort}`;
  await waitFor(`${bridgeBase}/health`, (response, body) => response.ok && body?.service === 'gloryapi-codex-bridge');
  const ready = await fetch(`${bridgeBase}/ready`, { headers: { Authorization: `Bearer ${clientToken}` } });
  if (!ready.ok) throw new Error('live audit bridge readiness failed');

  const normalFallback = await auditNormalFallback(bridgeBase, serverBase);
  const providers = {};
  for (const provider of ['andoryyu', 'opencode-zen', 'opencode-go']) {
    const direct = await auditDirectProvider(bridgeBase, serverBase, provider);
    const stream = await auditDirectStream(bridgeBase, serverBase, provider);
    providers[provider] = { ...direct, stream };
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 'glory-live-provider-audit-v1',
    status: 'PASS',
    isolated: true,
    activeCodexConfigChanged: false,
    normalFallback,
    providers,
  }) + '\n');
}

(async () => {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`LIVE_AUDIT_FAIL: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    const cleanupErrors = [];
    for (const child of [bridgeProcess, serverProcess]) {
      try { await stop(child); } catch (error) { cleanupErrors.push(error); }
    }
    try { await removeRuntimeDir(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      process.stderr.write(`LIVE_AUDIT_CLEANUP_FAIL: ${cleanupErrors.map(error => error.message).join('; ')}\n`);
      process.exitCode = 1;
    }
  }
})();
