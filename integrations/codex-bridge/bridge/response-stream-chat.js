const { readResponseTextLimited } = require('./response-body');
const { crearAcumulador } = require('./response-stream-chat-acumulador');
const { crearCierre } = require('./response-stream-chat-cierre');

function crearStreamChat(ctx) {
  const {
    rand, logRequest, redactText, upstreamAuthHeader, fetchUpstreamStream, hasWebTool, responseModel,
    streamInternalWebLoopToResponses, SseStreamParser, SseParserError, UPSTREAM_MAX_RESPONSE_BYTES,
    createReasoningForwarder, sseEvent, recoverEmptyCompletion, rememberReasoning, assistantMessageFrom,
    assistantText, assistantReasoning, assistantToolCalls, responseItemsForToolCalls, emitResponseCompleted,
    visibleReasoning, realTokens, totalTokens, calibrate, isFutureIntentNarration, isConfirmationText,
    shouldAuditCompletion, runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure,
  } = ctx;

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

    const estado = {
      text: '', reasoningText: '', usage: null, msgAdded: false, bufferedMessageText: '',
      messageOutputIndex: null, nextToolIndex: 0, sawDone: false,
    };
    const {
      handleChunk, flushBufferedMessage, getMessageOutputIndex, reasoningForwarder, toolCalls,
    } = crearAcumulador({
      sseEvent, createReasoningForwarder, rand, res, msgId, reasoningId, estado,
    });

    const reader = upstreamRes.body.getReader();
    const sseParser = new SseStreamParser();

    let streamFailure = null;
    try {
      for (;;) {
        const { done, value } = await streamTransport.read(reader);
        if (done) break;
        for (const payload of sseParser.push(value)) handleChunk(`data: ${payload}`);
      }
      for (const payload of sseParser.finish()) handleChunk(`data: ${payload}`);
      if (!estado.sawDone) throw new Error('upstream stream ended without [DONE]');
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

    const { cerrar } = crearCierre({
      rand, logRequest, upstreamAuthHeader, recoverEmptyCompletion, rememberReasoning, sseEvent,
      assistantMessageFrom, assistantText, assistantReasoning, assistantToolCalls, responseItemsForToolCalls,
      emitResponseCompleted, visibleReasoning, realTokens, totalTokens, calibrate, isFutureIntentNarration,
      isConfirmationText, shouldAuditCompletion, runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure,
      res, chat, toolMap, customTools, responseId, msgId, routedVia, flushBufferedMessage,
      getMessageOutputIndex, reasoningForwarder, toolCalls, estado,
    });
    return cerrar();
  }

  return { streamChatToResponses };
}

module.exports = { crearStreamChat };
