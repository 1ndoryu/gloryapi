function crearNudge(ctx) {
  const { logRequest, upstreamAuthHeader, sseEvent, auditThenNudge, nudgeForToolCalls } = ctx;

  async function runNudgeWithKeepAlive(res, chat, finalText) {
    const keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': nudge-recovery\n\n');
    }, 10000);
    try {
      return await (auditThenNudge || nudgeForToolCalls)(chat, upstreamAuthHeader(), finalText);
    } finally {
      clearInterval(keepAlive);
    }
  }

  function nudgeFailure(nudge, text) {
    if (nudge && (nudge.status === 'inconclusive_timeout' || nudge.status === 'inconclusive_error')) {
      return {
        type: nudge.status === 'inconclusive_timeout' ? 'tool_recovery_timeout' : 'tool_recovery_error',
        message:
          nudge.status === 'inconclusive_timeout'
            ? 'La recuperación de la herramienta agotó sus reintentos acotados; el turno no se marcó como completado.'
            : 'La recuperación de la herramienta falló; el turno no se marcó como completado.',
        cause: nudge.error,
      };
    }
    if (!nudge || nudge.status === 'inconclusive_unconfirmed') {
      return {
        type: 'tool_recovery_unresolved',
        message:
          'El modelo anunció una acción pero no devolvió una llamada de herramienta ni una confirmación de cierre; el turno no se marcó como completado.',
        cause: text,
      };
    }
    return null;
  }

  function emitNudgeFailure(res, responseId, requestId, failure, internalWebLoop = false) {
    logRequest({
      ts: new Date().toISOString(),
      kind: 'nudge_recovery_exhausted',
      requestId,
      status: 502,
      error: failure.message,
      failureType: failure.type,
      internalWebLoop,
    });
    if (res.writableEnded || res.destroyed) return;
    sseEvent(res, 'response.failed', {
      type: 'response.failed',
      response: {
        id: responseId,
        error: { type: failure.type, message: failure.message, retryable: true },
      },
    });
  }

  return { runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure };
}

module.exports = { crearNudge };
