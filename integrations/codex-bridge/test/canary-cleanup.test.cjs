const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const { closeServerBounded } = require('../../../scripts/canary/bounded-server-close.cjs');
const { cleanupCanaryResources } = require('../../../scripts/canary/canary-cleanup.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('bounded server close terminates an idle keep-alive socket', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  await closeServerBounded(server, 250);
  assert.equal(server.listening, false);
  socket.destroy();
});

test('bounded server close fails when the close callback never arrives', async () => {
  const server = {
    listening: true,
    close() {},
    closeAllConnections() {},
    closeIdleConnections() {},
  };
  await assert.rejects(closeServerBounded(server, 25), /did not close within 25ms/);
});

test('cleanup continues stopping children and removing runtime after one phase fails', async () => {
  const calls = [];
  await assert.rejects(cleanupCanaryResources({
    bridgeProcess: 'bridge',
    serverProcess: 'server',
    upstreamServer: 'upstream',
    childProcesses: ['bridge', 'codex-child'],
    stopChild: async child => {
      calls.push(`stop:${child}`);
      if (child === 'server') throw new Error('server stop failed');
    },
    closeServer: async () => {
      calls.push('close:upstream');
      throw new Error('upstream close failed');
    },
    removeRuntime: async () => { calls.push('remove:runtime'); },
  }), /server stop failed.*upstream close failed/);
  assert.deepEqual(calls, [
    'stop:bridge',
    'stop:server',
    'stop:codex-child',
    'close:upstream',
    'remove:runtime',
  ]);
});
