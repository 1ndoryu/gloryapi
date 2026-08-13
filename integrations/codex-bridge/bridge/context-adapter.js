function createContextAdapter({
  config,
  log,
  logRequest,
  formatRemoteFailure,
  normalizeReasoningText,
  visibleReasoning,
  fallbackReasoning,
  fetchUpstreamCompletion,
  attachRequestId,
}) {
  const { context, limits, upstream, recovery, calibration } = config;
  const SUMMARY_MODEL = context.summaryModel;
  const UPSTREAM_TIMEOUT_MS = upstream.timeoutMs;
  const COMPACTION_DISABLED = context.disabled;
  const CONTEXT_LIMIT = context.limitTokens;
  const COMPACT_KEEP = context.keepTokens;
  const COMPACT_MAX_TOKENS = context.summaryMaxTokens;
  const COMPACTION_SAFETY_FACTOR = context.safetyFactor;
  const MAX_SYSTEM_CHARS = limits.maxSystemChars;
  const DEFAULT_CALIB_RATIO = calibration.defaultRatio;
  const CALIB_MIN_HEUR = calibration.minimumHeuristic;
  const CALIB_OBSERVED_MIN = calibration.observedMinimum;
  const CALIB_OBSERVED_MAX = calibration.observedMaximum;
  const FALLBACK_REASONING = fallbackReasoning;
  const CONFIRM_DIRECTIVE = recovery.confirmDirective;
  const CONTINUE_DIRECTIVE = recovery.continueDirective || recovery.confirmDirective;
  const NUDGE_RETRIES = recovery.nudgeRetries;
  const NUDGE_TIMEOUT_MS = recovery.nudgeTimeoutMs;
  const NUDGE_TIMEOUT_RECOVERY_MS = recovery.nudgeTimeoutRecoveryMs || NUDGE_TIMEOUT_MS;
  const NUDGE_MAX_ATTEMPTS = recovery.nudgeMaxAttempts || 1;
  const NUDGE_BUDGET_MS = recovery.nudgeBudgetMs || NUDGE_TIMEOUT_RECOVERY_MS;
  const AUDIT_ENABLED = recovery.auditEnabled !== false;
  const AUDIT_MODE = recovery.auditMode || (AUDIT_ENABLED ? 'adaptive' : 'off');
  const AUDIT_TIMEOUT_MS = recovery.auditTimeoutMs || NUDGE_TIMEOUT_MS;
  const AUDIT_MAX_CHARS = recovery.auditMaxChars || 5000;
  function preserveCanaryProvider(source, target) {
    if (typeof source.__canaryProvider === 'string') {
      Object.defineProperty(target, '__canaryProvider', {
        value: source.__canaryProvider,
        enumerable: false,
      });
    }
    return target;
  }

// Context window + native autocompaction
// Context window + native autocompaction
// ---------------------------------------------------------------------------
// When the translated conversation exceeds CONTEXT_LIMIT_TOKENS, the oldest
// messages are summarized into a single system message (like ChatGPT's native
// compaction) while the most recent COMPACT_KEEP_TOKENS stay intact. The
// summary is produced by the main model via the same upstream (cheap flash),
// with a heuristic fallback if the summarization call fails (fail-open).

// COMPACTACIÓN DESACTIVADA por defecto (2026-08-09): Codex nativo hace la
// autocompactación en la app (auto_compact_token_limit=120000 en models.json,
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

function estimateTokens(m) {
  let n = 4; // per-message overhead
  const count = (s) => Math.ceil((s || '').length / 4);
  if (typeof m.content === 'string') {
    n += count(m.content);
  } else if (Array.isArray(m.content)) {
    for (const p of m.content) n += count(p && p.text);
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      n += count(tc.function && tc.function.name) + count(tc.function && tc.function.arguments) + 6;
    }
  }
  n += count(m.reasoning_content);
  return n;
}

/**
 * Bound a system prompt that exceeds MAX_SYSTEM_CHARS. Codex Desktop inflates
 * the system prompt with browser-plugin documentation and tool training text;
 * forwarding it verbatim pushes DeepSeek past its window and it returns an
 * empty completion (stall). Cutting at line boundaries keeps code blocks and
 * JSON intact and preserves the head (critical instructions) plus the tail.
 * A trailing notice tells the model that mid-context was elided.
 */
function boundSystemContent(content, maxChars = MAX_SYSTEM_CHARS) {
  if (!maxChars) return content;
  const truncate = (text) => {
    const s = String(text || '');
    if (s.length <= maxChars) return s;
    const headChars = Math.floor(maxChars * 0.7);
    const tailChars = maxChars - headChars;
    // Prefer line boundaries so we never enter/exit the middle of a block.
    let headEnd = s.lastIndexOf('\n', headChars);
    if (headEnd < maxChars * 0.5) headEnd = headChars;
    let tailStart = s.indexOf('\n', s.length - tailChars);
    if (tailStart < 0 || tailStart < headEnd) tailStart = s.length - tailChars;
    const head = s.slice(0, headEnd);
    const tail = s.slice(tailStart + 1);
    log(`system prompt truncated ${s.length} chars -> ${head.length + tail.length} (max=${maxChars})`);
    return `${head}\n[... system prompt recortado por el bridge; se omitieron ${
      s.length - head.length - tail.length
    } chars del medio; conserva las instrucciones iniciales y las del final ...]\n${tail}`;
  };
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? { ...part, text: truncate(part.text) } : part));
  }
  return content;
}

function totalTokens(messages) {
  const list = Array.isArray(messages) ? messages : messages && Array.isArray(messages.messages) ? messages.messages : [];
  let total = list.reduce((s, m) => s + estimateTokens(m), 0);
  if (!Array.isArray(messages) && messages && Array.isArray(messages.tools) && messages.tools.length) {
    // Tool schemas are part of the provider prompt even though they do not
    // appear in `messages`. Omitting them made plugin/MCP-heavy requests look
    // small enough to skip the safety compaction while exceeding the model's
    // real context window.
    total += Math.ceil(JSON.stringify(messages.tools).length / 4) + 4;
  }
  return total;
}

// Multi-agent v2: `spawn_agent` with an explicit `agent_type` is REJECTED by
// Codex when the fork is full-history (the default), which is exactly what
// DeepSeek does when it wants a specialized role:
//   "Full-history forked agents inherit the parent agent type; omit agent_type,
//    or spawn without a full-history fork."
// (codex-rs `multi_agents_common.rs` reject_full_fork_agent_type_override).
// Fix: force `fork_turns: "none"` in that case, so the spawn succeeds and the
// subagent receives its context exclusively through `message` (V2 semantics).
// Also neutralize the V1 `fork_context: true` variant defensively.
function withSpawnForkFix(name, argsString) {
  if (name !== 'spawn_agent') return argsString;
  let parsed;
  try {
    parsed = JSON.parse(argsString);
  } catch {
    return argsString;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.agent_type !== 'string') return argsString;
  let changed = false;
  if (parsed.fork_turns === undefined || parsed.fork_turns === 'all') {
    parsed.fork_turns = 'none';
    changed = true;
  }
  if (parsed.fork_context === true) {
    parsed.fork_context = false;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : argsString;
}

// ---------------------------------------------------------------------------
// Anti falso-complete (2026-08-10; hook de confirmación 2026-08-11)
// ---------------------------------------------------------------------------
// DeepSeek a veces cierra con texto sin invocar la herramienta ("Voy a escanear
// los .md...", "Sigo la auditoría leyendo...", "I will check..."), y Codex
// Desktop interpreta texto sin function_call como fin de turno y cierra con
// task_complete sin ejecutar nada. La política adaptativa evita reenviar el
// historial completo cuando no hace falta: audita con un cuerpo mínimo los
// turnos ambiguos y solo construye la continuación completa si la auditoría no
// confirma el cierre. Una auditoría inconclusa nunca equivale a confirmación.
function isFutureIntentNarration(text) {
  if (!text) return false;
  // ES + EN: la narración de intención futura sin ejecución ocurre en ambos
  // idiomas ("Voy a escanear...", "I will scan...", "I'm going to...",
  // "Let me check...", "I need to..."). Las contracciones evitan apóstrofes
  // literales (i.ll / i.m / i.d) para no romper el parser estático del test.
  // Solo alimenta telemetría: un falso negativo ya no puede desactivar el
  // nudge universal.
  return /(voy a|vamos a|necesito|debo|lo reintento|reintento|procedo a|ahora voy|primero voy|lo haré|intentaré|voy a intentar|voy a hacer|voy a (escanear|revisar|buscar|crear|editar|modificar|comprobar|listar|ejecutar|probar|analizar|leer|abrir|instalar|configurar|correr|verificar)|\bi (will|am going to|need to|should|have to|want to|would like to)\b|\bi.ll\b|\bi.m\b|\bi.d\b|let me (try|check|start|look|scan|review|open|read|run|test|verify|search|list))/i.test(
    text,
  );
}

// isConfirmationText: "ok"/"done"/"listo"/"sí"... — la respuesta concreta con
// la que el modelo confirma el cierre SIN re-activar el hook. Corta y de
// acuerdo; "ok, pero falta X" o cualquier narración no cuenta como confirmación.
function isConfirmationText(text) {
  if (!text) return false;
  const t = String(text)
    .trim()
    .toLowerCase()
    .replace(/[.,!¡¿?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const okVariant = /^(ok|okay|okey|kk)( done| listo| hecho| terminado| gracias| si| sí| de acuerdo)?$/;
  return (
    /^(ok|okay|okey|kk|done|yes|si|sí|listo|hecho|terminado|completado|finished|complete|all done|that.s (it|all)|eso es todo|ya está|ya esta|nada más|nothing (else|more)|perfecto|vale|de acuerdo|entendido|confirmo|confirmado)$/.test(
      t,
    ) ||
    okVariant.test(t)
  );
}

// ¿El turno ACTUAL (desde el último mensaje del usuario) ya ejecutó tools?
// Se conserva para telemetría y compatibilidad con consumidores del adaptador;
// el guard de cierre ya no depende de este dato ni de una frase de intención.
function currentTurnHasToolMessages(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return false; // sin user visible, no hay turno que nudgear
  for (let i = lastUser + 1; i < messages.length; i += 1) {
    if (messages[i] && messages[i].role === 'tool') return true;
  }
  return false;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function latestUserText(messages, preferredText = '') {
  if (typeof preferredText === 'string' && preferredText.trim()) return preferredText;
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') return messageText(messages[i]);
  }
  return '';
}

// This is intentionally based on the user's request, not on a phrase chosen by
// the model. It avoids paying for an audit on greetings while still auditing
// action-shaped turns that could close after a narration without a tool call.
function isActionOrientedRequest(messages, preferredText = '') {
  const text = latestUserText(messages, preferredText).trim();
  if (!text) return false;
  const unambiguousAction = /\b(abr(e|ir)|actualiza|añade|analiza|arregla|busca|cambia|comprueba|configura|corrige|crea|diagnostica|ejecuta|escribe|inspecciona|instala|lee|lista|muestra|obten|ordena|revisa|repite|resuelve|reinicia|usa|verifica|abre|add|analy[sz]e|build|check|configure|create|diagnose|edit|execute|fix|inspect|install|list|open|read|review|run|search|sort|update|verify)\b/i;
  const directTestCommand = /^(?:(?:hola|buenas|hello|hi)[, ]+)?(?:por favor[, ]+|please\s+)?(?:prueba|test)\b/i;
  return unambiguousAction.test(text) || directTestCommand.test(text);
}

function isUserConfirmationRequest(messages, preferredText = '') {
  const text = latestUserText(messages, preferredText).trim().toLowerCase().replace(/[.!?,;:]+$/g, '');
  return /^(ok|okay|vale|listo|ya está|ya esta|terminaste|terminó|termino|eso es todo|nada más|nada mas)$/.test(text);
}

function shouldAuditCompletion(chat, text) {
  if (!AUDIT_ENABLED || AUDIT_MODE === 'off' || NUDGE_RETRIES <= 0) return false;
  if (chat && chat.__requestKind && chat.__requestKind !== 'main') return false;
  if (!chat || chat.__userTools !== true || !Array.isArray(chat.tools) || !chat.tools.length) return false;
  if (AUDIT_MODE === 'strict') return true;
  const hasCurrentTools = currentTurnHasToolMessages(chat.messages || []);
  if (!hasCurrentTools && isUserConfirmationRequest(chat.messages || [], chat.__latestUserText)) return false;
  return hasCurrentTools
    || isActionOrientedRequest(chat.messages || [], chat.__latestUserText)
    || isFutureIntentNarration(text);
}

function boundedAuditText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= AUDIT_MAX_CHARS) return text;
  return `${text.slice(0, AUDIT_MAX_CHARS - 1)}…`;
}

function buildAuditChat(chat, finalText) {
  const auditChat = {
    model: chat.model,
    messages: [
      {
        role: 'system',
        content: 'Auditoría de cierre. Responde únicamente COMPLETE o CONTINUE. COMPLETE significa que la respuesta candidata satisface el pedido. CONTINUE significa que falta una acción de herramienta. No ejecutes herramientas y no expliques tu decisión.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          pedido: boundedAuditText(latestUserText(chat.messages || [], chat.__latestUserText)),
          respuesta: boundedAuditText(finalText),
          herramientasDisponibles: Array.isArray(chat.tools) ? chat.tools.length : 0,
          herramientasEjecutadasEnEsteTurno: currentTurnHasToolMessages(chat.messages || []),
        }),
      },
    ],
    stream: false,
    max_tokens: 8,
  };
  preserveCanaryProvider(chat, auditChat);
  if (typeof attachRequestId === 'function' && chat.__gloryRequestId) attachRequestId(auditChat, chat.__gloryRequestId);
  Object.defineProperty(auditChat, '__requestKind', { value: 'audit', enumerable: false });
  Object.defineProperty(auditChat, '__parentRequestId', { value: chat.__gloryRequestId || '', enumerable: false });
  return auditChat;
}

function auditDecision(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/[.!?,;:]+$/g, '');
  const first = normalized.split(/\s+/)[0].replace(/[^a-záéíóúüñ]/gi, '');
  if (/^(ok|okay|okey|yes|si|sí|confirmado|confirmada)$/.test(normalized)) return 'confirmed';
  if (first === 'complete' || first === 'completado' || first === 'done') return 'confirmed';
  if (first === 'continue' || first === 'continuar' || first === 'incompleto') return 'continue';
  return null;
}

async function auditCompletion(chat, authorization, finalText, options = {}) {
  const startedAt = Date.now();
  const auditChat = buildAuditChat(chat, finalText);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || AUDIT_TIMEOUT_MS);
  try {
    const json = await fetchUpstreamCompletion(auditChat, authorization, timeoutMs);
    const message = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message : {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const text = typeof message.content === 'string' ? message.content : '';
    const decision = toolCalls.length ? 'continue' : auditDecision(text);
    const result = {
      status: decision === 'confirmed' ? 'confirmed' : decision === 'continue' ? 'continue' : 'inconclusive_unconfirmed',
      toolCalls,
      reasoning: message.reasoning_content || '',
      routedVia: json.__routedVia || null,
      text,
      latencyMs: Date.now() - startedAt,
      attempts: 1,
      audit: true,
    };
    logRequest({
      ts: new Date().toISOString(),
      kind: 'completion_audit',
      requestId: chat.__gloryRequestId,
      status: 200,
      decision: result.status,
      routedVia: result.routedVia,
      inputChars: boundedAuditText(latestUserText(chat.messages || [], chat.__latestUserText)).length,
      candidateChars: boundedAuditText(finalText).length,
      latencyMs: result.latencyMs,
    });
    return result;
  } catch (error) {
    const timedOut = error && error.__timedOut === true;
    logRequest({
      ts: new Date().toISOString(),
      kind: 'completion_audit_error',
      requestId: chat.__gloryRequestId,
      status: error.statusCode || 502,
      error: error.message,
      timedOut,
      latencyMs: Date.now() - startedAt,
    });
    return {
      status: timedOut ? 'inconclusive_timeout' : 'inconclusive_error',
      failureType: timedOut ? 'timeout' : 'upstream_error',
      error: error && error.message ? error.message : 'completion audit failed',
      toolCalls: [],
      reasoning: '',
      routedVia: null,
      text: '',
      latencyMs: Date.now() - startedAt,
      attempts: 1,
      audit: true,
    };
  }
}

// El retry reenvía el texto final como mensaje assistant (contexto de lo
// anunciado) y añade la directiva de confirmación de cierre como user.
function buildNudgeChat(chat, finalText) {
  const nudgeChat = preserveCanaryProvider(chat, {
    ...chat,
    stream: false,
    messages: [
      ...(chat.messages || []),
      { role: 'assistant', content: finalText || '' },
      { role: 'user', content: CONFIRM_DIRECTIVE },
    ],
  });
  // The spread intentionally drops non-enumerable request metadata. Restore
  // the correlation id so the nudge remains part of the same bridge turn in
  // upstream logs and canary routing diagnostics.
  if (typeof attachRequestId === 'function' && chat.__gloryRequestId) {
    attachRequestId(nudgeChat, chat.__gloryRequestId);
  }
  Object.defineProperty(nudgeChat, '__requestKind', { value: 'continuation', enumerable: false });
  Object.defineProperty(nudgeChat, '__parentRequestId', { value: chat.__gloryRequestId || '', enumerable: false });
  return nudgeChat;
}

// Devuelve una unión explícita: tool_calls, confirmed, inconclusive_unconfirmed,
// inconclusive_timeout o inconclusive_error. Una narración intermedia recibe
// rondas adicionales de ejecución; si el presupuesto se agota, el resultado
// inconcluso nunca puede convertirse en un cierre exitoso del turno.
async function nudgeForToolCalls(chat, authorization, finalText, options = {}) {
  const nudgeChat = buildNudgeChat(chat, finalText);
  const startedAt = Date.now();
  const budgetMs = Math.max(1, Number(options.budgetMs) || NUDGE_BUDGET_MS);
  const deadline = startedAt + budgetMs;
  const firstTimeoutMs = Math.max(1, Number(options.timeoutMs) || NUDGE_TIMEOUT_MS);
  const recoveryTimeoutMs = Math.max(1, Number(options.recoveryTimeoutMs) || NUDGE_TIMEOUT_RECOVERY_MS);
  let attempt = 0;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || attempt >= NUDGE_MAX_ATTEMPTS) {
      return {
        status: 'inconclusive_timeout',
        failureType: 'timeout',
        error: 'nudge budget exhausted',
        routedVia: null,
        toolCalls: [],
        reasoning: '',
        text: '',
        latencyMs: Date.now() - startedAt,
        attempts: attempt,
      };
    }
    attempt += 1;
    const timeoutMs = Math.min(
      attempt === 1 ? firstTimeoutMs : recoveryTimeoutMs,
      remainingMs,
    );
    try {
      const json = await fetchUpstreamCompletion(nudgeChat, authorization, timeoutMs);
      const message =
        json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message : {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const text = typeof message.content === 'string' ? message.content : '';
      const reasoning = message.reasoning_content || '';
      const routedVia = json.__routedVia || null;
      if (toolCalls.length || isConfirmationText(text)) {
        return {
          status: toolCalls.length ? 'tool_calls' : 'confirmed',
          toolCalls,
          reasoning,
          routedVia,
          text,
          latencyMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }
      if (attempt < NUDGE_MAX_ATTEMPTS && Date.now() < deadline) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_unconfirmed_retry',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia,
          textLen: text.length,
          attempt: attempt + 1,
          latencyMs: Date.now() - startedAt,
        });
        // Preserve the provider's latest answer as assistant context, then make
        // the next round execute instead of narrating. The original finalText
        // remains visible only once at the Responses boundary.
        nudgeChat.messages.push({ role: 'assistant', content: text });
        nudgeChat.messages.push({ role: 'user', content: CONTINUE_DIRECTIVE });
        continue;
      }
      return {
        status: 'inconclusive_unconfirmed',
        failureType: 'unconfirmed',
        error: 'nudge returned no tool call or confirmation',
        toolCalls: [],
        reasoning,
        routedVia,
        text,
        latencyMs: Date.now() - startedAt,
        attempts: attempt,
      };
    } catch (error) {
      const timedOut = error && error.__timedOut === true;
      logRequest({
        ts: new Date().toISOString(),
        kind: 'nudge_error',
        requestId: chat.__gloryRequestId,
        status: error.statusCode || 502,
        error: error.message,
        timeoutMs,
        attempt,
        timedOut,
        latencyMs: Date.now() - startedAt,
      });
      if (timedOut && attempt < NUDGE_MAX_ATTEMPTS && Date.now() < deadline) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_timeout_retry',
          requestId: chat.__gloryRequestId,
          status: 502,
          timeoutMs: Math.min(recoveryTimeoutMs, deadline - Date.now()),
          attempt: attempt + 1,
        });
        continue;
      }
      return {
        status: timedOut ? 'inconclusive_timeout' : 'inconclusive_error',
        failureType: timedOut ? 'timeout' : 'upstream_error',
        error: error && error.message ? error.message : 'nudge failed',
        routedVia: null,
        toolCalls: [],
        reasoning: '',
        text: '',
        latencyMs: Date.now() - startedAt,
        attempts: attempt,
      };
    }
  }
}

// The compact audit is the default gate. Only a CONTINUE decision pays for the
// old full-context continuation, and an inconclusive audit fails closed through
// that same bounded continuation path.
async function auditThenNudge(chat, authorization, finalText) {
  const startedAt = Date.now();
  const budgetMs = NUDGE_BUDGET_MS;
  const audit = await auditCompletion(chat, authorization, finalText, {
    // The audit must leave room for the real continuation. A slow audit is
    // only useful if it does not consume the entire recovery budget first.
    timeoutMs: Math.min(AUDIT_TIMEOUT_MS, NUDGE_TIMEOUT_MS, budgetMs),
  });
  if (audit.status === 'confirmed' || audit.status === 'tool_calls') return audit;
  const remainingMs = budgetMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    return {
      ...audit,
      status: 'inconclusive_timeout',
      failureType: 'timeout',
      error: 'audit and continuation budget exhausted',
      latencyMs: Date.now() - startedAt,
      attempts: audit.attempts || 1,
    };
  }
  const continuation = await nudgeForToolCalls(chat, authorization, finalText, {
    budgetMs: remainingMs,
    timeoutMs: Math.min(NUDGE_TIMEOUT_MS, remainingMs),
    recoveryTimeoutMs: Math.min(NUDGE_TIMEOUT_RECOVERY_MS, remainingMs),
  });
  if (continuation && continuation.audit !== true) continuation.audit = audit;
  if (continuation) continuation.latencyMs = Date.now() - startedAt;
  return continuation;
}

// ---------------------------------------------------------------------------
// Real-token calibration
// ---------------------------------------------------------------------------
// estimateTokens() (chars/4) is a rough heuristic and DeepSeek's tokenizer
// differs a lot from it (observed on this setup: ~990k heuristic ≈ ~146k real
// tokens, ratio ≈ 0.15). The upstream reports the REAL prompt token count in
// every response (stream_options.include_usage), so we calibrate a live ratio
// and use it for compaction decisions. This makes "120k" mean the same thing
// here as in VS Code, and stops the bridge from compacting conversations that
// Codex already compacted natively (which would destroy the good summaries).
const CALIB = { heur: 0, real: 0 };
// Guards against probe requests desyncing the ratio. Observed 2026-08-10: a
// request with almost no message content (heur=7) but huge tool definitions
// upstream (real=2630) produced observed=375 -> blended=150, so a normal
// 15k-heur conversation "reported" ~2M real tokens and the safety net fired
// on a FRESH conversation. Real ratio on this setup is ~2x. Ignore readings
// whose heuristic is dominated by tool defs, and clamp the observed ratio.
let calibRatio = DEFAULT_CALIB_RATIO;
let lastCalibLogged = -1;
let calibCount = 0;

function realTokens(messages) {
  return Math.round(totalTokens(messages) * calibRatio);
}

function calibrate(heurTokens, realPromptTokens) {
  if (!(heurTokens > 0) || !(realPromptTokens > 0)) return;
  // Ignore tiny readings: they are probe/no-context requests where the
  // upstream prompt_tokens are mostly tool definitions, not conversation.
  if (heurTokens < CALIB_MIN_HEUR) return;
  CALIB.heur += heurTokens;
  CALIB.real += realPromptTokens;
  let observed = CALIB.real / CALIB.heur;
  const clamped = observed < CALIB_OBSERVED_MIN || observed > CALIB_OBSERVED_MAX;
  observed = Math.min(CALIB_OBSERVED_MAX, Math.max(CALIB_OBSERVED_MIN, observed));
  // Blend toward the new observation so one outlier cannot dominate.
  calibRatio = 0.6 * calibRatio + 0.4 * observed;
  calibCount++;
  // Log the first few readings and then only when the ratio moves materially,
  // so a request per turn does not spam bridge.out.log.
  if (calibCount <= 5 || Math.abs(calibRatio - lastCalibLogged) > 0.01) {
    lastCalibLogged = calibRatio;
    log(`calibration: heur=${heurTokens} real=${realPromptTokens} observed=${observed.toFixed(4)} blended=${calibRatio.toFixed(4)}${clamped ? ' clamped' : ''}`);
  }
}

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

async function summarizeHistory(oldMessages, auth, canaryProvider, requestId) {
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
    summaryText = await summarizeHistory(old, auth, chat.__canaryProvider, chat.__gloryRequestId);
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

// ---------------------------------------------------------------------------

  return {
    boundSystemContent,
    compactContext,
    totalTokens,
    realTokens,
    calibrate,
    normalizeReasoningText,
    visibleReasoning,
    withSpawnForkFix,
    isFutureIntentNarration,
    isConfirmationText,
    currentTurnHasToolMessages,
    shouldAuditCompletion,
    auditCompletion,
    auditThenNudge,
    nudgeForToolCalls,
  };
}

module.exports = { createContextAdapter };
