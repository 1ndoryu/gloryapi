const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../../../..');
const startScript = path.join(root, 'integrations/codex-bridge/bridge/start-gloryapi.ps1');
const probeScript = path.join(root, 'integrations/codex-bridge/fixtures/environment-probe.cjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('GloryAPI child environment excludes bridge and upstream credentials', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-env-'));
  const probe = path.join(temp, 'environment.json');
  const port = await freePort();
  let pid;
  try {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript,
      '-NodePath', process.execPath,
      '-NodeScriptOverride', probeScript,
      '-EnvironmentProbePath', probe,
      '-RuntimeDataDir', temp,
      '-Port', String(port),
    ], {
      timeout: 20_000,
      windowsHide: true,
      env: {
        ...process.env,
        BRIDGE_CLIENT_TOKEN: 'probe-client-secret',
        GLORY_API_KEY: 'probe-upstream-secret',
        FREEL_API_KEY: 'probe-legacy-secret',
        BRIDGE_RUNTIME_DIR: 'probe-runtime-dir',
      },
    });
    const env = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.equal(env.bridgeClientToken, null);
    assert.equal(env.gloryApiKey, null);
    assert.equal(env.freelApiKey, null);
    assert.equal(env.bridgeRuntimeDir, null);
    pid = Number(fs.readFileSync(path.join(temp, 'gloryapi.pid'), 'utf8').trim());
  } finally {
    if (pid) {
      try { await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* already stopped */ }
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows may release handles shortly after taskkill */ }
  }
});
