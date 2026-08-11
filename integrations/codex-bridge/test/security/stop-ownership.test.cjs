const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../../../..');
const stopScript = path.join(root, 'integrations/codex-bridge/bridge/stop-bridge.ps1');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('stop -Force rejects a PID file that is not listening on the requested port', async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stop-ownership-'));
  const port = await freePort();
  fs.writeFileSync(path.join(runtime, 'bridge.pid'), `${process.pid}\n`, 'utf8');
  try {
    await assert.rejects(
      execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScript,
        '-RuntimeDataDir', runtime, '-Port', String(port), '-Force', '-WaitReleaseSeconds', '0',
      ], { windowsHide: true, timeout: 10_000 }),
      /listener del puerto|se rechaza detenerlo/i,
    );
    process.kill(process.pid, 0);
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
