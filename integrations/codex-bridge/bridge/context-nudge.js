const { preserveCanaryProvider } = require('./context-util');

function crearNudge(ctx) {
  const { CONFIRM_DIRECTIVE, CONTINUE_DIRECTIVE, NUDGE_BUDGET_MS, NUDGE_TIMEOUT_MS, NUDGE_TIMEOUT_RECOVERY_MS, NUDGE_MAX_ATTEMPTS, AUDIT_TIMEOUT_MS, attachRequestId, fetchUpstreamCompletion, isConfirmationText, logRequest, auditCompletion } = ctx;

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
      const reasoning = message.reasoning_content || message.reasoning || '';
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

  return { nudgeForToolCalls, auditThenNudge };
}

module.exports = { crearNudge };
