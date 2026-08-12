const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const prepareScript = path.join(root, 'mode', 'prepare-isolated-home.ps1');
const launcherScript = path.join(root, 'mode', 'start-codex-bridge.ps1');

function waitForFile(filePath) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

test('isolated Codex home copies only config and preserves an independent state file', () => {
  if (process.platform !== 'win32') return;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-isolated-home-'));
  try {
    const sourceHome = path.join(temporaryRoot, 'normal');
    const bridgeHome = path.join(temporaryRoot, 'bridge');
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'model = "gpt-5.6-luna"\n[features]\njs_repl = false\n', 'utf8');
    fs.writeFileSync(path.join(sourceHome, 'models.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(sourceHome, 'auth.json'), 'normal-auth-sentinel', 'utf8');
    fs.writeFileSync(path.join(sourceHome, 'state_1.sqlite'), 'normal-state-sentinel', 'utf8');
    const statePath = path.join(bridgeHome, 'state_1.sqlite');
    fs.mkdirSync(bridgeHome, { recursive: true });
    fs.writeFileSync(statePath, 'bridge-owned-state', 'utf8');

    const result = spawnSync('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', prepareScript,
      '-SourceCodexHome', sourceHome,
      '-BridgeHome', bridgeHome,
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(bridgeHome, 'config.toml'), 'utf8'), fs.readFileSync(path.join(sourceHome, 'config.toml'), 'utf8'));
    const profile = fs.readFileSync(path.join(bridgeHome, 'gloryapi-bridge.config.toml'), 'utf8');
    assert.match(profile, /model_provider = "gloryapi-bridge"/);
    assert.match(profile, /CODEX_HOME = "/);
    assert.ok(profile.includes(bridgeHome.replaceAll('\\', '\\\\')));
    assert.match(profile, /base_url = "http:\/\/127\.0\.0\.1:4100\/v1/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'bridge-owned-state');
    assert.equal(fs.existsSync(path.join(bridgeHome, 'auth.json')), false);
    assert.equal(fs.readFileSync(path.join(sourceHome, 'auth.json'), 'utf8'), 'normal-auth-sentinel');
    assert.equal(fs.readFileSync(path.join(sourceHome, 'state_1.sqlite'), 'utf8'), 'normal-state-sentinel');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('bridge launcher passes the isolated CODEX_HOME and profile to CLI and Desktop', () => {
  if (process.platform !== 'win32') return;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-launcher-'));
  try {
    const sourceHome = path.join(temporaryRoot, 'normal');
    const bridgeHome = path.join(temporaryRoot, 'bridge');
    const stubDir = path.join(temporaryRoot, 'bin');
    const capturePath = path.join(temporaryRoot, 'capture.txt');
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'model = "gpt-5.6-luna"\n', 'utf8');
    fs.writeFileSync(path.join(stubDir, 'codex.ps1'), [
      '$lines = @(',
      '  "CODEX_HOME=$env:CODEX_HOME",',
      "  \"ARGS=$($args -join '|')\"",
      ')',
      'Set-Content -LiteralPath $env:CODEX_CAPTURE -Value $lines -Encoding utf8',
    ].join('\n'), 'utf8');

    const env = {
      ...process.env,
      PATH: `${stubDir};${process.env.PATH || ''}`,
      CODEX_CAPTURE: capturePath,
    };
    const commonArgs = [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherScript,
      '-SourceCodexHome', sourceHome,
      '-BridgeHome', bridgeHome,
      '-NoStartBridge',
    ];

    const cliResult = spawnSync('pwsh.exe', commonArgs, { cwd: root, env, encoding: 'utf8' });
    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    const cliCapture = fs.readFileSync(capturePath, 'utf8');
    assert.ok(cliCapture.includes(`CODEX_HOME=${bridgeHome}`));
    assert.match(cliCapture, /ARGS=--profile\|gloryapi-bridge/);

    fs.rmSync(capturePath, { force: true });
    const desktopResult = spawnSync('pwsh.exe', [...commonArgs, '-Desktop'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(desktopResult.status, 0, desktopResult.stderr || desktopResult.stdout);
    waitForFile(capturePath);
    const desktopCapture = fs.readFileSync(capturePath, 'utf8');
    assert.ok(desktopCapture.includes(`CODEX_HOME=${bridgeHome}`));
    assert.match(desktopCapture, /ARGS=--profile\|gloryapi-bridge\|app/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('safe mode switches leave the normal Codex home byte-for-byte unchanged', () => {
  if (process.platform !== 'win32') return;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-mode-switch-'));
  try {
    const userProfile = path.join(temporaryRoot, 'user');
    const normalHome = path.join(userProfile, '.codex');
    const configPath = path.join(normalHome, 'config.toml');
    fs.mkdirSync(normalHome, { recursive: true });
    fs.writeFileSync(configPath, 'model = "gpt-5.6-luna"\n', 'utf8');
    fs.writeFileSync(path.join(normalHome, 'auth.json'), 'normal-auth-sentinel', 'utf8');
    fs.writeFileSync(path.join(normalHome, 'state_1.sqlite'), 'normal-state-sentinel', 'utf8');
    const before = fs.readFileSync(configPath);
    const env = { ...process.env, USERPROFILE: userProfile };
    const modeScript = path.join(root, 'mode', 'codex-mode.ps1');

    for (const args of [['-Mode', 'chatgpt'], ['-Mode', 'deepseek', '-Preview']]) {
      const result = spawnSync('pwsh.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', modeScript, ...args,
      ], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(fs.readFileSync(configPath), before);
    }

    assert.equal(fs.existsSync(path.join(normalHome, 'config.toml.gloryapi.journal.json')), false);
    assert.equal(fs.readFileSync(path.join(normalHome, 'auth.json'), 'utf8'), 'normal-auth-sentinel');
    assert.equal(fs.readFileSync(path.join(normalHome, 'state_1.sqlite'), 'utf8'), 'normal-state-sentinel');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
