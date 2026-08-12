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
  const { sseEvent, assistantMessageFrom, assistantText, assistantToolCalls, hasVisibleAssistantAction,
    responseItemsForToolCalls, responseUsageFromChatUsage, emitResponseCompleted, createReasoningForwarder } = responseHelpers;
  const {
    visibleReasoning, realTokens, totalTokens, calibrate, nudgeForToolCalls,
    isFutureIntentNarration, isConfirmationText, currentTurnHasToolMessages,
  } = context;
  const SseParserError = sseParserError;

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
    response: { id: responseId, status: 'in_progress', model: MODEL },
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
  const reasoningText = visibleReasoning(message.reasoning_content || '');
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
  if (reasoningText) {
    sseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      item: { type: 'reasoning', id: reasoningId, summary: [{ type: 'summary_text', text: '' }] },
    });
    sseEvent(res, 'response.reasoning_text.delta', {
      type: 'response.reasoning_text.delta', item_id: reasoningId, content_index: 0, delta: reasoningText,
    });
  }
  if (text) {
    sseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      item: { type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text: '' }] },
    });
    sseEvent(res, 'response.output_text.delta', {
      type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: text,
    });
    sseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text }] },
    });
  }

  const renderedTools = responseItemsForToolCalls(toolCalls, toolMap, customTools);
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
    toolCalls.length > 0,
    resolved.json.__routedVia || null,
    chat.__gloryRequestId,
    text.length,
    toolCalls.map((tc) => tc.function && tc.function.name).filter(Boolean),
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
    response: { id: responseId, status: 'in_progress', model: MODEL },
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
  const toolCalls = new Map(); // index -> { id, name, args }
  const reasoningForwarder = createReasoningForwarder(res, reasoningId);
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

    if (delta.reasoning_content) {
      reasoningText += delta.reasoning_content;
      reasoningForwarder.add(delta.reasoning_content);
    }
    const message = choice.message || {};
    if (!delta.reasoning_content && message.reasoning_content) {
      reasoningText += message.reasoning_content;
      reasoningForwarder.add(message.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      // Codex requires response.output_item.added (message) BEFORE text deltas,
      // otherwise it logs "OutputTextDelta without active item".
      if (!msgAdded) {
        msgAdded = true;
        sseEvent(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          item: {
            type: 'message',
            role: 'assistant',
            id: msgId,
            content: [{ type: 'output_text', text: '' }],
          },
        });
      }
      text += delta.content;
      sseEvent(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        delta: delta.content,
      });
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
    sseEvent(res, 'response.failed', {
      type: 'response.failed',
      response: { id: responseId, error: { type: 'upstream_stream_error', message: safeMessage } },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const forwardedReasoning = reasoningForwarder.finish();

  // Reasoning-only output is still incomplete. A tool-only output is valid and
  // continues below as a function_call; it must not be mistaken for an empty
  // response or closed with end_turn=true.
  if (!text && toolCalls.size === 0) {
    const recovered = await recoverEmptyCompletion(chat, upstreamAuthHeader(), 'stream');
    if (recovered) {
      const recoveredMessage = assistantMessageFrom(recovered.json);
      chat.messages = recovered.chat.messages;
      text = assistantText(recoveredMessage);
      reasoningText = visibleReasoning(recoveredMessage.reasoning_content || '');
      usage = recovered.json.usage || usage;
      if (reasoningText) {
        reasoningForwarder.add(reasoningText);
        reasoningForwarder.finish();
      }
      for (const tc of assistantToolCalls(recoveredMessage)) {
        const key = Number.isInteger(tc.index) ? tc.index : `recovery_${nextToolIndex++}`;
        toolCalls.set(key, {
          key,
          id: tc.id || rand('call'),
          name: (tc.function && tc.function.name) || '',
          args: (tc.function && tc.function.arguments) || '',
        });
      }
      if (text && !msgAdded) {
        msgAdded = true;
        sseEvent(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          item: { type: 'message', role: 'assistant', id: msgId, content: [{ type: 'output_text', text: '' }] },
        });
        sseEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      }
    }
  }

  if (!text && toolCalls.size === 0) {
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

  // Anti falso-complete (capa B, 2026-08-10; hook universal 2026-08-11): si el
  // modelo cierra con texto sin tool_calls teniendo tools disponibles, le
  // preguntamos (UN request de confirmación) si realmente terminó: "ok" confirma
  // el cierre; cualquier otra cosa le pide ejecutar la acción pendiente. Cubre
  // cualquier redacción (ES/EN, "Sigo...", "I will...") sin depender de una
  // heurística. El texto original ya se emitió como deltas (no hay vuelta atrás);
  // las tool_calls del retry se incorporan al Map y las emite el loop de abajo.
  // Si el retry confirma "ok" o vuelve sin tools, se descarta y se cierra con la
  // respuesta original.
  // El guard usa el turno actual: si ya ejecutó tools y produjo un resumen
  // normal, no interrumpimos. Si después de una tool-call todavía narra una
  // acción futura ("Necesito inspeccionar...", "Voy a revisar..."), sí hacemos
  // un único nudge: ese es el falso complete observado en hilos reales.
  let nudgeReasoning = '';
  if (
    toolCalls.size === 0 &&
    text &&
    chat.__userTools === true &&
    Array.isArray(chat.tools) &&
    chat.tools.length &&
    (!currentTurnHasToolMessages(chat.messages) || isFutureIntentNarration(text)) &&
    NUDGE_RETRIES > 0
  ) {
    const nudge = await nudgeForToolCalls(chat, upstreamAuthHeader(), text);
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
      });
    }
  }

  // Final message item (accumulated text)
  if (text) {
    sseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
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
  const reasoningText = visibleReasoning(message.reasoning_content || '');
  const toolCalls = assistantToolCalls(message);
  let hasToolOutput = toolCalls.length > 0;
  const output = [];
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
  // Anti falso-complete (capa B, 2026-08-10; hook universal 2026-08-11): misma
  // lógica que en el path streaming — toda respuesta final sin tool_calls recibe
  // el request de confirmación; las tool_calls del retry se añaden al output
  // final, y "ok" confirma el cierre con el texto original.
  if (
    toolCalls.length === 0 &&
    assistantText(message) &&
    gateChat.__userTools === true &&
    Array.isArray(gateChat.tools) &&
    gateChat.tools.length &&
    (!currentTurnHasToolMessages(gateChat.messages) || isFutureIntentNarration(assistantText(message))) &&
    NUDGE_RETRIES > 0
  ) {
    const nudge = await nudgeForToolCalls(chat, upstreamAuthHeader(), assistantText(message));
    if (nudge && nudge.toolCalls.length) {
      const nudgeReasoning = nudge.reasoning || '';
      for (const tc of nudge.toolCalls) {
        if (nudgeReasoning) rememberReasoning(tc.id, nudgeReasoning);
      }
      const nudgeItems = responseItemsForToolCalls(nudge.toolCalls, toolMap, customTools);
      if (!nudgeItems.error) {
        output.push(...nudgeItems.items);
        hasToolOutput = hasToolOutput || nudgeItems.items.length > 0;
      }
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
      model: MODEL,
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
