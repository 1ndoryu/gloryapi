function crearCierre(ctx) {
  const {
    rand, logRequest, upstreamAuthHeader, recoverEmptyCompletion, rememberReasoning, sseEvent,
    assistantMessageFrom, assistantText, assistantReasoning, assistantToolCalls, responseItemsForToolCalls,
    emitResponseCompleted, visibleReasoning, realTokens, totalTokens, calibrate, isFutureIntentNarration,
    isConfirmationText, shouldAuditCompletion, runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure,
    res, chat, toolMap, customTools, responseId, msgId, routedVia, flushBufferedMessage,
    getMessageOutputIndex, reasoningForwarder, toolCalls, estado,
  } = ctx;

  async function cerrar() {
    let forwardedReasoning = false;

    // Reasoning-only output is still incomplete. A tool-only output is valid and
    // continues below as a function_call; it must not be mistaken for an empty
    // response or closed with end_turn=true.
    if (!estado.text && toolCalls.size === 0) {
      const recovered = await recoverEmptyCompletion(chat, upstreamAuthHeader(), 'stream');
      if (recovered) {
        const recoveredMessage = assistantMessageFrom(recovered.json);
        chat.messages = recovered.chat.messages;
        estado.text = assistantText(recoveredMessage);
        const recoveredReasoning = visibleReasoning(assistantReasoning(recoveredMessage));
        if (recoveredReasoning) {
          estado.reasoningText = estado.reasoningText ? `${estado.reasoningText}\n${recoveredReasoning}` : recoveredReasoning;
          reasoningForwarder.add(recoveredReasoning);
        }
        estado.usage = recovered.json.usage || estado.usage;
        for (const tc of assistantToolCalls(recoveredMessage)) {
          const key = Number.isInteger(tc.index) ? tc.index : `recovery_${estado.nextToolIndex++}`;
          toolCalls.set(key, {
            key,
            id: tc.id || rand('call'),
            name: (tc.function && tc.function.name) || '',
            args: (tc.function && tc.function.arguments) || '',
          });
        }
        if (estado.text) estado.bufferedMessageText = estado.text;
      }
    }
    if (!estado.text && toolCalls.size === 0) {
      forwardedReasoning = reasoningForwarder.finish();
      logRequest({
        ts: new Date().toISOString(),
        kind: 'empty_upstream',
        requestId: chat.__gloryRequestId,
        status: 200,
        routedVia,
        contextReal: realTokens(chat),
        forwardedReasoning,
        body: chat,
      });
      sseEvent(res, 'response.failed', {
        type: 'response.failed',
        response: {
          id: responseId,
          error: {
            type: 'empty_upstream_response',
            message:
              'El modelo no devolvió texto final ni llamadas a herramientas. Reduce el contexto o reintenta el mensaje.',
          },
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Anti falso-complete: en modo adaptativo, una respuesta textual ambigua con
    // tools disponibles pasa por una auditoría compacta. Solo si no confirma el
    // cierre se reenvía el contexto completo para continuar. El texto original
    // ya se emitió como delta, pero nunca se emite response.completed si la
    // recuperación queda inconclusa.
    let nudgeReasoning = '';
    if (
      toolCalls.size === 0 &&
      estado.text &&
      shouldAuditCompletion(chat, estado.text)
    ) {
      const nudge = await runNudgeWithKeepAlive(res, chat, estado.text);
      const failure = nudgeFailure(nudge, estado.text);
      if (failure) {
        flushBufferedMessage();
        emitNudgeFailure(res, responseId, chat.__gloryRequestId, failure);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (nudge && nudge.toolCalls.length) {
        let nextIndex = toolCalls.size;
        for (const tc of nudge.toolCalls) {
          toolCalls.set(nextIndex++, {
            id: tc.id || rand('call'),
            name: (tc.function && tc.function.name) || '',
            args: (tc.function && tc.function.arguments) || '',
          });
        }
        nudgeReasoning = nudge.reasoning || '';
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_retry',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: estado.text.length,
          toolCalls: nudge.toolCalls.length,
          toolNames: nudge.toolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
          intent: isFutureIntentNarration(estado.text),
          latencyMs: nudge.latencyMs,
        });
      } else if (nudge && isConfirmationText(nudge.text)) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_confirm',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: estado.text.length,
          intent: isFutureIntentNarration(estado.text),
          latencyMs: nudge.latencyMs,
        });
      } else if (nudge) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_noop',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: estado.text.length,
          intent: isFutureIntentNarration(estado.text),
          latencyMs: nudge.latencyMs,
        });
      }
    }

    // A nudge can contain internal reasoning, but only append it before the
    // message receives an output index; otherwise it would collide with an
    // already-open message item in the Responses stream.
    // Nudge reasoning is useful when no message item has been opened yet. Once
    // text has been streamed, adding a second reasoning delta after the message
    // would violate the Responses output order, so it remains internal.
    if (nudgeReasoning && !estado.msgAdded) reasoningForwarder.add(nudgeReasoning);
    forwardedReasoning = reasoningForwarder.finish();
    flushBufferedMessage();

    // Final message item (accumulated text)
    if (estado.text) {
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: getMessageOutputIndex(),
        item: {
          type: 'message',
          role: 'assistant',
          id: msgId,
          content: [{ type: 'output_text', text: estado.text }],
        },
      });
    }

    // Render all tool variants through the same adapter used by the web-loop and
    // non-streaming path. This is the seam that prevents one transport from
    // reintroducing the old fallback/namespace behavior.
    const upstreamToolCalls = [...toolCalls.values()].map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.args || '{}' },
    }));
    const itemReasoning = visibleReasoning(estado.reasoningText) || visibleReasoning(nudgeReasoning);
    for (const tc of upstreamToolCalls) {
      if (itemReasoning) rememberReasoning(tc.id, itemReasoning);
    }
    const renderedTools = responseItemsForToolCalls(upstreamToolCalls, toolMap, customTools);
    if (renderedTools.error) {
      sseEvent(res, 'response.failed', {
        type: 'response.failed',
        response: { id: responseId, error: renderedTools.error },
      });
      res.end();
      return;
    }
    for (const item of renderedTools.items) {
      sseEvent(res, 'response.output_item.done', { type: 'response.output_item.done', item });
    }

    // Feed the real prompt-token count back into the compaction calibration so
    // that "context limit" decisions use real tokens, not the chars/4 heuristic.
    calibrate(totalTokens(chat), estado.usage ? estado.usage.prompt_tokens || 0 : 0);
    emitResponseCompleted(
      res,
      responseId,
      estado.usage,
      upstreamToolCalls.length > 0,
      routedVia,
      chat.__gloryRequestId,
      estado.text.length,
      upstreamToolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
    );
    res.write('data: [DONE]\n\n');
    res.end();
  }

  return { cerrar };
}

module.exports = { crearCierre };
