// Anti falso-complete (2026-08-10; hook de confirmación 2026-08-11).
//
// Protege al bridge del "falso complete": cuando DeepSeek cierra con texto sin
// invocar herramientas ("Voy a escanear los .md...", "Sigo la auditoría
// leyendo...", "I will check..."), Codex Desktop cierra el turno con
// task_complete sin ejecutar nada. El hook (capa B) es UNIVERSAL: toda respuesta
// final sin tool_calls con tools disponibles recibe UN request de confirmación;
// el modelo responde "ok" (cierra de verdad, sin re-activar el hook) o continúa
// con la acción (tool_calls reales).
//   1. Heurísticas `isFutureIntentNarration` e `isConfirmationText` (extraídas
//      del server.js real; la primera solo alimenta telemetría `intent`).
//   2. Hook streaming: texto final + tools => segundo request no-streaming; si
//      devuelve tool_calls, las emite como function_call (el turno continúa).
//   3. Confirmación: el retry responde "ok" => se cierra con el texto original,
//      sin function_call ni texto duplicado.
//   4. Nudge noop: el retry vuelve con otro texto => se descarta y se cierra con
//      el texto original (nunca duplica contenido ni inventa tools).
//   5. Control: sin tools el hook NO se dispara (las respuestas legítimas).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bridgeFile = path.resolve(__dirname, '..', 'bridge', 'server.js');

// ---------------------------------------------------------------------------
// Bloque estático: extrae las heurísticas del adaptador de contexto real
// ---------------------------------------------------------------------------
const src = fs.readFileSync(path.resolve(__dirname, '..', 'bridge', 'context-adapter.js'), 'utf8');

// Extrae una función del adaptador real (respeta strings/escapes y llaves).
function extractFunction(fnName) {
  const start = src.indexOf(`function ${fnName}`);
  if (start < 0) {
    console.error(`FAIL: ${fnName} no encontrada`);
    process.exit(1);
  }
  let i = start;
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return new Function('return ' + src.slice(start, i))();
}
const isFutureIntentNarration = extractFunction('isFutureIntentNarration');
const isConfirmationText = extractFunction('isConfirmationText');

test('isFutureIntentNarration: narrativas reales (positivos)', () => {
  const positives = [
    'Voy a escanear los .md y extraer las fechas del propio nombre para ordenarlos.',
    'Necesito ajustar el fork para poder usar el rol especializado. Lo reintento con el contexto completo en el mensaje.',
    'Necesito inspeccionar qué me devuelve la documentación; voy a examinar su estructura directamente.',
    'Voy a intentar abrir el navegador y leer la documentación.',
    'Primero voy a revisar los archivos del roadmap.',
    'Vamos a buscar la información en los planes.',
    'Procedo a listar los directorios del proyecto.',
    'Lo haré ahora con la herramienta disponible.',
    'Intentaré de nuevo con un contexto reducido.',
    'Voy a hacer el commit después de validar.',
    'Voy a leer el archivo AGENTS.md para ver la política.',
    'I will scan the .md files and extract the dates from their names.',
    "I'll check the roadmap first, one moment.",
    "I'm going to open the browser and read the documentation.",
    'Let me review the plans directory before continuing.',
    'I need to fix the fork configuration for the specialized role.',
    'I will retry with a reduced context.',
    'First I will read the AGENTS.md file.',
    'I should look at the roadmap before proceeding.',
    'I have to verify the health endpoint again.',
    'I want to run the tests to confirm.',
    "I'd like to create the missing file now.",
    'Let me start by listing the projects.',
    'I am going to try running the suite once more.',
  ];
  for (const text of positives) {
    assert.equal(
      isFutureIntentNarration(text),
      true,
      `debe detectar: ${text.slice(0, 60)}`,
    );
  }
});

test('isFutureIntentNarration: respuestas normales (negativos)', () => {
  const negatives = [
    'El usuario pidió listar los .md; aquí está la lista ordenada por fecha.',
    'No se encontraron archivos con ese patrón.',
    'La operación ya está completa, no requiere herramientas.',
    'Respuesta corta: ok',
    '',
    null,
    undefined,
    '¿Qué debería hacer a continuación?',
    'El timeout fue de 180 segundos y el flujo se desconectó.',
    'Here is the sorted list of .md files by date.',
    'Done. The operation completed successfully.',
    'The file was already modified, no changes needed.',
    'I checked the logs and found nothing useful.',
    'The status is healthy and the bridge responds correctly.',
    'Let me know if you need anything else.',
    'Please let me know when it is ready.',
    'All done, everything is in order.',
  ];
  for (const text of negatives) {
    assert.equal(
      isFutureIntentNarration(text),
      false,
      `no debe detectar: ${String(text).slice(0, 60)}`,
    );
  }
});

test('isConfirmationText: confirmaciones de cierre (positivos)', () => {
  const positives = [
    'ok',
    'Ok.',
    'OK',
    'ok, listo',
    'done',
    'Done!',
    'yes',
    'sí',
    'si',
    'listo',
    'hecho',
    'terminado',
    'completado',
    'finished',
    'all done',
    'eso es todo',
    'ya está',
    'nada más',
    'perfecto',
    'vale',
    'de acuerdo',
    'entendido',
    'confirmado',
    "that's all",
  ];
  for (const text of positives) {
    assert.equal(isConfirmationText(text), true, `debe confirmar: ${String(text).slice(0, 40)}`);
  }
});

test('isConfirmationText: no confirmaciones (negativos)', () => {
  const negatives = [
    'Sigo la auditoría leyendo el contenido del template en main.',
    'Voy a escanear los .md y extraer las fechas.',
    'Ya está hecho, no requiere herramienta.',
    'Aquí está la lista ordenada por fecha: A, B, C.',
    'El timeout fue de 180 segundos.',
    'ok, pero falta revisar el archivo X',
    'perfecto, ahora continúo con la siguiente tarea',
    '',
    null,
    undefined,
    'Let me check the roadmap first.',
  ];
  for (const text of negatives) {
    assert.equal(isConfirmationText(text), false, `no debe confirmar: ${String(text).slice(0, 40)}`);
  }
});

// ---------------------------------------------------------------------------
// Helpers E2E (mismo patrón que browser-stall-regression)
// ---------------------------------------------------------------------------
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
  const requestLog = path.join(os.tmpdir(), `anti-falso-${process.pid}-${Date.now()}.log`);
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
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${bridgePort}`;
  await waitForHealth(`${base}/health`, child);

  return {
    base,
    child,
    upstreamBodies,
    get bridgeLog() {
      return fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8') : '';
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

const NARRATIVE_SSE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Voy a escanear los .md y extraer las fechas del nombre."}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":10,"completion_tokens":14,"total_tokens":24}}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const NORMAL_SSE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Aquí está la lista ordenada por fecha: A, B, C."}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":10,"completion_tokens":12,"total_tokens":22}}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const TOOL_ONLY_SSE = [
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"El asistente analizó la petición y decidió invocar una herramienta para completar la tarea."}}]}',
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":" Acción verificada antes de llamar."}}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_tool_only_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.md\\"}"}}]}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":10,"completion_tokens":14,"total_tokens":24}}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const REASONING_ONLY_SSE = [
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"razonamiento interno sin respuesta final"}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"choices":[{"index":0,"delta":{},"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

// ---------------------------------------------------------------------------
// E2E: nudge retry (streaming) — texto narrativo + tools => el retry devuelve
// tool_calls y el bridge las emite como function_call (el turno continúa).
// ---------------------------------------------------------------------------
test('nudge: narrativa sin tools + retry con tool_calls => function_call emitido', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) {
      return { sse: NARRATIVE_SSE };
    }
    // Segundo request (nudge) no-streaming: el mock pide la herramienta.
    return {
      json: {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_nudge_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.md"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md por fecha' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());

  const calls = events.filter((entry) => entry.event === 'response.output_item.done' && entry.data.item && entry.data.item.type === 'function_call');
  assert.ok(calls.length >= 1, 'el bridge debe emitir el function_call del retry');
  assert.equal(calls[0].data.item.name, 'read_file');
  assert.equal(calls[0].data.item.arguments, '{"path":"a.md"}');

  // Hubo exactamente 2 requests: el streaming original + el nudge no-streaming.
  assert.equal(bridge.upstreamBodies.length, 2, 'debe haber 2 requests upstream (original + nudge)');
  assert.equal(bridge.upstreamBodies[1].stream, false, 'el nudge debe ir no-streaming');
  const lastMessage = bridge.upstreamBodies[1].messages[bridge.upstreamBodies[1].messages.length - 1];
  assert.match(lastMessage.content, /Confirmación de cierre/, 'el nudge debe llevar la directiva de confirmación');
  // El texto narrativo se reenvía como assistant antes de la directiva.
  const assistantIndex = bridge.upstreamBodies[1].messages.findIndex((m) => m.role === 'assistant');
  assert.ok(assistantIndex >= 0, 'el nudge debe incluir el anuncio como assistant');
});

// ---------------------------------------------------------------------------
// E2E: nudge noop — el retry vuelve sin tools => se cierra con el texto original,
// sin duplicar contenido ni inventar tool_calls.
// ---------------------------------------------------------------------------
test('nudge noop: retry sin tools => respuesta original, sin function_call', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) {
      return { sse: NARRATIVE_SSE };
    }
    return {
      json: {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Ya está hecho, no requiere herramienta.', finish_reason: 'stop' },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md por fecha' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());

  assert.ok(
    !events.some((entry) => entry.event === 'response.output_item.done' && entry.data.item && entry.data.item.type === 'function_call'),
    'no debe inventar function_call si el retry no devuelve tools'
  );
  const completed = events.find((entry) => entry.event === 'response.completed');
  assert.ok(completed, 'debe cerrar con response.completed');
  assert.equal(bridge.upstreamBodies.length, 2, 'intentó el nudge (2 requests)');
});

test('nudge con upstream colgado => cierra dentro de su presupuesto y conserva el texto', async (t) => {
  const startedAt = Date.now();
  const bridge = await startBridge(
    (body) => body.stream === true ? { sse: NARRATIVE_SSE } : { hangingBody: true },
    { BRIDGE_NUDGE_TIMEOUT_MS: '1000' }
  );
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md por fecha' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.ok(raw.includes('Voy a escanear los .md'), 'conserva el texto original');
  assert.ok(raw.includes('response.completed'), 'el timeout del nudge no deja el turno abierto');
  assert.ok(Date.now() - startedAt < 2500, 'el nudge no debe heredar el timeout largo del proveedor');
  let bridgeLog = bridge.bridgeLog;
  for (let attempt = 0; attempt < 10 && !/"kind":"nudge_error"/.test(bridgeLog); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridgeLog = bridge.bridgeLog;
  }
  assert.match(bridgeLog, /"kind":"nudge_error"/);
});

// ---------------------------------------------------------------------------
// E2E: confirmación — el retry responde "ok" => el cierre es real: se conserva
// el texto original, no se inventan function_call ni se re-activa el hook.
// ---------------------------------------------------------------------------
test('confirm: retry responde "ok" => cierra con el texto original, sin function_call', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) {
      return { sse: NORMAL_SSE };
    }
    return {
      json: {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md por fecha' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());

  assert.ok(
    !events.some((entry) => entry.event === 'response.output_item.done' && entry.data.item && entry.data.item.type === 'function_call'),
    'si el modelo confirma el cierre no debe inventar function_call'
  );
  assert.ok(events.some((entry) => entry.event === 'response.completed'), 'debe cerrar con response.completed');
  const textItems = events
    .filter((entry) => entry.event === 'response.output_item.done' && entry.data.item && entry.data.item.type === 'message')
    .map((entry) => JSON.stringify(entry.data.item.content || ''));
  assert.ok(
    textItems.some((content) => content.includes('Aquí está la lista ordenada por fecha')),
    'el texto visible debe ser el original, no el "ok" del retry'
  );
  assert.ok(!textItems.some((content) => /"ok"/i.test(content)), 'el "ok" de confirmación no debe aparecer como texto');
  assert.equal(bridge.upstreamBodies.length, 2, 'hace el request de confirmación (2 requests)');
});

// ---------------------------------------------------------------------------
// E2E: control — sin tools el nudge NO se dispara (respuestas legítimas intactas)
// ---------------------------------------------------------------------------
test('control: sin tools disponibles el nudge no se dispara', async (t) => {
  const bridge = await startBridge(() => ({ sse: NORMAL_SSE }));
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md por fecha' }] }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());
  assert.ok(events.some((entry) => entry.event === 'response.completed'), 'responde con completed');
  assert.equal(bridge.upstreamBodies.length, 1, 'sin tools no hay segundo request (nudge)');
});

// ---------------------------------------------------------------------------
// E2E: regresión 2026-08-11 — hilo LARGO con tools de turnos ANTERIORES. El
// guard original (`messages.some(m => m.role === 'tool')`) miraba todo el
// historial y desactivaba el nudge en cuanto existía cualquier tool previa; el
// modelo podía cerrar con "Sigo ahora con eso" sin ejecutar y el turno terminaba
// (falso complete real: hilo de 146 mensajes con 71 tool, "listo?" 07:24Z).
// El turno ACTUAL no tiene tool messages => el nudge SÍ debe dispararse.
// ---------------------------------------------------------------------------
test('regresión: historial con tools previas + turno actual sin tools => nudge SÍ', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) {
      return { sse: NARRATIVE_SSE };
    }
    // Nudge no-streaming: el retry confirma el cierre ("ok").
    return {
      json: {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [
        // Turnos anteriores: herramientas ya ejecutadas (rol 'tool' en el historial).
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md' }] },
        { type: 'function_call', call_id: 'call_prev_1', name: 'read_file', arguments: '{"path":"a.md"}' },
        { type: 'function_call_output', call_id: 'call_prev_1', output: '{"ok":true}' },
        // Turno actual: nuevo input del usuario, sin tools ejecutadas aún.
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'listo?' }] },
      ],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());

  assert.ok(events.some((entry) => entry.event === 'response.completed'), 'responde con completed');
  assert.ok(
    !events.some((entry) => entry.event === 'response.output_item.done' && entry.data.item && entry.data.item.type === 'function_call'),
    'si el retry confirma con "ok", no debe inventar function_call'
  );
  // El nudge SÍ se disparó a pesar de las tools de turnos anteriores.
  assert.equal(bridge.upstreamBodies.length, 2, 'con tools previas pero turno actual sin tools, el nudge debe dispararse (2 requests)');
  assert.equal(bridge.upstreamBodies[1].stream, false, 'el nudge debe ir no-streaming');
});

// ---------------------------------------------------------------------------
// E2E: el nudge universal también confirma un resumen normal después de tools.
// La confirmación "ok" cierra sin duplicar ni inventar una llamada.
// ---------------------------------------------------------------------------
test('control: resumen normal después de tools => nudge confirma sin cambiarlo', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) return { sse: NORMAL_SSE };
    return {
      json: {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ordena los .md' }] },
        { type: 'function_call', call_id: 'call_cur_1', name: 'read_file', arguments: '{"path":"a.md"}' },
        { type: 'function_call_output', call_id: 'call_cur_1', output: '{"ok":true}' },
      ],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());
  assert.ok(events.some((entry) => entry.event === 'response.completed'), 'responde con completed');
  assert.equal(bridge.upstreamBodies.length, 2, 'el cierre universal confirma incluso después de tools (2 requests)');
  assert.ok(
    !events.some((entry) => entry.event === 'response.output_item.done' && entry.data.item?.type === 'function_call'),
    'la confirmación ok no debe inventar function_call'
  );
});

test('regresión: tools del turno actual + intención futura => nudge SÍ', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) return { sse: NARRATIVE_SSE };
    return {
      json: {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'revisa la documentación' }] },
        { type: 'function_call', call_id: 'call_cur_1', name: 'read_file', arguments: '{"path":"a.md"}' },
        { type: 'function_call_output', call_id: 'call_cur_1', output: '{"ok":true}' },
      ],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text());
  assert.ok(events.some((entry) => entry.event === 'response.completed'), 'responde con completed');
  assert.equal(bridge.upstreamBodies.length, 2, 'la intención futura después de una tool activa el nudge');
  assert.equal(bridge.upstreamBodies[1].stream, false, 'el nudge debe ir no-streaming');
});

test('tool-only: el function_call continúa el turno y el fallback no se muestra', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) return { sse: TOOL_ONLY_SSE };
    return { status: 500, json: { error: 'unexpected recovery request' } };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lee a.md' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  const raw = await response.text();
  const events = sseEvents(raw);
  assert.equal(response.status, 200);
  assert.match(raw, /call_tool_only_1/);
  assert.doesNotMatch(raw, /El asistente analizó la petición/);
  assert.ok(events.some((entry) => entry.event === 'response.reasoning_summary_text.delta'), 'el razonamiento visible debe llegar como resumen');
  assert.doesNotMatch(raw, /response\.reasoning_text\.delta/, 'no debe emitir el evento antiguo que la app ignora');
  assert.ok(
    events.some((entry) => entry.event === 'response.output_item.done' && entry.data.item?.type === 'function_call'),
    'el tool-only debe salir como function_call'
  );
  const completed = events.find((entry) => entry.event === 'response.completed');
  assert.ok(completed, 'la respuesta termina después de emitir el call');
  assert.equal(completed.data.response.end_turn, false, 'un tool-call no es un cierre de turno');
  assert.equal(bridge.upstreamBodies.length, 1, 'un tool-only no activa nudge ni un segundo loop');
});

test('reasoning-only: se recupera con un request acotado y no se cierra vacío', async (t) => {
  let requestCount = 0;
  const bridge = await startBridge(() => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        json: {
          choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: 'razonamiento interno' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      };
    }
    return {
      json: {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_recovered_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lee a.md' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.output[0].type, 'function_call');
  assert.equal(body.end_turn, false);
  assert.equal(bridge.upstreamBodies.length, 2, 'el reasoning-only debe activar una sola recuperación');
  assert.match(JSON.stringify(bridge.upstreamBodies[1].messages), /Recuperación obligatoria/);
});

test('reasoning-only streaming: recovery emite un solo function_call y no cierra antes', async (t) => {
  const bridge = await startBridge((body) => {
    if (body.stream === true) return { sse: REASONING_ONLY_SSE };
    return {
      json: {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_stream_recovered_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
    };
  });
  t.after(bridge.cleanup);

  const response = await fetch(
    `${bridge.base}/v1/responses`,
    responsesRequest({
      model: 'deepseek-v4-flash',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lee a.md' }] }],
      tools: [{ type: 'function', name: 'read_file', description: 'Lee un archivo' }],
    })
  );
  const raw = await response.text();
  const events = sseEvents(raw);
  assert.equal(response.status, 200);
  assert.doesNotMatch(raw, /El asistente analizó la petición/);
  assert.equal(bridge.upstreamBodies.length, 2, 'streaming reasoning-only debe recuperar una vez');
  assert.equal(
    events.filter((entry) => entry.event === 'response.completed').length,
    1,
    'debe existir un solo cierre terminal'
  );
  assert.ok(events.some((entry) => entry.event === 'response.output_item.done' && entry.data.item?.type === 'function_call'));
  assert.equal(events.find((entry) => entry.event === 'response.completed').data.response.end_turn, false);
});
