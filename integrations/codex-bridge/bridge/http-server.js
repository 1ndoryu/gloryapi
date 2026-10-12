const http = require('node:http');
const { BRIDGE_CONTEXT_WINDOW } = require('./model-catalog');
const { crearHttpState } = require('./http-state');
const { crearHttpRequest } = require('./http-request');
const { crearGetRoutes } = require('./http-get-routes');
const { crearResponsesRoute } = require('./http-responses-route');

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
  classifyRequest,
  writeLocalTitleResponse,
}) {
  const { identity, contract, upstream, limits, logging, vision, auth } = config;
  const visionRoutes = [vision, ...(Array.isArray(vision.fallbacks) ? vision.fallbacks : [])];
  const visionConfigured = !vision.disabled && visionRoutes.some((route) =>
    route && (String(route.apiKey || '').length > 0 || route.allowAnonymous === true));

  const ctx = {
    config, state, log, logRequest, redactText, requestIdFor, attachRequestId, translateRequest,
    compactContext, streamChatToResponses, nonStreamingChatToResponses, assertSafeLoopbackUpstream,
    upstreamAuthHeader, validateResponsesRequest, metrics, classifyRequest, writeLocalTitleResponse,
    identity, contract, upstream, limits, logging, auth, visionConfigured, BRIDGE_CONTEXT_WINDOW,
  };
  const httpState = crearHttpState(ctx);
  const httpRequest = crearHttpRequest(ctx);
  const routeCtx = { ...ctx, ...httpState, ...httpRequest };
  const { handleGet } = crearGetRoutes(routeCtx);
  const { handlePost } = crearResponsesRoute(routeCtx);
  const { readinessChecks, getReadiness, getLifecycle, getCapabilityMatrix } = httpState;
  const { writeJsonError } = httpRequest;

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
    if (handleGet(req, res, url)) return;
    if (await handlePost(req, res, url)) return;

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
      log(`vision routes=${visionRoutes.length} primaryAuth=${vision.apiKey ? 'present' : 'absent'} fallbackAuth=${visionRoutes.slice(1).filter(route => route && route.apiKey).length}`);
      if (config.context.disabled) log('compaction: DISABLED (native Codex owns context continuity)');
    });
  }

  return { server, start, requestShutdown, readinessChecks, getReadiness, getLifecycle, getCapabilityMatrix };
}

module.exports = { createBridgeHttpServer };
