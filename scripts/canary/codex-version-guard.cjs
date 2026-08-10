#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const allowed = new Set((process.env.GLORYAPI_CODEX_SUPPORTED_VERSIONS || '0.146.1')
  .split(',').map(value => value.trim()).filter(Boolean));
const configuredLauncher = (process.env.CODEX_BIN || '').trim();
const launcher = configuredLauncher || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const safeLauncher = process.platform === 'win32'
  ? /^[A-Za-z0-9_-]+(?:\.cmd|\.exe)?$/i.test(launcher)
  : /^[A-Za-z0-9_.:\\/\/-]+$/.test(launcher) && !launcher.includes('..\\') && !launcher.includes('../');
if (!safeLauncher) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 'glory-codex-version-guard-v1',
    version: null,
    supported: false,
    allowed: [...allowed],
    action: 'blocked_fail_closed',
  }) + '\n');
  process.exit(1);
}

let result;
if (process.platform === 'win32') {
  // The npm install exposes a cmd shim. Invoke the fixed Windows interpreter
  // directly; do not let spawn construct a shell command from CODEX_BIN.
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  if (!/^[A-Za-z]:\\Windows\\System32\\cmd\.exe$/i.test(comspec)) {
    process.stdout.write(JSON.stringify({
      schemaVersion: 'glory-codex-version-guard-v1', version: null,
      supported: false, allowed: [...allowed], action: 'blocked_fail_closed',
    }) + '\n');
    process.exit(1);
  }
  result = spawnSync(comspec, ['/d', '/s', '/c', `${launcher} --version`], {
    encoding: 'utf8', windowsHide: true,
  });
} else {
  result = spawnSync(launcher, ['--version'], { encoding: 'utf8', windowsHide: true });
}
const output = `${result.stdout || ''} ${result.stderr || ''}`.trim();
const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
const version = match?.[1] ?? null;
const supported = Boolean(version && allowed.has(version));
process.stdout.write(JSON.stringify({
  schemaVersion: 'glory-codex-version-guard-v1',
  version,
  supported,
  allowed: [...allowed],
  action: supported ? 'canary_allowed' : 'blocked_fail_closed',
}) + '\n');
process.exit(supported ? 0 : 1);
