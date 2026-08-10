'use strict';

const fs = require('fs');

async function rotateIfNeeded(file, maxBytes, retention, incomingBytes, fsApi = fs.promises) {
  let size = 0;
  try { size = (await fsApi.stat(file)).size; } catch {}
  if (size + incomingBytes <= maxBytes) return;

  for (let index = retention - 1; index >= 1; index -= 1) {
    const source = `${file}.${index}`;
    const target = `${file}.${index + 1}`;
    try {
      await fsApi.rm(target, { force: true });
      await fsApi.rename(source, target);
    } catch {}
  }
  try {
    const first = `${file}.1`;
    await fsApi.rm(first, { force: true });
    await fsApi.rename(file, first);
  } catch {}
}

function createRequestLogger({ file, maxBytes, retention, queueCapacity = 64, sanitize, appendFile = fs.promises.appendFile }) {
  let writeChain = Promise.resolve();
  let pending = 0;
  let droppedLogEntries = 0;
  const logger = (entry) => {
    if (pending >= queueCapacity) {
      droppedLogEntries += 1;
      return;
    }
    let line;
    try {
      line = `${JSON.stringify(sanitize(entry))}\n`;
    } catch {
      return;
    }
    let bytes = Buffer.from(line, 'utf8');
    if (bytes.length > maxBytes) {
      bytes = Buffer.from(JSON.stringify({ kind: 'log_entry_oversize', bytes: bytes.length }) + '\n', 'utf8');
    }
    pending += 1;
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await rotateIfNeeded(file, maxBytes, retention, bytes.length);
        await appendFile(file, bytes);
      })
      .catch(() => {})
      .finally(() => { pending -= 1; });
  };
  logger.stats = () => ({ pending, droppedLogEntries });
  logger.flush = () => writeChain;
  return logger;
}

module.exports = { createRequestLogger, rotateIfNeeded };
