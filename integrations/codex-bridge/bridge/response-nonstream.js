// ---------------------------------------------------------------------------
// Non-streaming path (Codex always streams, kept for robustness)
// ---------------------------------------------------------------------------

function crearNonStream(ctx) {
  const {
    rand, logRequest, redactText, upstreamAuthHeader, runInternalWebToolLoop, hasWebTool,
    fetchWithTimeoutRecovery, recoverEmptyCompletion, rememberReasoning, assistantMessageFrom, assistantText,
    assistantReasoning, assistantToolCalls, hasVisibleAssistantAction, responseItemsForToolCalls,
    responseUsageFromChatUsage, visibleReasoning, realTokens, totalTokens, calibrate, nudgeForToolCalls,
    auditThenNudge, isFutureIntentNarration, isConfirmationText, shouldAuditCompletion, responseModel,
    nudgeFailure,
  } = ctx;

  async function nonStreamingChatToResponses(req, res, chat, toolMap, customTools) {
    const responseId = rand('resp');
    const msgId = rand('msg');
    let json;
    let responseUsage = null;
    let gateChat = chat;
    try {
      if (hasWebTool(toolMap)) {
        const resolved = await runInternalWebToolLoop(chat, toolMap, upstreamAuthHeader());
        json = resolved.json;
        gateChat = resolved.working;
        responseUsage = {
          prompt_tokens: resolved.aggregateUsage.prompt_tokens,
          completion_tokens: resolved.aggregateUsage.completion_tokens,
          total_tokens: resolved.aggregateUsage.total_tokens,
          completion_tokens_details: { reasoning_tokens: resolved.aggregateUsage.reasoning_tokens },
        };
        calibrate(totalTokens(resolved.working), resolved.lastPromptTokens);
      } else {
        json = await fetchWithTimeoutRecovery(chat, upstreamAuthHeader());
        responseUsage = json.usage || null;
      }
    } catch (error) {
      const status = error.statusCode || 502;
      logRequest({ ts: new Date().toISOString(), kind: 'upstream_error', requestId: chat.__gloryRequestId, status, error: error.message, body: chat });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: redactText(error.message) } }));
      return;
    }
    let message = assistantMessageFrom(json);
    if (!hasVisibleAssistantAction(message)) {
      const recovered = await recoverEmptyCompletion(chat, upstreamAuthHeader(), 'non-stream');
      if (recovered) {
        json = recovered.json;
        gateChat = recovered.chat;
        responseUsage = recovered.json.usage || responseUsage;
        message = assistantMessageFrom(json);
      }
    }
    const reasoningText = visibleReasoning(assistantReasoning(message));
    const toolCalls = assistantToolCalls(message);
    let hasToolOutput = toolCalls.length > 0;
    const output = [];
    if (reasoningText) {
      output.push({
        type: 'reasoning',
        id: rand('rs'),
        summary: [{ type: 'summary_text', text: reasoningText }],
      });
    }
    if (assistantText(message)) {
      output.push({ type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text: assistantText(message) }] });
    }
    for (const tc of toolCalls) {
      if (reasoningText) rememberReasoning(tc.id, reasoningText);
    }
    let renderedTools = responseItemsForToolCalls(toolCalls, toolMap, customTools);
    if (renderedTools.error) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: renderedTools.error }));
      return;
    }
    output.push(...renderedTools.items);
    // Anti falso-complete: misma política adaptativa que en streaming. La
    // auditoría compacta confirma cierres claros; la continuación completa solo
    // se usa cuando hace falta ejecutar una acción pendiente.
    if (
      toolCalls.length === 0 &&
      assistantText(message) &&
      shouldAuditCompletion(gateChat, assistantText(message))
    ) {
      const nudge = await (auditThenNudge || nudgeForToolCalls)(gateChat, upstreamAuthHeader(), assistantText(message));
      const failure = nudgeFailure(nudge, assistantText(message));
      if (failure) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_recovery_exhausted',
          requestId: chat.__gloryRequestId,
          status: 502,
          error: failure.message,
          failureType: failure.type,
        });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { ...failure, retryable: true } }));
        return;
      }
      if (nudge && nudge.toolCalls.length) {
        const nudgeReasoning = nudge.reasoning || '';
        if (!reasoningText && nudgeReasoning) {
          output.unshift({
            type: 'reasoning',
            id: rand('rs'),
            summary: [{ type: 'summary_text', text: visibleReasoning(nudgeReasoning) }],
          });
        }
        for (const tc of nudge.toolCalls) {
          if (nudgeReasoning) rememberReasoning(tc.id, nudgeReasoning);
        }
        const nudgeItems = responseItemsForToolCalls(nudge.toolCalls, toolMap, customTools);
        if (nudgeItems.error) {
          logRequest({
            ts: new Date().toISOString(),
            kind: 'nudge_tool_render_error',
            requestId: chat.__gloryRequestId,
            status: 502,
            error: nudgeItems.error.message,
            failureType: nudgeItems.error.type,
          });
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { ...nudgeItems.error, retryable: true },
          }));
          return;
        }
        output.push(...nudgeItems.items);
        hasToolOutput = hasToolOutput || nudgeItems.items.length > 0;
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_retry',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: assistantText(message).length,
          toolCalls: nudge.toolCalls.length,
          toolNames: nudge.toolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
          intent: isFutureIntentNarration(assistantText(message)),
          latencyMs: nudge.latencyMs,
        });
      } else if (nudge && isConfirmationText(nudge.text)) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_confirm',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: assistantText(message).length,
          intent: isFutureIntentNarration(assistantText(message)),
          latencyMs: nudge.latencyMs,
        });
      } else if (nudge) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'nudge_noop',
          requestId: chat.__gloryRequestId,
          status: 200,
          routedVia: nudge.routedVia,
          textLen: assistantText(message).length,
          intent: isFutureIntentNarration(assistantText(message)),
          latencyMs: nudge.latencyMs,
        });
      }
    }
    if (!output.length) {
      // Empty upstream completion: fail explicitly instead of returning a 200
      // "completed" response with no items (silent stall for the client).
      logRequest({
        ts: new Date().toISOString(),
        kind: 'empty_upstream',
        requestId: chat.__gloryRequestId,
        status: 502,
        routedVia: json.__routedVia || null,
        contextReal: realTokens(chat),
        body: chat,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'empty_upstream_response',
            message:
              'El modelo no devolvió texto final ni llamadas a herramientas. Reduce el contexto o reintenta el mensaje.',
          },
        })
      );
      return;
    }
    logRequest({
      ts: new Date().toISOString(),
      kind: 'result',
      requestId: chat.__gloryRequestId,
      status: 200,
      routedVia: json.__routedVia || null,
      textLen: assistantText(message).length,
      toolCalls: toolCalls.length,
      toolNames: toolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: responseModel(chat),
        output,
        usage: responseUsage ? responseUsageFromChatUsage(responseUsage) : null,
        end_turn: !hasToolOutput,
      })
    );
  }

  return { nonStreamingChatToResponses };
}

module.exports = { crearNonStream };
