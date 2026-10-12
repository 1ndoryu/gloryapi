function crearResponsesRoute(ctx) {
  const { config, log, logging, upstream, logRequest, redactText, requestIdFor, attachRequestId, translateRequest, compactContext, streamChatToResponses, nonStreamingChatToResponses, upstreamAuthHeader, validateResponsesRequest, classifyRequest, writeLocalTitleResponse, clientAuthorized, getLifecycle, isJsonContentType, writeJsonError, readBody } = ctx;

  async function handlePost(req, res, url) {
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'invalid bridge authorization' } }));
        return true;
      }
      const lifecycle = getLifecycle();
      if (!lifecycle.acceptingRequests) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { code: 'bridge_lifecycle_not_ready' }, lifecycle }));
        return true;
      }
      if (!isJsonContentType(req)) {
        writeJsonError(res, 415, 'unsupported_media_type', 'Responses requests must use application/json');
        return true;
      }
      const authorization = upstreamAuthHeader();
      if (!authorization) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'bridge upstream authorization is not configured' } }));
        return true;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        const status = error && error.statusCode === 413 ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: redactText(error && error.message) } }));
        return true;
      }
      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'invalid JSON body' } }));
        return true;
      }
      const schemaResult = validateResponsesRequest(body, { maxItems: 512, maxTools: 128, maxContentParts: 256 });
      if (!schemaResult.ok) {
        // Structural diagnostic only: never log content values. Captures the
        // failing input item's type and content shape so a boundary rejection
        // (e.g. content: null echoed from a previous turn) is debuggable.
        try {
          const failingPath = schemaResult.errors[0] && schemaResult.errors[0].path;
          const indexMatch = failingPath && failingPath.match(/^\$\.input\[(\d+)\]/);
          const failingItem = indexMatch ? body.input[Number(indexMatch[1])] : null;
          const contentShape = failingItem && failingItem.content === undefined
            ? 'undefined'
            : failingItem && failingItem.content === null
              ? 'null'
              : failingItem && typeof failingItem.content === 'string'
                ? 'string'
                : failingItem && Array.isArray(failingItem.content)
                  ? 'array'
                  : failingItem
                    ? typeof failingItem.content
                    : 'no-item';
          logRequest({
            ts: new Date().toISOString(),
            kind: 'schema_rejected',
            path: failingPath || '',
            code: schemaResult.errors[0] && schemaResult.errors[0].code,
            itemType: failingItem ? failingItem.type || '(missing)' : '(none)',
            itemRole: failingItem ? failingItem.role || '(none)' : '(none)',
            contentShape,
          });
        } catch {}
        writeJsonError(res, 400, 'invalid_request', `invalid Responses request (${schemaResult.errors[0].path}: ${schemaResult.errors[0].code})`);
        return true;
      }

      const requestId = requestIdFor(req);
      res.setHeader(logging.requestIdHeader, requestId);
      const classification = typeof classifyRequest === 'function'
        ? classifyRequest(body)
        : { kind: 'main', reason: 'classifier_unavailable', fingerprint: null };
      if (classification.kind === 'auxiliary_title' && typeof writeLocalTitleResponse === 'function') {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'local_auxiliary_title',
          requestId,
          requestKind: classification.kind,
          classificationReason: classification.reason,
          fingerprint: classification.fingerprint,
          stream: body.stream !== false,
        });
        writeLocalTitleResponse(res, body, requestId, classification.fingerprint);
        return true;
      }
      const { chat, toolMap, customTools } = await translateRequest(body);
      if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
        writeJsonError(res, 400, 'invalid_request', 'Responses input must contain at least one supported message item');
        return true;
      }
      attachRequestId(chat, requestId);
      Object.defineProperty(chat, '__requestKind', {
        value: classification.kind || 'main',
        enumerable: false,
      });
      Object.defineProperty(chat, '__classificationReason', {
        value: classification.reason || 'default',
        enumerable: false,
      });
      const canaryProvider = req.headers['x-glory-canary-provider'];
      if (config.canary.enabled && typeof canaryProvider === 'string' && /^[a-z0-9][a-z0-9-]{1,31}$/i.test(canaryProvider)) {
        Object.defineProperty(chat, '__canaryProvider', {
          value: canaryProvider.toLowerCase(),
          enumerable: false,
        });
      }
      await compactContext(chat, authorization);
      if (upstream.debug) {
        log(`chat request metadata model=${chat.model} stream=${!!body.stream} messages=${chat.messages.length} tools=${Array.isArray(chat.tools) ? chat.tools.length : 0}`);
      }
      logRequest({
        ts: new Date().toISOString(),
        kind: 'request',
        requestId,
        stream: !!body.stream,
        model: chat.model,
        requestKind: classification.kind || 'main',
        classificationReason: classification.reason || 'default',
        fingerprint: classification.fingerprint || null,
        nMessages: chat.messages.length,
        roles: chat.messages.map((message) => message.role),
        body: chat,
      });
      if (body.stream === false) await nonStreamingChatToResponses(req, res, chat, toolMap, customTools);
      else await streamChatToResponses(req, res, chat, toolMap, customTools);
      return true;
    }

    return false;
  }

  return { handlePost };
}

module.exports = { crearResponsesRoute };
