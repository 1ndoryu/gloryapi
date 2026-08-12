const http = require('node:http');
const crypto = require('node:crypto');

function createBridgeHttpServer({
  config,
  state,
  log,
  logRequest,
  redactText,
  requestIdFor,
  attachRequestId,
  translateRequest,
  compactContext,
  streamChatToResponses,
  nonStreamingChatToResponses,
  assertSafeLoopbackUpstream,
  upstreamAuthHeader,
  validateResponsesRequest,
  metrics,
}) {
  const { identity, contract, upstream, limits, logging, vision, auth } = config;
  const lifecycleStates = ['starting', 'ready', 'blocked', 'draining', 'stopped'];
  const visionConfigured = !vision.disabled && (vision.apiKey.length > 0 || vision.allowAnonymous === true);

  function incomingBearer(req) {
    const value = req.headers.authorization;
    return typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : '';
  }

  function timingSafeTokenEqual(provided, expected) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || b.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function clientAuthorized(req) {
    // The sidecar token is intentionally separate from the bearer sent upstream.
    return timingSafeTokenEqual(incomingBearer(req), auth.clientToken);
  }

  function readinessChecks() {
    let upstreamLoopbackConfigured = false;
    try {
      assertSafeLoopbackUpstream(upstream.baseUrl);
      upstreamLoopbackConfigured = true;
    } catch {}
    return {
      clientAuthConfigured: auth.clientToken.length > 0,
      upstreamAuthConfigured: auth.upstreamToken.length > 0,
      contractCompatible: contract.actual === contract.expected,
      upstreamLoopbackConfigured,
    };
  }

  function getReadiness() {
    const checks = readinessChecks();
    return {
      ready: Object.values(checks).every(Boolean),
      checks,
      adapterVersion: identity.adapterVersion,
      fixtureSchema: identity.fixtureSchema,
      gloryApiContract: contract.actual,
    };
  }

  function getLifecycle() {
    if (state.shutdownRequested) state.lifecyclePhase = 'draining';
    else if (!state.lifecycleStartedAt) state.lifecyclePhase = 'starting';
    else state.lifecyclePhase = Object.values(readinessChecks()).every(Boolean) ? 'ready' : 'blocked';
    return {
      schema: identity.lifecycleSchema,
      state: state.lifecyclePhase,
      acceptingRequests: state.lifecyclePhase === 'ready',
      activeRequests: state.activeRequests,
      startedAt: state.lifecycleStartedAt,
      transitions: lifecycleStates,
      shutdown: 'graceful',
      recovery: 'restart_sidecar',
      metrics: metrics ? metrics.snapshot() : {},
    };
  }

  function getCapabilityMatrix() {
    const combinations = config.capabilities.matrix.length > 0
      ? config.capabilities.matrix
      : [{ client: 'codex-responses', adapter: 'responses-translation-v1', provider: identity.providerName, model: upstream.model }];
    return combinations.map((combination) => ({
      client: combination.client,
      adapter: combination.adapter,
      adapterVersion: identity.adapterVersion,
      provider: combination.provider,
      model: combination.model,
      evidence: ['glory-codex-responses-fixture-v1', 'bridge-http-contract', 'deterministic-canary-v1'],
      lifecycle: getLifecycle(),
      capabilities: {
        text: { status: 'supported' },
        streaming: { status: 'supported' },
        reasoning: { status: 'adapted' },
        functions: { status: 'adapted' },
        customTools: { status: 'adapted' },
        parallelTools: { status: 'adapted' },
        namespaces: { status: 'adapted' },
        deferredToolDiscovery: { status: 'adapted' },
        webSearch: { status: 'adapted' },
        vision: { status: visionConfigured ? 'unverified' : 'unsupported', reason: visionConfigured ? 'vision_health_probe_pending' : 'vision_not_configured' },
        cancellation: { status: 'supported' },
        contextCompaction: { status: 'unsupported', reason: 'native_codex_compaction_only' },
        codexDesktopE2E: { status: 'unverified', reason: 'desktop_fixture_pending' },
        providerInference: { status: 'unverified', reason: 'real_provider_fixture_pending' },
        toolOnlyTurns: { status: 'adapted', reason: 'deterministic_tool_loop_contract' },
        standaloneWebSearch: { status: 'unsupported', reason: 'not_advertised_by_client_contract' },
        mcp: { status: 'adapted', reason: 'namespace_translation_contract' },
        browser: { status: 'adapted', reason: 'local_tool_contract_only' },
        computerUse: { status: 'unsupported', reason: 'no_local_adapter' },
        automation: { status: 'adapted', reason: 'local_tool_contract_only' },
        multiAgent: { status: 'adapted', reason: 'namespace_translation_contract' },
        longContext: { status: 'unverified', reason: 'desktop_soak_pending' },
      },
    }));
  }

  function readBody(req, maxBytes = limits.maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          settled = true;
          const error = new Error(`request body exceeds ${maxBytes} bytes`);
          error.statusCode = 413;
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  function isJsonContentType(req) {
    const value = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    return value === 'application/json' || value.endsWith('+json');
  }

  function writeJsonError(res, statusCode, code, message, headers = {}) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ type: 'error', error: { code, message } }));
  }

  async function handleRequest(req, res) {
    if (state.activeRequests >= limits.maxActiveRequests) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ type: 'error', error: { code: 'bridge_busy', message: 'bridge is at its active request limit' } }));
      return;
    }
    state.activeRequests += 1;
    const requestStartedAt = performance.now();
    let requestReleased = false;
    const releaseRequest = () => {
      if (requestReleased) return;
      requestReleased = true;
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      metrics?.observe('http.request_ms', performance.now() - requestStartedAt);
    };
    res.once('finish', releaseRequest);
    res.once('close', releaseRequest);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (Buffer.byteLength(url.pathname, 'utf8') > limits.maxPathBytes) {
      writeJsonError(res, 414, 'path_too_long', 'request path exceeds bridge limit');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: identity.bridgeId, version: identity.bridgeVersion, model: upstream.model }));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/ready' || url.pathname === '/readiness')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, ready: false, error: { code: 'invalid_bridge_authorization' } }));
        return;
      }
      const readiness = getReadiness();
      res.writeHead(readiness.ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: readiness.ready, service: identity.bridgeId, model: upstream.model, ...readiness }));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/lifecycle' || url.pathname === '/v1/lifecycle')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_bridge_authorization' } }));
        return;
      }
      const lifecycle = getLifecycle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: lifecycle.state === 'ready', service: identity.bridgeId, ...lifecycle }));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/diagnostics' || url.pathname === '/v1/diagnostics')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_bridge_authorization' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        schema: 'glory-bridge-diagnostics-v1',
        service: identity.bridgeId,
        adapterVersion: identity.adapterVersion,
        lifecycle: getLifecycle(),
        metrics: metrics ? metrics.snapshot() : {},
      }));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/capabilities' || url.pathname === '/v1/capabilities')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_bridge_authorization' } }));
        return;
      }
      const readiness = getReadiness();
      if (!readiness.ready) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'bridge_not_ready' }, readiness }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        schema: identity.capabilitiesSchema,
        service: identity.bridgeId,
        adapterVersion: identity.adapterVersion,
        fixtureSchema: identity.fixtureSchema,
        requestSchema: identity.requestSchema,
        gloryApiContract: contract.actual,
        model: upstream.model,
        lifecycle: getLifecycle(),
        matrix: getCapabilityMatrix(),
        capabilities: {
          text: true,
          streaming: true,
          reasoning: true,
          functions: true,
          customTools: true,
          parallelTools: true,
          namespaces: true,
          deferredToolDiscovery: true,
          webSearch: true,
          vision: false,
          visionConfigured,
          internalWebLoop: true,
          standaloneWebSearch: false,
          cancellation: true,
          contextCompaction: false,
        },
        limitations: ['vision_requires_explicit_config_and_health_probe', 'vision_is_lossy_text_adaptation', 'standalone_web_search_not_advertised', 'codex_desktop_e2e_pending'],
      }));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const modelList = [{
        id: upstream.model,
        slug: upstream.model,
        object: 'model',
        created: 0,
        owned_by: identity.providerName,
        input_modalities: visionConfigured ? ['text'] : ['text'],
        context_window: config.context.limitTokens,
        max_context_window: config.context.limitTokens,
        effective_context_window_percent: 100,
        auto_compact_token_limit: config.context.limitTokens,
      }, { id: 'auto', slug: 'auto', object: 'model', created: 0, owned_by: identity.providerName }];
      res.end(JSON.stringify({ object: 'list', data: modelList, models: modelList }));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'invalid bridge authorization' } }));
        return;
      }
      const lifecycle = getLifecycle();
      if (!lifecycle.acceptingRequests) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { code: 'bridge_lifecycle_not_ready' }, lifecycle }));
        return;
      }
      if (!isJsonContentType(req)) {
        writeJsonError(res, 415, 'unsupported_media_type', 'Responses requests must use application/json');
        return;
      }
      const authorization = upstreamAuthHeader();
      if (!authorization) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'bridge upstream authorization is not configured' } }));
        return;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        const status = error && error.statusCode === 413 ? 413 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: redactText(error && error.message) } }));
        return;
      }
      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'invalid JSON body' } }));
        return;
      }
      const schemaResult = validateResponsesRequest(body, { maxItems: 512, maxTools: 128, maxContentParts: 256 });
      if (!schemaResult.ok) {
        writeJsonError(res, 400, 'invalid_request', `invalid Responses request (${schemaResult.errors[0].path}: ${schemaResult.errors[0].code})`);
        return;
      }

      const requestId = requestIdFor(req);
      res.setHeader(logging.requestIdHeader, requestId);
      const { chat, toolMap, customTools } = await translateRequest(body);
      if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
        writeJsonError(res, 400, 'invalid_request', 'Responses input must contain at least one supported message item');
        return;
      }
      attachRequestId(chat, requestId);
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
        nMessages: chat.messages.length,
        roles: chat.messages.map((message) => message.role),
        body: chat,
      });
      if (body.stream === false) await nonStreamingChatToResponses(req, res, chat, toolMap, customTools);
      else await streamChatToResponses(req, res, chat, toolMap, customTools);
      return;
    }

    const knownPath = new Set([
      '/health', '/ready', '/readiness', '/lifecycle', '/v1/lifecycle',
      '/diagnostics', '/v1/diagnostics',
      '/capabilities', '/v1/capabilities', '/v1/models', '/models',
      '/v1/responses', '/responses',
    ]).has(url.pathname);
    if (knownPath) {
      writeJsonError(res, 405, 'method_not_allowed', `method ${req.method} is not allowed for ${url.pathname}`, {
        Allow: url.pathname === '/health' || url.pathname === '/v1/models' || url.pathname === '/models' ? 'GET, OPTIONS' : 'GET, POST, OPTIONS',
      });
      return;
    }
    writeJsonError(res, 404, 'not_found', `not found: ${req.method} ${url.pathname}`);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logRequest({
        ts: new Date().toISOString(),
        kind: 'http_error_boundary',
        requestId: requestIdFor(req),
        status: 500,
        error: error && error.message,
      });
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      writeJsonError(res, 500, 'bridge_internal_error', 'bridge failed before producing a response');
    });
  });

  function requestShutdown(signal) {
    if (state.shutdownRequested) return;
    state.shutdownRequested = true;
    state.lifecyclePhase = 'draining';
    log(`bridge ${signal}: draining ${state.activeRequests} active request(s)`);
    server.close(() => {
      state.lifecyclePhase = 'stopped';
      process.exit(0);
    });
    const forceClose = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      state.lifecyclePhase = 'stopped';
      process.exit(0);
    }, 5000);
    forceClose.unref();
  }

  function start() {
    server.listen(upstream.port, upstream.host, () => {
      state.lifecycleStartedAt = new Date().toISOString();
      state.lifecyclePhase = Object.values(readinessChecks()).every(Boolean) ? 'ready' : 'blocked';
      log(`bridge listening on http://${upstream.host}:${upstream.port} -> ${upstream.baseUrl} (model=${upstream.model}, lifecycle=${state.lifecyclePhase})`);
      if (config.context.disabled) log('compaction: DISABLED (native Codex owns context continuity)');
    });
  }

  return { server, start, requestShutdown, readinessChecks, getReadiness, getLifecycle, getCapabilityMatrix };
}

module.exports = { createBridgeHttpServer };
