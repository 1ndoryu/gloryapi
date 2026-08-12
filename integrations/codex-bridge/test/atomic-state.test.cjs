const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readBoundedJson, writeJsonAtomic } = require('../bridge/atomic-json');
const { createReasoningCache } = require('../bridge/reasoning-cache');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-bridge-state-'));
}

test('atomic JSON state leaves no temporary file and rejects oversized data', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  writeJsonAtomic(file, { version: 1, safe: true });
  assert.deepEqual(readBoundedJson(file), { version: 1, safe: true });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.throws(() => writeJsonAtomic(file, { value: 'x'.repeat(100) }, { maxBytes: 32 }), /bounded JSON/);
});

test('reasoning cache expires entries, filters synthetic text and persists bounded JSON atomically', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'reasoning.json');
  let clock = 1000;
  const cache = createReasoningCache({
    file,
    fallback: 'synthetic fallback',
    log: () => {},
    ttlMs: 10,
    now: () => clock,
  });
  cache.rememberReasoning('call-1', 'real reasoning');
  cache.rememberReasoning('call-2', 'synthetic fallback');
  assert.equal(cache.reasoningFor('call-1'), 'real reasoning');
  assert.equal(cache.reasoningFor('call-2'), null);
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.deepEqual(Object.keys(readBoundedJson(file)), ['call-1']);
  clock = 1011;
  assert.equal(cache.reasoningFor('call-1'), null);
  assert.deepEqual(fs.readdirSync(dir), ['reasoning.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
