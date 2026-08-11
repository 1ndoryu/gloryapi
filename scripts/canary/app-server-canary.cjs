const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSafeChildEnv } = require('./isolate-env.cjs');
const { createBoundedCapture } = require('./bounded-output.cjs');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_HISTORY_BYTES = 256 * 1024;
const MAX_MESSAGE_HISTORY = 256;
const TIMEOUT_MS = 60_000;

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2_000)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, 2_000)) && child.exitCode == null) {
    throw new Error('Codex app-server did not stop within the bounded cleanup window');
  }
}

function createJsonLineClient(child) {
  let nextId = 1;
  let buffer = '';
  const messages = [];
  let messageHistoryBytes = 0;
  let totalOutputBytes = 0;
  const waiters = [];
  const stderr = createBoundedCapture(MAX_OUTPUT_BYTES);

  const rejectAll = error => {
    while (waiters.length) waiters.shift().reject(error);
  };
  const remember = message => {
    const serialized = JSON.stringify(message);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    messages.push({ message, bytes });
    messageHistoryBytes += bytes;
    while (messages.length > MAX_MESSAGE_HISTORY || messageHistoryBytes > MAX_MESSAGE_HISTORY_BYTES) {
      const removed = messages.shift();
      messageHistoryBytes -= removed.bytes;
    }
  };
  const dispatch = message => {
    remember(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(message)) continue;
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  };
  const findStored = predicate => messages.find(entry => predicate(entry.message))?.message;
  const waitFor = (predicate, timeoutMs = TIMEOUT_MS) => {
    const stored = findStored(predicate);
    if (stored) return Promise.resolve(stored);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for Codex app-server protocol event'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    totalOutputBytes += Buffer.byteLength(chunk, 'utf8');
    if (totalOutputBytes > MAX_OUTPUT_BYTES) {
      rejectAll(new Error('Codex app-server stdout exceeded the bounded canary limit'));
      child.kill('SIGTERM');
      return;
    }
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_OUTPUT_BYTES) {
      rejectAll(new Error('Codex app-server stdout exceeded the bounded canary limit'));
      child.kill('SIGTERM');
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        rejectAll(new Error('Codex app-server emitted a non-JSONL stdout frame'));
        child.kill('SIGTERM');
        return;
      }
      if (message?.method && message?.id != null) {
        rejectAll(new Error(`Codex app-server requested unsupported client interaction: ${message.method}`));
        child.kill('SIGTERM');
        return;
      }
      dispatch(message);
    }
  });
  child.stderr.on('data', chunk => stderr.append('stderr', chunk));
  child.once('error', error => rejectAll(error));
  child.once('exit', code => {
    if (code !== 0) rejectAll(new Error(`Codex app-server exited before completing the canary (code ${code ?? 'unknown'})`));
  });

  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waitFor(message => message?.id === id);
    if (response.error) {
      const detail = JSON.stringify({
        code: response.error.code ?? 'unknown',
        message: typeof response.error.message === 'string' ? response.error.message.slice(0, 500) : undefined,
      });
      throw new Error(`Codex app-server ${method} failed: ${detail}`);
    }
    return response.result;
  };
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  const summary = () => messages.slice(-100).map(({ message }) => ({
    method: message.method || null,
    id: message.id ?? null,
    itemType: message.params?.item?.type || null,
    turnStatus: message.params?.turn?.status || null,
    markers: [...new Set(JSON.stringify(message).match(/CANARY_[A-Z0-9_]+/g) || [])],
  }));
  return { request, notify, waitFor, summary, stderr };
}

async function runCodexAppServerCanary({ launcher, codexHome, dbPath, cwd, profilePath }) {
  const configPath = path.join(codexHome, 'config.toml');
  const profile = fs.readFileSync(profilePath, 'utf8')
    .replace(/^model_catalog_json\s*=.*\r?\n/m, '');
  fs.writeFileSync(configPath, profile, 'utf8');

  const child = spawn(launcher.command, [
    ...launcher.prefix,
    'app-server', '--stdio',
  ], {
    cwd,
    env: createSafeChildEnv(process.env, {
      CODEX_HOME: codexHome,
      GLORYAPI_DB_PATH: dbPath,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = createJsonLineClient(child);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'gloryapi-canary', title: 'GloryAPI isolated canary', version: '1' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized', {});

    const threadResult = await client.request('thread/start', {
      model: 'deepseek-v4-flash',
      cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ephemeral: true,
    });
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return an ephemeral thread id');

    const runTurn = async (turnId, text) => {
      const turnResult = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        approvalPolicy: 'never',
      });
      const activeTurnId = turnResult?.turn?.id;
      if (!activeTurnId) throw new Error(`Codex app-server did not return a turn id for ${turnId}`);
      const completed = await client.waitFor(message => message?.method === 'turn/completed'
        && message.params?.threadId === threadId
        && message.params?.turn?.id === activeTurnId);
      const status = completed.params?.turn?.status;
      if (status !== 'completed') throw new Error(`Codex app-server turn ${turnId} ended as ${status || 'unknown'}`);
      return completed;
    };

    const textTurn = await runTurn('text', 'Reply with exactly CANARY_OK and nothing else.');
    if (!JSON.stringify(textTurn).includes('CANARY_OK')) {
      throw new Error(`Codex app-server text turn did not preserve the canary response: ${JSON.stringify(client.summary()).slice(0, 4000)}`);
    }
    const toolTurn = await runTurn(
      'tool',
      'For CANARY_CODEX_TOOL_CASE, execute the available shell tool once, then reply with exactly CANARY_CODEX_TOOL_OK.',
    );
    if (!JSON.stringify(toolTurn).includes('CANARY_CODEX_TOOL_OK')) {
      throw new Error(`Codex app-server tool turn did not complete with the canary response: ${JSON.stringify(client.summary()).slice(0, 4000)}`);
    }

    await client.request('thread/compact/start', { threadId });
    const compactionStarted = await client.waitFor(message => message?.method === 'item/started'
      && message.params?.threadId === threadId
      && message.params?.item?.type === 'contextCompaction');
    const compactionItemId = compactionStarted.params.item.id;
    await client.waitFor(message => message?.method === 'item/completed'
      && message.params?.threadId === threadId
      && message.params?.item?.type === 'contextCompaction'
      && message.params?.item?.id === compactionItemId);

    return { text: true, tool: true, compaction: true };
  } finally {
    await stopChild(child);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

module.exports = { createJsonLineClient, runCodexAppServerCanary };
