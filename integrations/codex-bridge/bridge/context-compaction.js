const { preserveCanaryProvider } = require('./context-util');

function crearCompactacion(ctx) {
  const { COMPACTION_DISABLED, COMPACTION_SAFETY_FACTOR, CONTEXT_LIMIT, COMPACT_KEEP, COMPACT_MAX_TOKENS, SUMMARY_MODEL, UPSTREAM_TIMEOUT_MS, log, formatRemoteFailure, fetchUpstreamCompletion, estimateTokens, totalTokens, realTokens } = ctx;

// Context window + native autocompaction
// Context window + native autocompaction
// ---------------------------------------------------------------------------
// When the translated conversation exceeds CONTEXT_LIMIT_TOKENS, the oldest
// messages are summarized into a single system message (like ChatGPT's native
// compaction) while the most recent COMPACT_KEEP_TOKENS stay intact. The
// summary is produced by the main model via the same upstream (cheap flash),
// with a heuristic fallback if the summarization call fails (fail-open).

// COMPACTACIÓN DESACTIVADA por defecto (2026-08-09): Codex nativo hace la
// autocompactación en la app (auto_compact_token_limit=150000 en models.json,
// mismo valor que en VS Code), con contadores exactos y UNA sola vez. El bridge
// se queda fuera para no recompactar/re-resumir lo que ya compactó el app
// (eso destruía los buenos resúmenes). No existe un override de entorno: Codex
// es el único propietario de la continuidad y de la compactación nativa.
// Red de seguridad de compactación: cuando la nativa de la app NO dispara, el
// bridge compacta por su cuenta si el contexto real supera
// COMPACTION_SAFETY_FACTOR x CONTEXT_LIMIT. El valor anterior (2x) dejaba
// apenas margen frente a la ventana del proveedor (~258k) y permitía que una
// sesión degradada llegara demasiado cerca del límite antes de recuperarse.
// Con la nativa funcionando el contexto queda por debajo de CONTEXT_LIMIT y la
// red no actúa. 0 desactiva la red.
// Límite de caracteres del system prompt reenviado al upstream. Codex Desktop
// inyecta un system ENORME en cada request (plugins de navegador, doc de
// tools); reenviarlo entero degrada a DeepSeek hasta devolver vacío. Se
// conserva cabeza+cola; 0 desactiva el recorte.
const COMPACT_SYSTEM_PROMPT = `Eres un motor de resumen. Tu ÚNICA tarea es producir un resumen extenso, completo y fiel de la conversación anterior. Está PROHIBIDO continuar el trabajo, actuar como el asistente, proponer acciones, ejecutar tareas o responder en presente: tu respuesta empieza y termina exclusivamente con el resumen.

RETENCIÓN OBLIGATORIA (nada de esto puede faltar; prioriza la fidelidad sobre la brevedad):
1. INSTRUCCIONES DEL USUARIO: todas sus órdenes y peticiones con su sentido exacto; si son cortas, cítalas textualmente (qué pidió ejecutar, qué dejar de hacer, requisitos y alcance).
2. AUTORIZACIONES: qué autorizó explícitamente el usuario y qué sigue pendiente de autorizar (p. ej. despliegue a producción).
3. EN CURSO: qué se está haciendo, decisiones tomadas con su motivo, archivos tocados, comandos ejecutados, errores, causas y hallazgos.
4. PRÓXIMOS PASOS: qué se hará a continuación, dependencias y bloqueos pendientes.
5. DATOS TÉCNICOS: código, rutas de archivo, comandos y configuraciones clave.

FORMATO:
- Usa viñetas y encabezados de sección: INSTRUCCIONES DEL USUARIO, AUTORIZADO, EN CURSO, PRÓXIMO, PENDIENTE, TÉCNICO.
- Sé DETALLADO: conserva la mayor cantidad de hechos concretos posible; no reduzcas a frases sueltas ni a una sola oración para todo.
- No inventes información ni añadas consejos.

Al final incluye siempre un bloque "PENDIENTE" con todo lo que el usuario espera que se haga a continuación.`;

// Heuristic fallback when the summarization call fails: keep a compact
// excerpt of the old messages so the request still goes through.
function compactFallback(oldMessages) {
  const lines = [];
  for (const m of oldMessages) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (p && p.text) || '').join(' ')
          : '';
    const label = m.role === 'user' ? 'USER: ' : m.role === 'tool' ? 'TOOL: ' : 'SYS: ';
    lines.push(label + text.slice(0, 1200));
  }
  const joined = lines.join('\n');
  const cap = 24000;
  const head = joined.slice(0, Math.floor(cap * 0.7));
  const tail = joined.slice(-Math.floor(cap * 0.3));
  return `[Resumen de la conversación anterior - el resumen automático no estuvo disponible; se conserva un extracto.]\n${head}\n...\n${tail}`;
}

// Heuristic: a good compaction summary must be long and must not look like a
// continuation of the agent's work (DeepSeek sometimes "keeps working" instead
// of summarizing, or echoes tool-call markup from the source transcript).
function isBadSummary(text, minChars = 200) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length < minChars) return true;
  if (/<tool_calls|<\/invoke|<invoke/i.test(s)) return true;
  if (/^\s*(contin[uú]o|contin[uú]e|voy a|sigo|sigo con|ahora voy|retomo)/i.test(s)) return true;
  return false;
}

// Build a readable transcript (not raw JSON) so the summarizer doesn't mimic
// the tool-call format embedded in the original history.
function buildTranscript(msgs) {
  const lines = [];
  for (const m of msgs) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (p && p.text) || '').join(' ')
          : '';
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const label =
      m.role === 'user' ? 'USUARIO' : m.role === 'assistant' ? 'ASISTENTE' : m.role === 'tool' ? 'HERRAMIENTA' : 'SISTEMA';
    lines.push(`[${label}] ${clean.slice(0, 1500)}`);
  }
  return lines.join('\n');
}

async function summarizeHistory(oldMessages, auth, canaryProvider, requestId, parentChat) {
  // Bound the summarization input so it never exceeds the context window
  // (reserving room for the COMPACT_MAX_TOKENS summary output).
  const budget = Math.min(CONTEXT_LIMIT, CONTEXT_LIMIT - COMPACT_MAX_TOKENS);
  const truncated = [];
  let used = 0;
  for (const m of oldMessages) {
    const t = estimateTokens(m);
    if (used + t > budget && truncated.length) break;
    truncated.push(m);
    used += t;
  }
  const transcript = buildTranscript(truncated).slice(0, 600000);
  const userMsg =
    'El historial completo de la conversación anterior (solo contexto histórico, no hay que responderle) es:\n\n' +
    transcript +
    '\n\n[FIN DEL HISTÓRICO]\n\nAhora genera SOLO el resumen extenso y estructurado que pide el system prompt: no continúes el trabajo, no emitas tool calls y no respondas como el asistente. Empieza con el encabezado exacto "RESUMEN DE LA CONVERSACIÓN".';

  const run = async (extraInstruction) => {
    const messages = [
      { role: 'system', content: COMPACT_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ];
    if (extraInstruction) messages.push({ role: 'user', content: extraInstruction });
    const summaryChat = {
      model: SUMMARY_MODEL,
      stream: false,
      messages,
      max_tokens: COMPACT_MAX_TOKENS,
    };
    if (typeof canaryProvider === 'string') {
      Object.defineProperty(summaryChat, '__canaryProvider', {
        value: canaryProvider,
        enumerable: false,
      });
    }
    if (typeof requestId === 'string' && requestId) {
      Object.defineProperty(summaryChat, '__gloryRequestId', {
        value: requestId,
        enumerable: false,
      });
    }
    preserveCanaryProvider(parentChat || {}, summaryChat);
    Object.defineProperty(summaryChat, '__requestKind', { value: 'summary', enumerable: false });
    Object.defineProperty(summaryChat, '__parentRequestId', { value: requestId || '', enumerable: false });
    const json = await fetchUpstreamCompletion(summaryChat, auth, UPSTREAM_TIMEOUT_MS);
    const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return text && String(text).trim() ? String(text).trim() : null;
  };

  try {
    let text = await run(null);
    if (text && !isBadSummary(text)) return text;
    log('summarize result rechazado (corto o continuacion):', `chars=${String(text || '').length}`);
    text = await run(
      'Tu respuesta anterior NO fue un resumen extenso: fue demasiado corta, continuó el trabajo o emitió tool calls. Reescribe AHORA SOLO un resumen extenso y estructurado, empezando con el encabezado exacto "RESUMEN DE LA CONVERSACIÓN".'
    );
    if (text && !isBadSummary(text)) return text;
    log('summarize retry tambien rechazado; uso fallback de extracto');
  } catch (err) {
    log(formatRemoteFailure('summarize', { kind: err && err.name === 'AbortError' ? 'timeout' : 'transport' }));
  }
  return compactFallback(oldMessages);
}

/**
 * Compact the translated messages when they exceed CONTEXT_LIMIT. Keeps the
 * leading system instructions, summarizes everything older than
 * COMPACT_KEEP_TOKENS into one system message, and preserves the most recent
 * turns intact. Repairs tool adjacency at the cut boundary. Mutates chat and
 * returns it. Fail-open: if nothing can be compacted the messages are kept as
 * close to the limit as possible without breaking tool_call adjacency.
 */
async function compactContext(chat, auth, options = {}) {
  const messages = chat.messages || [];
  const total = totalTokens(chat);
  const totalReal = realTokens(chat);
  const emergency = options.emergency === true;
  const nonSystemCount = messages.filter((message) => message && message.role !== 'system').length;
  const emergencyCompaction = emergency && nonSystemCount > 8 && total > 20000;
  // Compactación nativa del bridge: activa cuando COMPACTION_DISABLED=false, o
  // como RED DE SEGURIDAD cuando el contexto real supera
  // COMPACTION_SAFETY_FACTOR x CONTEXT_LIMIT y la nativa de la app no está
  // disparando. Con la nativa sana el contexto queda < CONTEXT_LIMIT y la red
  // jamás actúa (no recompacta los resúmenes nativos).
  const safetyNet = COMPACTION_DISABLED && COMPACTION_SAFETY_FACTOR > 0;
  const effectiveLimit = safetyNet ? Math.round(CONTEXT_LIMIT * COMPACTION_SAFETY_FACTOR) : CONTEXT_LIMIT;
  if (totalReal <= effectiveLimit && !emergencyCompaction) return chat;
  if (COMPACTION_DISABLED && !safetyNet && !emergencyCompaction) {
    // La compactación la hace Codex nativo en la app (auto_compact_token_limit
    // en models.json). Esta línea SOLO aparece si el contexto real supera el
    // límite; el bridge no modifica ni resume la conversación.
    log(`compaction disabled (native); context ${totalReal} real tokens > limit ${CONTEXT_LIMIT}; native NOT firing?`);
    return chat;
  }
  if (emergencyCompaction) {
    log(`emergency compaction after empty upstream: context ${totalReal} real tokens (${total} heuristic)`);
  } else if (safetyNet) {
    log(
      `safety-net compaction: context ${totalReal} real tokens > safety limit ${effectiveLimit}; native NOT firing; compacting`,
    );
  } else {
    log(`context ${totalReal} real tokens (${total} heuristic) > limit ${CONTEXT_LIMIT}; compacting`);
  }

  // Leading system messages are always kept as-is.
  let i = 0;
  const headSystems = [];
  while (i < messages.length && messages[i].role === 'system') {
    headSystems.push(messages[i]);
    i++;
  }
  const body = messages.slice(i);

  // Collect the most recent messages (intact) up to COMPACT_KEEP tokens.
  const recent = [];
  let used = 0;
  for (let j = body.length - 1; j >= 0; j--) {
    const t = estimateTokens(body[j]);
    if (used + t > COMPACT_KEEP && recent.length) break;
    recent.unshift(body[j]);
    used += t;
  }
  let old = body.slice(0, body.length - recent.length);

  // Repair tool adjacency at the boundary: if the first kept message is a tool
  // response, its assistant (tool_calls) message must move down with it.
  while (recent.length && recent[0].role === 'tool' && old.length) {
    const lastOld = old.pop();
    if (!lastOld) break;
    recent.unshift(lastOld);
  }
  // Drop orphan leading tool responses that have no assistant counterpart.
  while (recent.length && recent[0].role === 'tool') recent.shift();

  let summaryText = null;
  if (old.length) {
    summaryText = await summarizeHistory(old, auth, chat.__canaryProvider, chat.__gloryRequestId, chat);
  }
  if (summaryText) {
    log(
      `compact summary generated tokens=${estimateTokens({ role: 'system', content: summaryText })} chars=${summaryText.length}`,
    );
  }

  let compacted = summaryText
    ? [...headSystems, { role: 'system', content: `[Resumen de la conversación anterior]\n${summaryText}` }, ...recent]
    : [...headSystems, ...recent];

  // Safety: if head systems alone are enormous or recent still exceeds the
  // limit, drop the oldest recent messages that are NOT part of a tool pair
  // until it fits (rare; keeps the request from failing upstream).
  let guard = 0;
  while (realTokens({ messages: compacted, tools: chat.tools }) > CONTEXT_LIMIT && recent.length > 1 && guard++ < 200) {
    const first = recent[0];
    if (first.role === 'assistant' && Array.isArray(first.tool_calls) && first.tool_calls.length) {
      // Skip a tool_call head: its tool responses follow and must stay.
      break;
    }
    recent.shift();
    compacted = summaryText
      ? [...headSystems, { role: 'system', content: `[Resumen de la conversación anterior]\n${summaryText}` }, ...recent]
      : [...headSystems, ...recent];
  }

  chat.messages = compacted;
  log(`compacted ${old.length} old msgs; ${total} -> ${totalTokens(chat)} tokens`);
  return chat;
}

  return { compactContext };
}

module.exports = { crearCompactacion };
