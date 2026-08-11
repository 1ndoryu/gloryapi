const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createJsonLineClient } = require('../../../scripts/canary/app-server-canary.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write() {} };
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 143;
    child.emit('exit', 143);
  };
  return child;
}

test('app-server JSONL canary bounds total stdout and retained history', async () => {
  const child = fakeChild();
  const client = createJsonLineClient(child);
  const pending = client.waitFor(() => false, 10_000);
  const noise = `${JSON.stringify({ method: 'noise', params: { payload: 'x'.repeat(1024) } })}\n`;
  for (let index = 0; index < 2_100; index += 1) child.stdout.write(noise);

  await assert.rejects(pending, /bounded canary limit/);
  assert.ok(client.summary().length <= 100);
});
