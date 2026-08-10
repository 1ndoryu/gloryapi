const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Codex version guard is read-only and fail-closed', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'canary', 'codex-version-guard.cjs'), 'utf8');
  assert.match(file, /--version/);
  assert.match(file, /blocked_fail_closed/);
  assert.doesNotMatch(file, /shell\s*:\s*true/);
  assert.match(file, /safeLauncher/);
  assert.doesNotMatch(file, /config\.toml|writeFile|BRIDGE_PORT/);
});

test('Codex version guard rejects a metacharacter launcher before spawning', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'canary', 'codex-version-guard.cjs'), 'utf8');
  assert.match(file, /configuredLauncher/);
  assert.match(file, /safeLauncher/);
  assert.match(file, /blocked_fail_closed/);
});
