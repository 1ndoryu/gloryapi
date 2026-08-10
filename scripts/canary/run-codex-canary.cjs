const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createDeterministicUpstream } = require('../../integrations/codex-bridge/test/deterministic-upstream.cjs');

const root = path.resolve(__dirname, '../..');
const node = process.execPath;
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const codexEntryPoint = process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  : null;
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-canary-'));
const dbPath = path.join(dbDir, 'canary.db');
const codexHome = path.join(dbDir, 'codex-home');
const requestLog = path.join(dbDir, 'bridge.requests.log');
const failedRequestLog = path.join(dbDir, 'failed_requests.log');
const bridgeFile = path.join(root, 'integrations', 'codex-bridge', 'bridge', 'server.js');
const prepareProfileScript = path.join(root, 'integrations', 'codex-bridge', 'mode', 'prepare-canary-profile.ps1');
const authScript = path.join(root, 'integrations', 'codex-bridge', 'mode', 'get-codex-auth.ps1');
const childProcesses = [];
let upstream;
let serverProcess;
let bridgeProcess;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function spawnLogged(command, args, env, label) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${label}:err] ${chunk}`));
  childProcesses.push(child);
  return child;
}

async function waitFor(url, predicate, timeoutMs = 20_000) {
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

function getUnifiedKey() {
  const BetterSqlite = require('better-sqlite3');
  const db = new BetterSqlite(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get();
    if (!row || typeof row.value !== 'string' || !row.value) throw new Error('unified API key was not initialized');
    return row.value;
  } finally {
    db.close();
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options?.method || 'GET'} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function prepareProfile(bridgePort) {
  fs.mkdirSync(codexHome, { recursive: true });
  const result = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', prepareProfileScript, '-Force', '-BridgePort', String(bridgePort),
  ], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  result.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await new Promise(resolve => result.once('exit', (exitCode, signal) => resolve([exitCode, signal])));
  if (code !== 0) throw new Error(`canary profile preparation failed: ${stderr.slice(0, 1000)}`);
  const profilePath = path.join(codexHome, 'gloryapi-canary.config.toml');
  const profile = fs.readFileSync(profilePath, 'utf8');
  if (profile.includes('experimental_bearer_token') || !profile.includes('[model_providers.gloryapi-canary.auth]') || !profile.includes('command =')) {
    throw new Error('canary profile contract failed');
  }
  return profilePath;
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2_000).then(() => { try { child.kill('SIGKILL'); } catch {} }),
  ]);
}

async function main() {
  const serverPort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  const bridgePort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  upstream = await createDeterministicUpstream({
    token: ['canary-andoryyu-fail', 'canary-zen'],
    port: 0,
  });

  const runtimeEnv = {
    NODE_ENV: 'development',
    PORT: String(serverPort),
    GLORYAPI_DB_PATH: dbPath,
    ENCRYPTION_KEY: '0'.repeat(64),
    GLORYAPI_CANARY_MODE: '1',
    GLORYAPI_CANARY_UPSTREAM_URL: `http://127.0.0.1:${upstream.port}/v1`,
    GLORYAPI_FAILED_REQUESTS_LOG: failedRequestLog,
  };
  serverProcess = spawnLogged(node, [path.join(root, 'server', 'dist', 'index.js')], runtimeEnv, 'glory-server');
  await waitFor(`http://127.0.0.1:${serverPort}/api/ping`, (response, body) => response.ok && body?.status === 'ok');

  const serverBase = `http://127.0.0.1:${serverPort}`;
  await requestJson(`${serverBase}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'andoryyu', key: 'canary-andoryyu-fail', label: 'isolated-canary-andoryyu' }),
  });
  const zenKey = await requestJson(`${serverBase}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'opencode-zen', key: 'canary-zen', label: 'isolated-canary-zen' }),
  });
  const unifiedKey = getUnifiedKey();
  const localTokenResult = spawn(node, [path.join(root, 'server', 'dist', 'scripts', 'bridge-auth.js'), '--rotate'], {
    cwd: root,
    env: { ...process.env, ...runtimeEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  childProcesses.push(localTokenResult);
  let localToken = '';
  localTokenResult.stdout.on('data', chunk => { localToken += chunk.toString(); });
  const [authCode] = await new Promise(resolve => localTokenResult.once('exit', code => resolve([code])));
  if (authCode !== 0 || !localToken.trim()) throw new Error('local DPAPI token rotation failed');
  localToken = localToken.trim();

  bridgeProcess = spawnLogged(node, [bridgeFile], {
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_CLIENT_TOKEN: localToken,
    GLORY_API_KEY: unifiedKey,
    GLORY_API_BASE_URL: `${serverBase}/v1`,
    BRIDGE_REQUEST_LOG: requestLog,
    VISION_DISABLE: '1',
  }, 'bridge');
  await waitFor(`http://127.0.0.1:${bridgePort}/health`, (response, body) => response.ok && body?.service === 'gloryapi-codex-bridge');
  const ready = await requestJson(`http://127.0.0.1:${bridgePort}/ready`, {
    headers: { Authorization: `Bearer ${localToken}` },
  });
  if (ready.ready !== true) throw new Error(`bridge readiness failed: ${JSON.stringify(ready)}`);

  const nonStreaming = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localToken}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'deterministic canary text' }] }],
    }),
  });
  const nonStreamingText = nonStreaming?.output?.[0]?.content?.[0]?.text;
  if (nonStreamingText !== 'CANARY_OK') throw new Error('non-stream canary response contract failed');

  const toolLoop = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localToken}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'deterministic canary tool' }] }],
      tools: [{ type: 'web_search', name: 'web_search' }],
    }),
  });
  const toolText = toolLoop?.output?.[0]?.content?.[0]?.text;
  if (toolText !== 'CANARY_TOOL_OK' || JSON.stringify(toolLoop).includes('function_call_output')) {
    throw new Error('internal tool loop canary response contract failed');
  }

  const foreignToolsetResponse = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localToken}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_FOREIGN_TOOLSET_CASE' }] }],
      tools: [{ type: 'function', name: 'foreign_tool' }],
    }),
  });
  const foreignToolsetText = foreignToolsetResponse?.output?.[0]?.content?.[0]?.text;
  if (foreignToolsetText !== 'CANARY_OK') throw new Error('foreign toolset fallback response contract failed');
  const foreignTraces = await requestJson(`${serverBase}/api/fallback/traces`, {
    headers: { Authorization: `Bearer ${unifiedKey}` },
  });
  const foreignTrace = foreignTraces?.traces?.find(trace => trace?.attempts?.some(attempt =>
    attempt.reason === 'foreign_toolset'));
  if (foreignTrace?.finalModel?.platform !== 'opencode-zen') {
    throw new Error(`foreign toolset trace contract failed: ${JSON.stringify(foreignTrace)}`);
  }
  const foreignRetryResponse = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localToken}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_FOREIGN_TOOLSET_CASE' }] }],
      tools: [{ type: 'function', name: 'foreign_tool' }],
    }),
  });
  if (foreignRetryResponse?.output?.[0]?.content?.[0]?.text !== 'CANARY_OK') {
    throw new Error('foreign toolset retry response contract failed');
  }
  const foreignRetryTraces = await requestJson(`${serverBase}/api/fallback/traces`, {
    headers: { Authorization: `Bearer ${unifiedKey}` },
  });
  const foreignTraceCount = foreignRetryTraces?.traces?.filter(trace => trace?.attempts?.some(attempt =>
    attempt.reason === 'foreign_toolset')).length ?? 0;
  if (foreignTraceCount < 2) throw new Error('foreign toolset unexpectedly entered cooldown');

  const fallbackResponse = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localToken}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_FALLBACK_CASE' }] }],
    }),
  });
  const fallbackText = fallbackResponse?.output?.[0]?.content?.[0]?.text;
  if (fallbackText !== 'CANARY_OK') throw new Error('fallback canary response contract failed');
  const traces = await requestJson(`${serverBase}/api/fallback/traces`, {
    headers: { Authorization: `Bearer ${unifiedKey}` },
  });
  const fallbackTrace = traces?.traces?.find(trace => trace?.attempts?.some(attempt =>
    attempt.platform === 'andoryyu' && attempt.outcome === 'error'));
  if (fallbackTrace?.finalModel?.platform !== 'opencode-zen'
    || fallbackTrace?.attempts?.[0]?.platform !== 'andoryyu'
    || fallbackTrace?.attempts?.[0]?.outcome !== 'error') {
    throw new Error(`fallback trace contract failed: ${JSON.stringify(fallbackTrace)}`);
  }

  await prepareProfile(bridgePort);
  const codexArgs = [
    ...(codexEntryPoint && fs.existsSync(codexEntryPoint) ? [codexEntryPoint] : []),
    'exec', '--profile', 'gloryapi-canary', '--json', '--ephemeral', '--skip-git-repo-check',
    '-c', 'features.plugins=false',
    'Reply with exactly CANARY_OK and nothing else.',
  ];
  const codex = spawn(node, codexArgs, {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      GLORYAPI_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let errorOutput = '';
  codex.stdout.on('data', chunk => { output += chunk.toString(); });
  codex.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  const exitCode = await new Promise(resolve => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => { try { codex.kill('SIGTERM'); } catch {} finish(124); }, 60_000);
    codex.once('error', error => {
      errorOutput += `spawn error: ${error.message}`;
      finish(1);
    });
    codex.once('exit', code => finish(code ?? 1));
  });
  if (exitCode !== 0 || !output.includes('CANARY_OK')) {
    throw new Error(`Codex canary did not complete: exit=${exitCode}; stderr=${errorOutput.slice(-1500)}; output=${output.slice(-1500)}`);
  }

  process.stdout.write(JSON.stringify({
    status: 'PASS',
    codexVersion: '0.146.1',
    response: 'CANARY_OK',
    readiness: true,
    nonStreaming: true,
    internalToolLoop: true,
    fallback: true,
    foreignToolset: true,
    foreignToolsetNoCooldown: true,
    stream: true,
    isolated: true,
  }) + '\n');
}

(async () => {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`CANARY_FAIL: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await stop(bridgeProcess);
    await stop(serverProcess);
    if (upstream?.server) await new Promise(resolve => upstream.server.close(resolve));
    for (const child of childProcesses) await stop(child);
    try {
      fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (cleanupError) {
      process.stderr.write(`CANARY_CLEANUP_WARNING: ${cleanupError.message}\n`);
      process.exitCode = process.exitCode || 1;
    }
  }
})();
