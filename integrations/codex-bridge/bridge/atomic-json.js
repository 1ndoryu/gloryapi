'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readBoundedJson(file, maxBytes = 4 * 1024 * 1024, fsApi = fs) {
  let stat;
  try {
    stat = fsApi.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('state file exceeds the bounded JSON contract');
  return JSON.parse(fsApi.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value, {
  maxBytes = 4 * 1024 * 1024,
  mode = 0o600,
  fsApi = fs,
} = {}) {
  const serialized = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) throw new Error('state payload exceeds the bounded JSON contract');

  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor;
  try {
    descriptor = fsApi.openSync(temporary, 'wx', mode);
    fsApi.writeFileSync(descriptor, serialized, { encoding: 'utf8' });
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = undefined;
    fsApi.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor); } catch {}
    }
    try { fsApi.rmSync(temporary, { force: true }); } catch {}
  }
  return { bytes, file };
}

module.exports = { readBoundedJson, writeJsonAtomic };
