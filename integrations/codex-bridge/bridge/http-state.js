function crearHttpState(ctx) {
  const { config, state, metrics, assertSafeLoopbackUpstream, visionConfigured, identity, contract, upstream, auth } = ctx;
  const lifecycleStates = ['starting', 'ready', 'blocked', 'draining', 'stopped'];

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
        imageInput: {
          status: 'adapted',
          reason: visionConfigured
            ? 'bridge_accepts_input_image_and_uses_mimo_for_text_only_models'
            : 'bridge_accepts_input_image_but_vision_route_is_not_configured',
        },
        vision: {
          status: visionConfigured ? 'adapted' : 'unsupported',
          reason: visionConfigured
            ? 'native_image_forwarding_for_vision_models_plus_lossy_text_adaptation_fallback'
            : 'vision_not_configured',
        },
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

  return { readinessChecks, getReadiness, getLifecycle, getCapabilityMatrix };
}

module.exports = { crearHttpState };
