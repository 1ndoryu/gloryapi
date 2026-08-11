const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createDeterministicUpstream } = require('../../integrations/codex-bridge/test/deterministic-upstream.cjs');
const { createBoundedCapture } = require('./bounded-output.cjs');
const { readResponseTextBounded, requestResponsesStream } = require('./http-helpers.cjs');
const { sanitizePluginConfig } = require('./plugin-config.cjs');

const root = path.resolve(__dirname, '../..');
const node = process.execPath;
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const codexEntryPoint = process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  : null;
function resolveCodexLauncher() {
  if (codexEntryPoint && fs.existsSync(codexEntryPoint)) {
    return { command: node, prefix: [codexEntryPoint], version: 'node-entrypoint' };
  }
  const sandboxCodex = path.join(process.env.USERPROFILE || os.homedir(), '.codex', '.sandbox-bin', 'codex.exe');
  if (process.platform === 'win32' && fs.existsSync(sandboxCodex)) {
    return { command: sandboxCodex, prefix: [], version: 'sandbox-binary' };
  }
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, ['codex'], { encoding: 'utf8', windowsHide: true });
  const command = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() : null;
  if (!command) throw new Error('Codex CLI launcher was not found');
  return { command, prefix: [], version: 'native-binary' };
}
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-canary-'));
const dbPath = path.join(dbDir, 'canary.db');
const codexHome = path.join(dbDir, 'codex-home');
const requestLog = path.join(dbDir, 'bridge.requests.log');
const failedRequestLog = path.join(dbDir, 'failed_requests.log');
const canaryAdminToken = 'gloryapi-canary-admin-token';
const canaryRoutingToken = 'gloryapi-canary-routing-token';
const bridgeFile = path.join(root, 'integrations', 'codex-bridge', 'bridge', 'server.js');
const prepareProfileScript = path.join(root, 'integrations', 'codex-bridge', 'mode', 'prepare-canary-profile.ps1');
const authScript = path.join(root, 'integrations', 'codex-bridge', 'mode', 'get-codex-auth.ps1');
const childProcesses = [];
const MAX_CANARY_OUTPUT_BYTES = 1024 * 1024;
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
  const helper = path.join(root, 'server', 'dist', 'scripts', 'bridge-upstream-auth.js');
  const result = spawnSync(node, [helper, '--print'], {
    cwd: root,
    env: { ...process.env, GLORYAPI_DB_PATH: dbPath },
    encoding: 'utf8',
    windowsHide: true,
  });
  const token = result.stdout.trim();
  if (result.status !== 0 || !token) throw new Error('unified API key was not initialized');
  return token;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const raw = await readResponseTextBounded(response);
  let body = null;
  try { body = JSON.parse(raw); } catch {}
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

function preparePluginCanaryConfig() {
  const sourcePath = path.join(process.env.USERPROFILE || os.homedir(), '.codex', 'config.chatgpt.toml');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const expectedMarketplaceSource = path.join(
    process.env.USERPROFILE || os.homedir(),
    '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled',
  );
  if (!fs.existsSync(expectedMarketplaceSource)) {
    throw new Error(`bundled marketplace source is not available locally: ${expectedMarketplaceSource}`);
  }
  const configPath = path.join(codexHome, 'config.toml');
  const content = sanitizePluginConfig(source, { expectedMarketplaceSource });
  fs.writeFileSync(configPath, content, 'utf8');
  return configPath;
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2_000).then(() => { try { child.kill('SIGKILL'); } catch {} }),
  ]);
}

async function runCodexCommand(codexLauncher, codexHome, dbPath, codexArgs) {
  const codex = spawn(codexLauncher.command, codexArgs, {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      GLORYAPI_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  childProcesses.push(codex);
  const capture = createBoundedCapture(MAX_CANARY_OUTPUT_BYTES);
  let outputLimitExceeded = false;
  const appendBounded = (stream, chunk) => {
    if (outputLimitExceeded) return;
    capture.append(stream, chunk);
    if (capture.exceeded) {
      outputLimitExceeded = true;
      try { codex.kill('SIGTERM'); } catch {}
    }
  };
  codex.stdout.on('data', chunk => appendBounded('stdout', chunk));
  codex.stderr.on('data', chunk => appendBounded('stderr', chunk));
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
      appendBounded('stderr', `spawn error: ${error.message}`);
      finish(1);
    });
    codex.once('exit', code => finish(code ?? 1));
  });
  return {
    exitCode,
    output: capture.text('stdout'),
    errorOutput: capture.text('stderr'),
    outputLimitExceeded,
  };
}

async function runCodexExec(codexLauncher, codexHome, dbPath, prompt, { pluginsEnabled = false } = {}) {
  const pluginFeatureOverride = pluginsEnabled ? 'features.plugins=true' : 'features.plugins=false';
  return runCodexCommand(codexLauncher, codexHome, dbPath, [
    ...codexLauncher.prefix,
    'exec', '--profile', 'gloryapi-canary', '--json', '--ephemeral', '--skip-git-repo-check',
    '-c', pluginFeatureOverride,
    prompt,
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
    token: ['canary-andoryyu-fail', 'canary-zen', 'canary-go'],
    port: 0,
  });

  const runtimeEnv = {
    NODE_ENV: 'development',
    PORT: String(serverPort),
    GLORYAPI_DB_PATH: dbPath,
    ENCRYPTION_KEY: '0'.repeat(64),
    GLORYAPI_CANARY_MODE: '1',
    GLORYAPI_ADMIN_AUTH_TOKEN: canaryAdminToken,
    GLORYAPI_CANARY_ROUTING_TOKEN: canaryRoutingToken,
    GLORYAPI_CANARY_UPSTREAM_URL: `http://127.0.0.1:${upstream.port}/v1`,
    GLORYAPI_FAILED_REQUESTS_LOG: failedRequestLog,
    BRIDGE_TOOL_PROFILE: 'generic',
  };
  serverProcess = spawnLogged(node, [path.join(root, 'server', 'dist', 'index.js')], runtimeEnv, 'glory-server');
  await waitFor(`http://127.0.0.1:${serverPort}/api/ping`, (response, body) => response.ok && body?.status === 'ok');

  const serverBase = `http://127.0.0.1:${serverPort}`;
  const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${canaryAdminToken}` };
  await requestJson(`${serverBase}/api/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ platform: 'andoryyu', key: 'canary-andoryyu-fail', label: 'isolated-canary-andoryyu' }),
  });
  const zenKey = await requestJson(`${serverBase}/api/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ platform: 'opencode-zen', key: 'canary-zen', label: 'isolated-canary-zen' }),
  });
  await requestJson(`${serverBase}/api/keys`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ platform: 'opencode-go', key: 'canary-go', label: 'isolated-canary-go' }),
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
    BRIDGE_CANARY_MODE: '1',
    BRIDGE_CANARY_ROUTING_TOKEN: canaryRoutingToken,
    BRIDGE_REQUEST_LOG: requestLog,
    VISION_DISABLE: '1',
  }, 'bridge');
  await waitFor(`http://127.0.0.1:${bridgePort}/health`, (response, body) => response.ok && body?.service === 'gloryapi-codex-bridge');
  const bridgeBase = `http://127.0.0.1:${bridgePort}`;
  const authHeaders = { Authorization: `Bearer ${localToken}` };
  const ready = await requestJson(`${bridgeBase}/ready`, { headers: authHeaders });
  if (ready.ready !== true) throw new Error(`bridge readiness failed: ${JSON.stringify(ready)}`);
  const lifecycle = await requestJson(`${bridgeBase}/lifecycle`, { headers: authHeaders });
  if (
    lifecycle.schema !== 'glory-codex-lifecycle-v1'
    || lifecycle.state !== 'ready'
    || lifecycle.acceptingRequests !== true
    || !lifecycle.transitions.includes('draining')
  ) {
    throw new Error(`bridge lifecycle contract failed: ${JSON.stringify(lifecycle)}`);
  }
  const capabilities = await requestJson(`${bridgeBase}/capabilities`, { headers: authHeaders });
  if (
    capabilities.schema !== 'glory-codex-capabilities-v2'
    || capabilities.lifecycle?.state !== 'ready'
    || capabilities.matrix?.[0]?.capabilities?.codexDesktopE2E?.status !== 'unverified'
    || capabilities.matrix?.[0]?.capabilities?.providerInference?.status !== 'unverified'
  ) {
    throw new Error(`bridge capability contract failed: ${JSON.stringify(capabilities)}`);
  }

  const providerCoverage = {};
  for (const provider of ['andoryyu', 'opencode-zen', 'opencode-go']) {
    const providerResponse = await requestJson(`${bridgeBase}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localToken}`,
        'X-Glory-Canary-Provider': provider,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `CANARY_PROVIDER_${provider}` }] }],
      }),
    });
    if (providerResponse?.output?.[0]?.content?.[0]?.text !== 'CANARY_OK') {
      throw new Error(`direct provider canary failed for ${provider}`);
    }
    providerCoverage[provider] = true;
  }

  const nonStreaming = await requestJson(`${bridgeBase}/v1/responses`, {
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

  const streamed = await requestResponsesStream(`${bridgeBase}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localToken}`,
      'X-Glory-Canary-Provider': 'opencode-zen',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_STREAM_CASE' }] }],
    }),
  });
  const streamedText = streamed.events
    .filter(entry => entry.event === 'response.output_text.delta')
    .map(entry => entry.data.delta || '')
    .join('');
  if (streamedText !== 'CANARY_OK'
    || streamed.events.some(entry => entry.event === 'response.failed')
    || !streamed.events.some(entry => entry.event === 'response.completed')
    || streamed.events.at(-1)?.data !== '[DONE]') {
    throw new Error(`stream canary response contract failed: ${JSON.stringify(streamed.events).slice(0, 4000)}`);
  }

  const continuityInput = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_CONTINUITY_START' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CANARY_CONTEXT_PRESERVED' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_CONTINUITY_NEXT' }] },
  ];
  for (const provider of ['andoryyu', 'opencode-zen', 'opencode-go']) {
    const switched = await requestJson(`${bridgeBase}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localToken}`,
        'X-Glory-Canary-Provider': provider,
      },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, input: continuityInput }),
    });
    if (switched?.output?.[0]?.content?.[0]?.text !== 'CANARY_OK') {
      throw new Error(`provider switch continuity failed for ${provider}`);
    }
  }
  if (JSON.stringify(upstream.state.continuityPlatforms) !== JSON.stringify(['andoryyu', 'opencode-zen', 'opencode-go'])) {
    throw new Error(`provider switch continuity routing failed: ${JSON.stringify(upstream.state.continuityPlatforms)}`);
  }

  let pluginToolset;
  try {
    pluginToolset = await requestJson(`${bridgeBase}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localToken}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: false,
        tools: [
          {
            type: 'namespace',
            name: 'mcp__node_repl',
            tools: [{ type: 'function', name: 'js', description: 'Run plugin JavaScript.' }],
          },
          {
            type: 'namespace',
            name: 'collaboration',
            tools: [{ type: 'function', name: 'spawn_agent', description: 'Start a bounded agent.' }],
          },
          { type: 'tool_search', name: 'tool_search', description: 'Discover additional plugin tools.' },
          { type: 'function', name: 'plugin_tool', description: 'A plugin-provided function.' },
        ],
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY_PLUGIN_CASE' }] }],
      }),
    });
  } catch (error) {
    throw new Error(`${error.message}; translated tools=${JSON.stringify(upstream.state.pluginToolNames)}`);
  }
  if (pluginToolset?.output?.[0]?.content?.[0]?.text !== 'CANARY_OK' || !upstream.state.pluginToolsetObserved) {
    throw new Error(`plugin/MCP toolset canary response contract failed: ${JSON.stringify(upstream.state.pluginToolNames)}`);
  }

  const toolLoop = await requestJson(`${bridgeBase}/v1/responses`, {
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

  const foreignToolsetResponse = await requestJson(`${bridgeBase}/v1/responses`, {
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
    headers: { Authorization: `Bearer ${canaryAdminToken}` },
  });
  const foreignTrace = foreignTraces?.traces?.find(trace => trace?.attempts?.some(attempt =>
    attempt.reason === 'foreign_toolset'));
  if (foreignTrace?.finalModel?.platform !== 'opencode-zen') {
    throw new Error(`foreign toolset trace contract failed: ${JSON.stringify(foreignTrace)}`);
  }
  const foreignRetryResponse = await requestJson(`${bridgeBase}/v1/responses`, {
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
    headers: { Authorization: `Bearer ${canaryAdminToken}` },
  });
  const foreignTraceCount = foreignRetryTraces?.traces?.filter(trace => trace?.attempts?.some(attempt =>
    attempt.reason === 'foreign_toolset')).length ?? 0;
  if (foreignTraceCount < 2) throw new Error('foreign toolset unexpectedly entered cooldown');

  const fallbackResponse = await requestJson(`${bridgeBase}/v1/responses`, {
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
    headers: { Authorization: `Bearer ${canaryAdminToken}` },
  });
  const fallbackTrace = traces?.traces?.find(trace => trace?.attempts?.some(attempt =>
    attempt.platform === 'andoryyu' && attempt.outcome === 'error'));
  if (fallbackTrace?.finalModel?.platform !== 'opencode-zen'
    || fallbackTrace?.attempts?.[0]?.platform !== 'andoryyu'
    || fallbackTrace?.attempts?.[0]?.outcome !== 'error') {
    throw new Error(`fallback trace contract failed: ${JSON.stringify(fallbackTrace)}`);
  }

  await prepareProfile(bridgePort);
  const codexLauncher = resolveCodexLauncher();
  const textRun = await runCodexExec(
    codexLauncher,
    codexHome,
    dbPath,
    'Reply with exactly CANARY_OK and nothing else.',
  );
  if (textRun.exitCode !== 0 || textRun.outputLimitExceeded || !textRun.output.includes('CANARY_OK')) {
    throw new Error(`Codex text canary did not complete: exit=${textRun.exitCode}; stderr=${textRun.errorOutput.slice(-1500)}; output=${textRun.output.slice(-1500)}`);
  }
  const toolRun = await runCodexExec(
    codexLauncher,
    codexHome,
    dbPath,
    'For CANARY_CODEX_TOOL_CASE, execute the available shell tool once, then reply with exactly CANARY_CODEX_TOOL_OK.',
  );
  if (toolRun.exitCode !== 0 || toolRun.outputLimitExceeded || !toolRun.output.includes('CANARY_CODEX_TOOL_OK') || !upstream.state.codexToolObserved) {
    throw new Error(`Codex tool canary did not complete: exit=${toolRun.exitCode}; stderr=${toolRun.errorOutput.slice(-1500)}; output=${toolRun.output.slice(-1500)}`);
  }

  preparePluginCanaryConfig();
  const pluginInstall = await runCodexCommand(codexLauncher, codexHome, dbPath, [
    ...codexLauncher.prefix,
    'plugin', 'add', 'browser@openai-bundled', '--json',
    '-c', 'features.plugins=true',
  ]);
  if (pluginInstall.exitCode !== 0 || pluginInstall.outputLimitExceeded) {
    throw new Error(`Codex plugin installation canary did not complete: exit=${pluginInstall.exitCode}; stderr=${pluginInstall.errorOutput.slice(-2000)}; output=${pluginInstall.output.slice(-2000)}`);
  }
  const pluginSkillRun = await runCodexExec(
    codexLauncher,
    codexHome,
    dbPath,
    'For CANARY_CODEX_PLUGIN_CASE, use [@Browser](plugin://browser@openai-bundled) instructions if present, then reply exactly CANARY_CODEX_PLUGIN_OK.',
    { pluginsEnabled: true },
  );
  if (pluginSkillRun.exitCode !== 0
    || pluginSkillRun.outputLimitExceeded
    || !pluginSkillRun.output.includes('CANARY_CODEX_PLUGIN_OK')
    || !upstream.state.codexPluginObserved) {
    throw new Error(`Codex plugin-skill canary did not complete: exit=${pluginSkillRun.exitCode}; stderr=${pluginSkillRun.errorOutput.slice(-2000)}; output=${pluginSkillRun.output.slice(-2000)}; tools=${JSON.stringify(upstream.state.codexPluginToolNames)}; markers=${JSON.stringify(upstream.state.codexPluginMarkers)}`);
  }

  process.stdout.write(JSON.stringify({
    status: 'PASS',
    codexVersion: codexLauncher.version,
    response: 'CANARY_OK',
    readiness: true,
    lifecycle: true,
    capabilities: true,
    nonStreaming: true,
    internalToolLoop: true,
    codexToolExecution: true,
    pluginSkillForwarding: true,
    fallback: true,
    foreignToolset: true,
    foreignToolsetNoCooldown: true,
    stream: true,
    providerSwitching: true,
    pluginTooling: true,
    isolated: true,
    providerCoverage,
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
