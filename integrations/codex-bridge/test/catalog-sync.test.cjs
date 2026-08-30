'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('catalog sync publica un envelope verificado para que el bridge no quede stale', async () => {
  const entries = [{
    id: 'auto',
    wireModel: 'auto',
    pickerId: 'codex-auto-review',
    provider: 'auto',
    displayName: 'Auto (router de GloryAPI)',
    nativeVision: false,
    acceptsImageInput: true,
    supportsReasoning: true,
    contextWindow: 150000,
    routeId: 'route:auto',
  }];
  const hashEntries = entries.map(({ routeId: _routeId, ...entry }) => entry);
  const projection = {
    schemaVersion: 'glory-bridge-model-catalog-v2',
    revision: 4,
    hash: crypto.createHash('sha256').update(JSON.stringify(hashEntries)).digest('hex'),
    entries,
  };
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer sync-test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(projection));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-catalog-sync-'));
  const output = path.join(runtime, 'bridge-model-catalog.json');
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/catalog`;
    const script = path.resolve(__dirname, '..', 'mode', 'sync-model-catalog.cjs');
    const child = spawn(process.execPath, [script, output, endpoint], {
      env: { ...process.env, GLORY_API_KEY: 'sync-test' },
      encoding: 'utf8',
      windowsHide: true,
    });
    const result = await new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const envelope = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(envelope.state, 'published');
    assert.equal(envelope.revision, 4);
    assert.equal(envelope.hash, projection.hash);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
