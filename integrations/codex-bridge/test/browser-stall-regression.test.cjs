// Regresión del stall del navegador (Fase 5, 2026-08-10).
//
// Tres comportamientos protegidos:
//  1. Respuesta vacía del upstream (sin texto, sin razonamiento, sin tool
//     calls) => el bridge emite response.failed `empty_upstream_response`
//     (nunca un response.completed "fantasma" que cuelga a la app).
//  2. System prompt gigante (plugins del navegador de Codex Desktop) => se
//     recorta a BRIDGE_MAX_SYSTEM_CHARS conservando cabeza y cola, para que
//     DeepSeek no se sature y deje de responder.
//  3. Red de seguridad de compactación: si la nativa de la app no compacta y
//     el contexto real supera COMPACTION_SAFETY_FACTOR x CONTEXT_LIMIT, el
//     bridge compacta el historial por su cuenta (evidencia real: sesiones del
//     navegador con 1.7M tokens sin compactar y salida vacía).
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
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`bridge exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge health timeout');
}

// Levanta un upstream mock + un bridge aislado. `handler(body)` recibe el body
// traducido y debe responder { status, json } para peticiones no-streaming o
// { status, sse } para streaming; si no devuelve nada se usa un fallback.
async function startBridge(handler, extraEnv = {}) {
  const upstreamBodies = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      upstreamBodies.push(body);
      const outcome = handler(body);
      if (!outcome) {
        response.writeHead(500).end('no mock handler');
        return;
      }
      if (outcome.hangingBody) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"choices":[');
        return;
      }
      if (outcome.sse) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(outcome.sse);
        return;
      }
      response.writeHead(outcome.status || 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(outcome.json));
    });
  });
  const upstreamPort = await listen(upstream);

  const bridgePort = await reservePort();
  const requestLog = path.join(os.tmpdir(), `gloryapi-bridge-test-${process.pid}-${Date.now()}.log`);
  const stderrChunks = [];
  const child = spawn(process.execPath, [bridgeFile], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_UPSTREAM_TIMEOUT_MS: '3000',
      BRIDGE_CLIENT_TOKEN: 'test',
      GLORY_API_KEY: 'upstream-test',
      BRIDGE_REQUEST_LOG: requestLog,
      GLORY_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      VISION_DISABLE: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stderrChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const base = `http://127.0.0.1:${bridgePort}`;
  await waitForHealth(`${base}/health`, child);

  return {
    base,
    child,
    upstreamBodies,
    get bridgeLog() {
      return Buffer.concat(stderrChunks).toString('utf8');
    },
    cleanup: async () => {
      if (child.exitCode == null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(requestLog, { force: true });
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

function responsesRequest(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  };
}

function sseEvents(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (eventLine && dataLine && dataLine.slice(6).trim() !== '[DONE]') {
      try {
        events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
      } catch {}
    }
  }
  return events;
}

test('respuesta vacía del upstream => response.failed, no completed fantasma', async (t) => {
  // El chat normal va stream:true => el bridge espera SSE del upstream, no JSON.
  // Delta con content vacío y finish stop => el acumulador no produce texto.
  const bridge = await startBridge(() => ({
    sse: [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":5,"completion_tokens":0,"total_tokens":5}}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n',
  }));
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'responde' }] }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());
  const failed = events.find((entry) => entry.event === 'response.failed');
  assert.ok(failed, 'debe emitir response.failed ante una respuesta vacía');
  assert.equal(failed.data.response.error.type, 'empty_upstream_response');
  assert.ok(!events.some((entry) => entry.event === 'response.completed'), 'no debe emitir completed vacío');
});

test('web loop con respuesta vacía => response.failed (caso navegador)', async (t) => {
  // Primera llamada del bucle interno: el modelo no llama web_search y no
  // escribe texto => vacío. El bridge debe fallar de forma visible.
  const bridge = await startBridge(() => ({
    json: {
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    },
  }));
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'usa el navegador' }] }],
      tools: [{ type: 'web_search', name: 'web_search' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());
  const failed = events.find((entry) => entry.event === 'response.failed');
  assert.ok(failed, 'web loop vacío debe fallar de forma visible');
  assert.equal(failed.data.response.error.type, 'empty_upstream_response');
  assert.ok(!events.some((entry) => entry.event === 'response.completed'));
});

test('system prompt gigante se recorta conservando cabeza y cola', async (t) => {
  const head = 'INSTRUCCIONES CRITICAS: no borres nada.\n';
  const tail = '\nFINAL: informa siempre el resultado.';
  const giant = `${head}${'x'.repeat(120000)}${tail}`;
  let seenSystem = null;
  const bridge = await startBridge(
    (body) => {
      const system = body.messages.find((message) => message.role === 'system');
      seenSystem = system && system.content;
      return {
        sse: [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}]}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n',
      };
    },
    { BRIDGE_MAX_SYSTEM_CHARS: '20000' }
  );
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola' }] }],
      instructions: giant,
    })
  );
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.ok(
    bridge.upstreamBodies.length >= 1,
    `el upstream debe recibir al menos un request (recibió ${bridge.upstreamBodies.length})\n--- respuesta bridge ---\n${responseText.slice(0, 800)}\n--- bridge log ---\n${bridge.bridgeLog}`
  );
  assert.ok(seenSystem, 'el upstream debe recibir un system message');
  assert.ok(seenSystem.length <= 20000 + 512, `system recortado (${seenSystem.length})`);
  assert.ok(seenSystem.startsWith(head), 'conserva la cabeza de instrucciones');
  assert.ok(seenSystem.endsWith(tail), 'conserva la cola');
  assert.match(seenSystem, /recortado por el bridge/, 'anuncia el recorte');
});

test('red de seguridad compacta cuando la nativa no dispara', async (t) => {
  const giantMarker = 'GIGANTE-MARCADOR-';
  const giantUser = giantMarker.repeat(20000); // 300k chars => heur ~75k, real ~11k con ratio 0.15
  let summaryCalls = 0;
  let finalBody = null;

  const bridge = await startBridge(
    (body) => {
      const firstSystem = body.messages.find((message) => message.role === 'system');
      const isSummary = body.stream === false && firstSystem && /motor de resumen/i.test(String(firstSystem.content || ''));
      if (isSummary) {
        summaryCalls += 1;
        return {
          json: {
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content:
                    'RESUMEN DE LA CONVERSACIÓN: el usuario pidió operar el navegador. Se intentó conectar y leer la documentación. ' +
                    'PRÓXIMO: reintentar con contexto reducido. PENDIENTE: validar el flujo completo. '.repeat(8),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
          },
        };
      }
      if (body.stream === true) {
        finalBody = body;
        return {
          sse: [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"compactado"}}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":50,"completion_tokens":3,"total_tokens":53}}]}',
            'data: [DONE]',
          ].join('\n\n') + '\n\n',
        };
      }
      return null;
    },
    { CONTEXT_LIMIT_TOKENS: '2000', BRIDGE_COMPACTION_SAFETY_FACTOR: '2' }
  );
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: giantUser }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'intermedio' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sigue ahora' }] },
      ],
    })
  );
  assert.equal(response.status, 200);
  const bodyText = await response.text();
  assert.match(bodyText, /compactado/);
  assert.ok(summaryCalls >= 1, 'la red de seguridad debe pedir un resumen al modelo');
  assert.ok(finalBody, 'debe llegar un request final al upstream');
  const finalText = JSON.stringify(finalBody.messages);
  assert.ok(!finalText.includes(giantMarker), 'el historial gigante se resumió');
  assert.match(finalText, /Resumen de la conversación anterior/, 'el resumen reemplaza al historial viejo');
});

test('compactación no queda colgada si el resumen entrega headers y deja el body abierto', async (t) => {
  let summaryCalls = 0;
  let summaryResponse = null;
  const bridge = await startBridge(
    (body) => {
      const firstSystem = body.messages.find((message) => message.role === 'system');
      const isSummary = body.stream === false && firstSystem && /motor de resumen/i.test(String(firstSystem.content || ''));
      if (isSummary) {
        summaryCalls += 1;
        return { hangingBody: true };
      }
      summaryResponse = body;
      return {
        sse: [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"continuó tras fallback"}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}]}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n',
      };
    },
    {
      BRIDGE_COMPACTION_DISABLED: '0',
      CALIB_RATIO: '1',
      CONTEXT_LIMIT_TOKENS: '1000',
      COMPACT_KEEP_TOKENS: '100',
      BRIDGE_UPSTREAM_TIMEOUT_MS: '300',
    },
  );
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'historial '.repeat(800) }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'último turno' }] },
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /continuó tras fallback/);
  assert.equal(summaryCalls, 1);
  assert.ok(summaryResponse, 'debe llegar al upstream el request final tras el fallback');
});
