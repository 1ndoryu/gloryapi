'use strict';

// Regresión del pensamiento de CommandCode (2026-08-18): el bridge acumula el
// texto del mensaje y abre su item de respuesta SOLO después de finalizar el
// item de razonamiento. Antes, un proveedor que emite `content` antes de
// `reasoning_content` hacía que el bloque de pensamiento llegara después del
// mensaje abierto, y Desktop lo descartaba (pensamiento invisible).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bridgeFile = path.resolve(__dirname, '..', 'bridge', 'server.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`bridge exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

function sseEvents(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    const eventLine = block.split('\n').find(line => line.startsWith('event: '));
    const dataLine = block.split('\n').find(line => line.startsWith('data: '));
    if (eventLine && dataLine && dataLine.slice(6).trim() !== '[DONE]') {
      try {
        events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
      } catch {}
    }
  }
  return events;
}

const CHUNK = (delta, extra) => `data: ${JSON.stringify({
  id: 'fixture-reasoning-order',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-v4-flash',
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
})}\n\n`;

test('CommandCode-style content-before-reasoning keeps the reasoning item before the message', async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      // CommandCode (Anthropic-style) puede enviar contenido antes del bloque
      // de razonamiento. El bridge debe publicar ambos en orden Responses.
      response.end(
        CHUNK({ role: 'assistant', content: 'primera parte' }) +
        CHUNK({ reasoning_content: 'pensamiento interno de CommandCode' }) +
        CHUNK({ content: ' y parte final' }) +
        CHUNK({}, {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 },
        }) +
        'data: [DONE]\n\n'
      );
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const bridgePort = await reservePort();
  const requestLog = path.join(os.tmpdir(), `reasoning-order-${process.pid}-${Date.now()}.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      BRIDGE_REQUEST_LOG: requestLog,
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      VISION_DISABLE: '1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(requestLog, { force: true });
  });

  const base = `http://127.0.0.1:${bridgePort}`;
  await waitForHealth(`${base}/health`, child);

  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'explica y piensa' }] }],
    }),
  });
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());

  const reasoningAddedIndex = events.findIndex(
    entry => entry.event === 'response.output_item.added' && entry.data.item?.type === 'reasoning'
  );
  const messageAddedIndex = events.findIndex(
    entry => entry.event === 'response.output_item.added' && entry.data.item?.type === 'message'
  );
  assert.ok(reasoningAddedIndex >= 0, 'debe abrir un item de razonamiento');
  assert.ok(messageAddedIndex >= 0, 'debe abrir un item de mensaje');
  assert.ok(reasoningAddedIndex < messageAddedIndex, 'el razonamiento debe abrirse antes que el mensaje');

  const reasoningAdded = events[reasoningAddedIndex].data;
  const messageAdded = events[messageAddedIndex].data;
  assert.equal(reasoningAdded.output_index, 0);
  assert.equal(messageAdded.output_index, 1);

  assert.ok(
    events.some(entry => entry.event === 'response.reasoning_summary_text.delta'),
    'el pensamiento debe llegar como resumen streamed'
  );
  assert.ok(
    events.some(entry => entry.event === 'response.reasoning_summary_text.done' && entry.data.text.includes('pensamiento interno')),
    'el resumen debe cerrarse con el texto completo'
  );
  assert.ok(
    events.some(entry => entry.event === 'response.output_item.done' && entry.data.item?.type === 'reasoning' && entry.data.item.status === 'completed'),
    'el item de razonamiento debe cerrarse como completed'
  );

  const messageDone = events.find(
    entry => entry.event === 'response.output_item.done' && entry.data.item?.type === 'message'
  );
  assert.ok(messageDone, 'debe existir el item de mensaje final');
  assert.equal(messageDone.data.item.content[0].text, 'primera parte y parte final');
  assert.equal(messageDone.data.output_index, 1);

  const completed = events.find(entry => entry.event === 'response.completed');
  assert.ok(completed, 'debe existir response.completed');
  assert.equal(completed.data.response.end_turn, true);
});

test('reasoning-before-content keeps the same ordering and the message follows', async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.end(
        CHUNK({ reasoning: 'pensamiento primero' }) +
        CHUNK({ content: 'respuesta visible' }) +
        CHUNK({}, {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }) +
        'data: [DONE]\n\n'
      );
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const bridgePort = await reservePort();
  const requestLog = path.join(os.tmpdir(), `reasoning-order-${process.pid}-${Date.now()}-b.log`);
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      BRIDGE_REQUEST_LOG: requestLog,
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      VISION_DISABLE: '1',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(requestLog, { force: true });
  });

  const base = `http://127.0.0.1:${bridgePort}`;
  await waitForHealth(`${base}/health`, child);

  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'piensa y responde' }] }],
    }),
  });
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());

  const reasoningAddedIndex = events.findIndex(
    entry => entry.event === 'response.output_item.added' && entry.data.item?.type === 'reasoning'
  );
  const messageAddedIndex = events.findIndex(
    entry => entry.event === 'response.output_item.added' && entry.data.item?.type === 'message'
  );
  assert.ok(reasoningAddedIndex >= 0);
  assert.ok(messageAddedIndex >= 0);
  assert.ok(reasoningAddedIndex < messageAddedIndex);
  assert.equal(events[reasoningAddedIndex].data.output_index, 0);
  assert.equal(events[messageAddedIndex].data.output_index, 1);

  const messageDone = events.find(
    entry => entry.event === 'response.output_item.done' && entry.data.item?.type === 'message'
  );
  assert.equal(messageDone.data.item.content[0].text, 'respuesta visible');
});
