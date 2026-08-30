const { readResponseTextLimited } = require('./response-body');

function createResponseHandlers({
  config,
  rand,
  logRequest,
  redactText,
  upstreamAuthHeader,
  sseParserError,
  SseStreamParser,
  runInternalWebToolLoop,
  hasWebTool,
  fetchUpstreamStream,
  fetchWithTimeoutRecovery,
  recoverEmptyCompletion,
  responseHelpers,
  context,
  rememberReasoning,
}) {
  const MODEL = config.upstream.model;
  const UPSTREAM_MAX_RESPONSE_BYTES = config.upstream.maxResponseBytes;
  const NUDGE_RETRIES = config.recovery.nudgeRetries;
  const { sseEvent, assistantMessageFrom, assistantText, assistantReasoning, assistantToolCalls, hasVisibleAssistantAction,
    responseItemsForToolCalls, responseUsageFromChatUsage, emitResponseCompleted, createReasoningForwarder } = responseHelpers;
  const {
    visibleReasoning, realTokens, totalTokens, calibrate, nudgeForToolCalls, auditThenNudge,
    isFutureIntentNarration, isConfirmationText, currentTurnHasToolMessages,
    shouldAuditCompletion,
  } = context;
  const SseParserError = sseParserError;

  function responseModel(chat) {
    return chat.__bridgePresentationModel || chat.model || MODEL;
  }

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

// Response handlers

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

async function streamChatToResponses(req, res, chat, toolMap, customTools) {
  if (hasWebTool(toolMap)) {
    await streamInternalWebLoopToResponses(req, res, chat, toolMap, customTools);
    return;
  }
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

  const controller = new AbortController();
  const abortUpstream = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('aborted', abortUpstream);
  res.on('close', abortUpstream);

  let streamTransport;
  try {
    streamTransport = await fetchUpstreamStream(chat, upstreamAuthHeader(), controller.signal);
  } catch (err) {
    logRequest({ ts: new Date().toISOString(), kind: 'result', requestId: chat.__gloryRequestId, status: 0, error: String(err && err.message), body: chat });
    sseEvent(res, 'response.failed', {
      type: 'response.failed',
      response: { id: responseId, error: { type: 'upstream_error', message: redactText(err && err.message) } },
    });
    res.end();
    return;
  }

  const upstreamRes = streamTransport.response;

  if (!upstreamRes.ok) {
    let errText = '';
    try {
      errText = redactText((await readResponseTextLimited(upstreamRes, UPSTREAM_MAX_RESPONSE_BYTES, 'upstream error')).slice(0, 1000));
    } catch {}
    logRequest({
      ts: new Date().toISOString(),
      kind: 'upstream_error',
      requestId: chat.__gloryRequestId,
      status: upstreamRes.status,
      routedVia: upstreamRes.headers.get('x-routed-via') || null,
      error: errText,
      body: chat,
    });
    sseEvent(res, 'response.failed', {
      type: 'response.failed',
      response: {
        id: responseId,
        error: { type: 'upstream_http', message: `upstream ${upstreamRes.status}: ${errText}` },
      },
    });
    streamTransport.cleanup();
    res.end();
    return;
  }

  const ctype = upstreamRes.headers.get('content-type') || '';
  const routedVia = upstreamRes.headers.get('x-routed-via') || null;
  if (!ctype.includes('text/event-stream')) {
    // Non-streaming upstream response (shouldn't happen; we always request stream)
    let raw = '';
    try {
      raw = redactText((await readResponseTextLimited(upstreamRes, UPSTREAM_MAX_RESPONSE_BYTES, 'upstream response')).slice(0, 500));
    } catch {}
    sseEvent(res, 'response.failed', {
      type: 'response.failed',
      response: { id: responseId, error: { type: 'bad_upstream', message: `expected SSE, got ${ctype}: ${raw.slice(0, 500)}` } },
    });
    streamTransport.cleanup();
    res.end();
    return;
  }

  let text = '';
  let reasoningText = '';
  let usage = null;
  let msgAdded = false;
  let bufferedMessageText = '';
  const toolCalls = new Map(); // index -> { id, name, args }
  let messageOutputIndex = null;
  const getMessageOutputIndex = () => {
    if (messageOutputIndex === null) messageOutputIndex = reasoningForwarder.hasEmitted() ? 1 : 0;
    return messageOutputIndex;
  };
  const getReasoningOutputIndex = () => messageOutputIndex === null ? 0 : 1;
  const reasoningForwarder = createReasoningForwarder(res, reasoningId, getReasoningOutputIndex);
  const emitMessageDelta = (contentDelta) => {
    if (!contentDelta) return;
    // Keep the message item after the reasoning item. When CommandCode sends
    // content before its reasoning stream, the delta is held until the
    // reasoning item has been opened; otherwise the desktop client ignores the
    // later reasoning summary as an out-of-order output item.
    if (!msgAdded) {
      msgAdded = true;
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: getMessageOutputIndex(),
        item: {
          type: 'message',
          role: 'assistant',
          id: msgId,
          content: [{ type: 'output_text', text: '' }],
        },
      });
    }
    sseEvent(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: getMessageOutputIndex(),
      content_index: 0,
      delta: contentDelta,
    });
  };
  const flushBufferedMessage = () => {
    if (bufferedMessageText) {
      emitMessageDelta(bufferedMessageText);
      bufferedMessageText = '';
    }
  };
  let nextToolIndex = 0;

  const reader = upstreamRes.body.getReader();
  const sseParser = new SseStreamParser();
  let sawDone = false;

  const handleChunk = (raw) => {
    const lines = raw.split(/\r?\n/);
    const dataLines = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    if (payload.trim() === '[DONE]') {
      if (sawDone) throw new Error('upstream sent duplicate [DONE]');
      sawDone = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error('upstream returned invalid SSE JSON');
    }

    const choice = (json.choices && json.choices[0]) || {};
    const delta = choice.delta || {};

    const reasoningDelta = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
    if (reasoningDelta) {
      reasoningText += reasoningDelta;
      reasoningForwarder.add(reasoningDelta);
    }
    const message = choice.message || {};
    const messageReasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : '';
    if (!reasoningDelta && messageReasoning) {
      reasoningText += messageReasoning;
      reasoningForwarder.add(messageReasoning);
    }
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      bufferedMessageText += delta.content;
    }
    const incomingToolCalls = Array.isArray(delta.tool_calls)
      ? delta.tool_calls
      : Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
    for (const tc of incomingToolCalls) {
      let key = Number.isInteger(tc.index) ? tc.index : null;
      let acc = key == null ? null : toolCalls.get(key);
      if (!acc && tc.id) {
        for (const candidate of toolCalls.values()) {
          if (candidate.id === tc.id) {
            key = candidate.key;
            acc = candidate;
            break;
          }
        }
      }
      if (!acc) {
        key = key == null ? `call_${nextToolIndex++}` : key;
        acc = { key, id: tc.id || rand('call'), name: '', args: '' };
        toolCalls.set(key, acc);
      }
      if (tc.function && tc.function.name) acc.name = tc.function.name;
      if (tc.function && tc.function.arguments) acc.args += tc.function.arguments;
    }
    if (json.usage) usage = json.usage;
  };

  let streamFailure = null;
  try {
    for (;;) {
      const { done, value } = await streamTransport.read(reader);
      if (done) break;
      for (const payload of sseParser.push(value)) handleChunk(`data: ${payload}`);
    }
    for (const payload of sseParser.finish()) handleChunk(`data: ${payload}`);
    if (!sawDone) throw new Error('upstream stream ended without [DONE]');
  } catch (err) {
    streamFailure = err;
  }
  streamTransport.cleanup();

  if (streamFailure) {
    const safeMessage = streamFailure instanceof SseParserError
      ? `invalid upstream SSE (${streamFailure.code})`
      : redactText(streamFailure && streamFailure.message);
    logRequest({ ts: new Date().toISOString(), kind: 'stream_error', requestId: chat.__gloryRequestId, status: 502, routedVia, error: safeMessage });
    // A disconnected client cannot receive a terminal event. The abort still
    // propagates to fetch, and importantly no response.completed is emitted.
    if (controller.signal.aborted || res.destroyed) return;
    // The client used to receive the text deltas live; flush what the upstream
    // managed to produce before the terminal error so the partial answer is not lost.
    flushBufferedMessage();
    sseEvent(res, 'response.failed', {
      type: 'response.failed',
      response: { id: responseId, error: { type: 'upstream_stream_error', message: safeMessage } },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  let forwardedReasoning = false;

  // Reasoning-only output is still incomplete. A tool-only output is valid and
  // continues below as a function_call; it must not be mistaken for an empty
  // response or closed with end_turn=true.
  if (!text && toolCalls.size === 0) {
    const recovered = await recoverEmptyCompletion(chat, upstreamAuthHeader(), 'stream');
    if (recovered) {
      const recoveredMessage = assistantMessageFrom(recovered.json);
      chat.messages = recovered.chat.messages;
      text = assistantText(recoveredMessage);
      const recoveredReasoning = visibleReasoning(assistantReasoning(recoveredMessage));
      if (recoveredReasoning) {
        reasoningText = reasoningText ? `${reasoningText}\n${recoveredReasoning}` : recoveredReasoning;
        reasoningForwarder.add(recoveredReasoning);
      }
      usage = recovered.json.usage || usage;
      for (const tc of assistantToolCalls(recoveredMessage)) {
        const key = Number.isInteger(tc.index) ? tc.index : `recovery_${nextToolIndex++}`;
        toolCalls.set(key, {
          key,
          id: tc.id || rand('call'),
          name: (tc.function && tc.function.name) || '',
          args: (tc.function && tc.function.arguments) || '',
        });
      }
      if (text) bufferedMessageText = text;
    }
  }
  if (!text && toolCalls.size === 0) {
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
    text &&
    shouldAuditCompletion(chat, text)
  ) {
    const nudge = await runNudgeWithKeepAlive(res, chat, text);
    const failure = nudgeFailure(nudge, text);
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
        textLen: text.length,
        toolCalls: nudge.toolCalls.length,
        toolNames: nudge.toolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
        intent: isFutureIntentNarration(text),
        latencyMs: nudge.latencyMs,
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
      });
    }
  }

  // A nudge can contain internal reasoning, but only append it before the
  // message receives an output index; otherwise it would collide with an
  // already-open message item in the Responses stream.
  // Nudge reasoning is useful when no message item has been opened yet. Once
  // text has been streamed, adding a second reasoning delta after the message
  // would violate the Responses output order, so it remains internal.
  if (nudgeReasoning && !msgAdded) reasoningForwarder.add(nudgeReasoning);
  forwardedReasoning = reasoningForwarder.finish();
  flushBufferedMessage();

  // Final message item (accumulated text)
  if (text) {
    sseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: getMessageOutputIndex(),
      item: {
        type: 'message',
        role: 'assistant',
        id: msgId,
        content: [{ type: 'output_text', text }],
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
  const itemReasoning = visibleReasoning(reasoningText) || visibleReasoning(nudgeReasoning);
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
  calibrate(totalTokens(chat), usage ? usage.prompt_tokens || 0 : 0);
  emitResponseCompleted(
    res,
    responseId,
    usage,
    upstreamToolCalls.length > 0,
    routedVia,
    chat.__gloryRequestId,
    text.length,
    upstreamToolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------------------
// Non-streaming path (Codex always streams, kept for robustness)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

  return { streamChatToResponses, nonStreamingChatToResponses };
}

module.exports = { createResponseHandlers };
