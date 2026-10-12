function crearGetRoutes(ctx) {
  const { config, metrics, identity, upstream, contract, visionConfigured, BRIDGE_CONTEXT_WINDOW, clientAuthorized, getReadiness, getLifecycle, getCapabilityMatrix } = ctx;

  function handleGet(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: identity.bridgeId, version: identity.bridgeVersion, model: upstream.model, catalog: { state: config.catalog.state, revision: config.catalog.revision, hash: config.catalog.hash, entries: config.catalog.entries.length } }));
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/ready' || url.pathname === '/readiness')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, ready: false, error: { code: 'invalid_bridge_authorization' } }));
        return true;
      }
      const readiness = getReadiness();
      res.writeHead(readiness.ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: readiness.ready, service: identity.bridgeId, model: upstream.model, catalog: { state: config.catalog.state, revision: config.catalog.revision, hash: config.catalog.hash, entries: config.catalog.entries.length }, ...readiness }));
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/lifecycle' || url.pathname === '/v1/lifecycle')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_bridge_authorization' } }));
        return true;
      }
      const lifecycle = getLifecycle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: lifecycle.state === 'ready', service: identity.bridgeId, ...lifecycle }));
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/diagnostics' || url.pathname === '/v1/diagnostics')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_bridge_authorization' } }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        schema: 'glory-bridge-diagnostics-v1',
        service: identity.bridgeId,
        adapterVersion: identity.adapterVersion,
        lifecycle: getLifecycle(),
        catalog: { state: config.catalog.state, revision: config.catalog.revision, hash: config.catalog.hash, entries: config.catalog.entries.length },
        metrics: metrics ? metrics.snapshot() : {},
      }));
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/capabilities' || url.pathname === '/v1/capabilities')) {
      if (!clientAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_bridge_authorization' } }));
        return true;
      }
      const readiness = getReadiness();
      if (!readiness.ready) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'bridge_not_ready' }, readiness }));
        return true;
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
          imageInput: true,
          vision: visionConfigured,
          nativeVision: visionConfigured,
          visionConfigured,
          internalWebLoop: true,
          standaloneWebSearch: false,
          cancellation: true,
          contextCompaction: false,
        },
        limitations: [
          'vision_requires_explicit_config_and_health_probe',
          'native_image_forwarding_only_for_multimodal_catalog_models',
          'lossy_text_adaptation_used_for_non_vision_models',
          'standalone_web_search_not_advertised',
          'codex_desktop_e2e_pending',
        ],
      }));
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Selector de modelos: la lista sale del catálogo versionado
      // (config.catalog.entries), no de un condicional en el servidor. Cada
      // entrada declara su id wire y si el bridge acepta imágenes para el cliente.
      // `nativeVision` solo describe el transporte directo al upstream; los
      // modelos de texto también usan la adaptación Mimo del bridge.
      const catalogEntries = Array.isArray(config.catalog.entries) ? config.catalog.entries : [];
      const modelList = catalogEntries.map((entry) => {
        const contextWindow = Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0
          ? Math.min(entry.contextWindow, config.context.limitTokens, BRIDGE_CONTEXT_WINDOW)
          : Math.min(config.context.limitTokens, BRIDGE_CONTEXT_WINDOW);
        return {
          id: entry.id,
          slug: entry.id,
          object: 'model',
          created: 0,
          owned_by: entry.provider === 'auto' ? identity.providerName : entry.provider,
          name: entry.displayName || entry.id,
          input_modalities: entry.acceptsImageInput !== false ? ['text', 'image'] : ['text'],
          context_window: contextWindow,
          max_context_window: contextWindow,
          effective_context_window_percent: 100,
          auto_compact_token_limit: contextWindow,
        };
      });
      res.end(JSON.stringify({ object: 'list', data: modelList, models: modelList }));
      return true;
    }

    return false;
  }

  return { handleGet };
}

module.exports = { crearGetRoutes };
