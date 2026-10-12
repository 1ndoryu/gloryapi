const { currentTurnHasToolMessages, isActionOrientedRequest, isUserConfirmationRequest, latestUserText, preserveCanaryProvider } = require('./context-util');

function crearAuditoria(ctx) {
  const { AUDIT_ENABLED, AUDIT_MODE, NUDGE_RETRIES, AUDIT_MAX_CHARS, AUDIT_TIMEOUT_MS, isFutureIntentNarration, attachRequestId, fetchUpstreamCompletion, logRequest } = ctx;

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
      reasoning: message.reasoning_content || message.reasoning || '',
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

  return { shouldAuditCompletion, auditCompletion };
}

module.exports = { crearAuditoria };
