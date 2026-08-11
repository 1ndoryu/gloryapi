const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { formatRemoteFailure, responseByteLength } = require('../bridge/diagnostics');
const { createRequestLogger } = require('../bridge/request-log');

const bridgeFile = path.resolve(__dirname, '..', 'bridge', 'server.js');
const fixtureFile = path.resolve(__dirname, '..', 'fixtures', 'vision-error-fixture.cjs');
const preflightScript = path.resolve(__dirname, '..', 'mode', 'codex-activation-preflight.ps1');
const modeController = path.resolve(__dirname, '..', 'mode', 'codex-mode.ps1');

test('prompt-bearing remote diagnostics never serialize the provider body', () => {
  const secret = 'SECRET_QUERY';
  const vision = formatRemoteFailure('vision', { kind: 'http', status: 500, bytes: secret.length });
  const summary = formatRemoteFailure('summarize', { kind: 'transport', bytes: secret.length });
  assert.match(vision, /vision failed kind=http status=500 bytes=12/);
  assert.match(summary, /summarize failed kind=transport status=none bytes=12/);
  assert.doesNotMatch(`${vision}\n${summary}`, new RegExp(secret));
});

test('remote response size is metadata-only and bounded to a numeric content length', () => {
  assert.equal(responseByteLength({ headers: { get: () => '123' } }), 123);
  assert.equal(responseByteLength({ headers: { get: () => 'SECRET_QUERY' } }), 'unknown');
  assert.equal(responseByteLength({ headers: { get: () => null } }), 'unknown');
});

function runPreflight(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glory-codex-preflight-'));
  try {
    fs.writeFileSync(path.join(home, 'config.deepseek.toml'), config, 'utf8');
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', preflightScript,
      '-CodexHome', home, '-Json',
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.error, undefined, result.error?.message);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function contractStatus(result) {
  return result.checks.find((entry) => entry.id === 'deepseek-profile-contract')?.status;
}

const expectedAuthScript = path.resolve(__dirname, '..', 'mode', 'get-codex-auth.ps1').replaceAll('\\', '\\\\');
const validDeepseekProfile = `model = "deepseek-v4-flash"
model_provider = "gloryapi-canary"

[model_providers.gloryapi-canary]
base_url = "http://127.0.0.1:4100/v1"
wire_api = "responses"

[model_providers.gloryapi-canary.auth]
command = "powershell.exe"
args = ["-File", "${expectedAuthScript}"]
`;

test('activation preflight rejects unsafe or incomplete DeepSeek profiles', () => {
  assert.equal(contractStatus(runPreflight(validDeepseekProfile)), 'pass');
  assert.equal(contractStatus(runPreflight(validDeepseekProfile.replace('command = "powershell.exe"', '# command omitted'))), 'fail');
  assert.equal(contractStatus(runPreflight(`${validDeepseekProfile}\nexperimental_bearer_token = "redacted"`)), 'fail');
  assert.equal(contractStatus(runPreflight(validDeepseekProfile.replace('4100', '4000'))), 'fail');
  const authOnWrongProvider = validDeepseekProfile
    .replace('command = "powershell.exe"', 'command = "other-auth.exe"')
    .replace(/\n$/, `\n[model_providers.other.auth]\ncommand = "powershell.exe"\nargs = ["-File", "${expectedAuthScript}"]\n`);
  assert.equal(contractStatus(runPreflight(authOnWrongProvider)), 'fail');
  const authOnlyInComment = validDeepseekProfile
    .replace(`args = ["-File", "${expectedAuthScript}"]`, 'args = ["-File", "other-auth.ps1"]\n# get-codex-auth.ps1');
  assert.equal(contractStatus(runPreflight(authOnlyInComment)), 'fail');
  assert.equal(contractStatus(runPreflight(validDeepseekProfile.replace('deepseek-v4-flash', 'other-model'))), 'fail');
  assert.equal(contractStatus(runPreflight(validDeepseekProfile.replace(expectedAuthScript, `${expectedAuthScript}-evil`))), 'fail');
  assert.equal(contractStatus(runPreflight(validDeepseekProfile.replace('"-File", "', '"--script", "'))), 'fail');
  assert.equal(contractStatus(runPreflight(validDeepseekProfile.replace(expectedAuthScript, 'C:\\\\temp\\\\get-codex-auth.ps1'))), 'fail');
});

test('mode controller rejects an invalid profile before starting or mutating the temp Codex home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glory-codex-mode-'));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const config = path.join(codexHome, 'config.toml');
  const deepseek = path.join(codexHome, 'config.deepseek.toml');
  fs.writeFileSync(config, 'model = "gpt-5.6-luna"\n', 'utf8');
  fs.writeFileSync(deepseek, 'model = "deepseek-v4-flash"\nmodel_provider = "freellm"\n', 'utf8');
  const before = fs.readFileSync(config);
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', modeController,
      '-Mode', 'deepseek',
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, USERPROFILE: home } });
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(config), before);
    assert.equal(fs.existsSync(path.join(codexHome, 'bridge', 'bridge.pid')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('request logs rotate and retain only the configured number of files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glory-bridge-log-'));
  const file = path.join(directory, 'bridge.log');
  const logger = createRequestLogger({
    file,
    maxBytes: 64,
    retention: 2,
    sanitize: (entry) => entry,
  });
  logger({ message: 'a'.repeat(48) });
  logger({ message: 'b'.repeat(48) });
  logger({ message: 'c'.repeat(48) });
  logger({ message: 'd'.repeat(48) });
  logger({ message: 'e'.repeat(48) });
  await logger.flush();
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.equal(fs.existsSync(`${file}.2`), true);
  assert.equal(fs.existsSync(`${file}.3`), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('request log queue is bounded and oversized entries are downgraded', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glory-bridge-log-bounded-'));
  const delayed = () => new Promise((resolve) => setTimeout(resolve, 25));
  const queued = createRequestLogger({
    file: path.join(directory, 'queued.log'),
    maxBytes: 64,
    retention: 1,
    queueCapacity: 2,
    appendFile: delayed,
    sanitize: (entry) => entry,
  });
  for (let index = 0; index < 20; index += 1) queued({ index });
  assert.ok(queued.stats().droppedLogEntries >= 18);

  const oversizedFile = path.join(directory, 'oversized.log');
  const oversized = createRequestLogger({
    file: oversizedFile,
    maxBytes: 64,
    retention: 1,
    sanitize: (entry) => entry,
  });
  oversized({ body: 'x'.repeat(4096) });
  await oversized.flush();
  assert.ok(fs.statSync(oversizedFile).size <= 64);
  assert.equal(JSON.parse(fs.readFileSync(oversizedFile, 'utf8')).kind, 'log_entry_oversize');
  fs.rmSync(directory, { recursive: true, force: true });
});

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
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

test('vision upstream bodies never reach stderr', async (t) => {
  let upstreamBody = null;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const bridgePort = await reservePort();
  const requestLog = path.join(os.tmpdir(), `glory-bridge-vision-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${fixtureFile}`.trim(),
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      VISION_API_KEY: 'vision-test',
      VISION_BASE_URL: 'https://opencode.ai/zen/go/v1',
      VISION_DISABLE: '0',
      BRIDGE_REQUEST_LOG: requestLog,
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
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
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'describe this image' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
      ] }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output[0].content[0].text, 'ok');
  assert.match(stderr, /vision failed kind=http status=500 bytes=24/);
  assert.doesNotMatch(stderr, /SECRET_QUERY/);
  assert.doesNotMatch(JSON.stringify(upstreamBody), /SECRET_QUERY/);
});
