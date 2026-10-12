function crearInternalWeb(ctx) {
  const {
    rand, logRequest, redactText, upstreamAuthHeader, runInternalWebToolLoop, rememberReasoning, sseEvent,
    assistantMessageFrom, assistantText, assistantReasoning, assistantToolCalls, responseItemsForToolCalls,
    emitResponseCompleted, createReasoningForwarder, visibleReasoning, realTokens, totalTokens, calibrate,
    isFutureIntentNarration, isConfirmationText, shouldAuditCompletion, responseModel,
    runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure,
  } = ctx;

  async function streamInternalWebLoopToResponses(req, res, chat, toolMap, customTools) {
    const responseId = rand('resp');
    const msgId = rand('msg');
    const reasoningId = rand('rs');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sseEvent(res, 'response.created', {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', model: responseModel(chat) },
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15000);
    let resolved;
    try {
      resolved = await runInternalWebToolLoop(chat, toolMap, upstreamAuthHeader());
    } catch (error) {
      clearInterval(keepAlive);
      logRequest({ ts: new Date().toISOString(), kind: 'web_loop_error', requestId: chat.__gloryRequestId, status: error.statusCode || 502, error: error.message });
      sseEvent(res, 'response.failed', {
        type: 'response.failed',
        response: { id: responseId, error: { type: 'web_loop_error', message: redactText(error.message) } },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    clearInterval(keepAlive);

    const message = assistantMessageFrom(resolved.json);
    const reasoningText = visibleReasoning(assistantReasoning(message));
    const text = assistantText(message);
    const toolCalls = assistantToolCalls(message);
    // Reasoning-only output is incomplete; tool-only output is a valid
    // continuation and is rendered below.
    if (!text && toolCalls.length === 0) {
      logRequest({
        ts: new Date().toISOString(),
        kind: 'empty_upstream',
        requestId: chat.__gloryRequestId,
        status: 200,
        internalWebLoop: true,
        routedVia: resolved.json.__routedVia || null,
        contextReal: realTokens(chat),
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
    // The internal web loop used to return here with a future-intent sentence
    // and no tool call. That bypassed the universal anti-falso-complete guard,
    // so Codex closed the browser task even though the model still intended to
    // inspect the page. Reuse the same bounded confirmation audit as streaming.
    let finalToolCalls = toolCalls;
    let nudgeReasoning = '';
    if (
      toolCalls.length === 0 &&
      text &&
      shouldAuditCompletion(resolved.working, text)
    ) {
      const nudge = await runNudgeWithKeepAlive(res, resolved.working, text);
      const failure = nudgeFailure(nudge, text);
      if (failure) {
        emitNudgeFailure(res, responseId, chat.__gloryRequestId, failure, true);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (nudge && nudge.toolCalls.length) {
        finalToolCalls = nudge.toolCalls;
        nudgeReasoning = nudge.reasoning || '';
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_retry',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: text.length,
          toolCalls: nudge.toolCalls.length,
          toolNames: nudge.toolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
          intent: isFutureIntentNarration(text),
          latencyMs: nudge.latencyMs,
          internalWebLoop: true,
        });
      } else if (nudge && isConfirmationText(nudge.text)) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_confirm',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: text.length,
          intent: isFutureIntentNarration(text),
          latencyMs: nudge.latencyMs,
          internalWebLoop: true,
        });
      } else if (nudge) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_noop',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: text.length,
          intent: isFutureIntentNarration(text),
          latencyMs: nudge.latencyMs,
          internalWebLoop: true,
        });
      }
    }

    const reasoningForwarder = createReasoningForwarder(res, reasoningId, () => 0);
    reasoningForwarder.add(reasoningText);
    reasoningForwarder.add(nudgeReasoning);
    const reasoningOutputIndex = reasoningForwarder.hasEmitted() ? reasoningForwarder.outputIndex() : null;
    const messageOutputIndex = reasoningOutputIndex === null ? 0 : reasoningOutputIndex + 1;
    reasoningForwarder.finish();

    if (text) {
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: messageOutputIndex,
        item: { type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text: '' }] },
      });
      sseEvent(res, 'response.output_text.delta', {
        type: 'response.output_text.delta', item_id: msgId, output_index: messageOutputIndex, content_index: 0, delta: text,
      });
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: messageOutputIndex,
        item: { type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text }] },
      });
    }

    const itemReasoning = visibleReasoning(reasoningText) || visibleReasoning(nudgeReasoning);
    for (const tc of finalToolCalls) {
      if (itemReasoning) rememberReasoning(tc.id, itemReasoning);
    }
    const renderedTools = responseItemsForToolCalls(finalToolCalls, toolMap, customTools);
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

    const usage = resolved.aggregateUsage;
    calibrate(totalTokens(resolved.working), resolved.lastPromptTokens);
    emitResponseCompleted(
      res,
      responseId,
      usage,
      finalToolCalls.length > 0,
      resolved.json.__routedVia || null,
      chat.__gloryRequestId,
      text.length,
      finalToolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
      true,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  }

  return { streamInternalWebLoopToResponses };
}

module.exports = { crearInternalWeb };
