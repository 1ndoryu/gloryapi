'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}`;
  const backup = `${filePath}.bak.${process.pid}`;
  fs.writeFileSync(temp, value, 'utf8');
  const hadTarget = fs.existsSync(filePath);
  try {
    if (hadTarget) fs.renameSync(filePath, backup);
    fs.renameSync(temp, filePath);
    if (hadTarget) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    throw error;
  }
}

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 5000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`catalog HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('catalog returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('catalog timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const [, , outputPath, endpoint = 'http://127.0.0.1:3101/api/integrations/codex-bridge/catalog'] = process.argv;
  if (!outputPath) throw new Error('Usage: node sync-model-catalog.cjs <output-json> [endpoint]');
  const token = String(process.env.GLORY_API_KEY || '').trim();
  if (!token) throw new Error('GLORY_API_KEY is required through the protected environment');
  const projection = await requestJson(endpoint, token);
  if (!projection || projection.schemaVersion !== 'glory-bridge-model-catalog-v2' || !Array.isArray(projection.entries)) {
    throw new Error('catalog projection schema mismatch');
  }
  const entries = projection.entries.map(entry => ({
    id: entry.id,
    wireModel: entry.wireModel || entry.id,
    pickerId: entry.pickerId || null,
    provider: entry.provider || 'auto',
    displayName: entry.displayName,
    nativeVision: entry.nativeVision === true,
    supportsReasoning: entry.supportsReasoning === true,
    contextWindow: 150000,
  }));
  if (!entries.some(entry => entry.id === 'auto')) throw new Error('catalog projection omitted auto');
  const hash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  if (projection.hash !== hash) throw new Error('catalog projection hash mismatch');
  // The projection has been fetched from GloryAPI and its hash was verified
  // against the canonical entries. Mark the local envelope as published so
  // the bridge does not classify a valid synchronized catalog as stale after
  // restart.
  writeAtomic(outputPath, JSON.stringify({ schemaVersion: projection.schemaVersion, state: 'published', revision: projection.revision, hash: projection.hash, entries }, null, 2));
  process.stdout.write(`bridge catalog synchronized revision=${projection.revision} entries=${entries.length}\n`);
}

main().catch(error => {
  process.stderr.write(`bridge catalog sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
