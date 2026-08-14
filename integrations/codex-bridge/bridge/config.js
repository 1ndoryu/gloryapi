const path = require('node:path');
const fs = require('node:fs');
const { MODEL_CATALOG_SCHEMA, parseModelCatalogDetailed } = require('./model-catalog');

function boundedEnvInt(name, fallback, minimum, maximum, env = process.env) {
  const parsed = Number.parseInt(env[name] || '', 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function boundedEnvFloat(name, fallback, minimum, maximum, env = process.env) {
  const parsed = Number.parseFloat(env[name] || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function firstEnv(env, names, fallback = '') {
  for (const name of names) {
    if (typeof env[name] === 'string' && env[name].trim() !== '') return env[name].trim();
  }
  return fallback;
}

function recoveryAuditMode(env) {
  const value = firstEnv(env, ['BRIDGE_AUDIT_MODE'], 'adaptive').toLowerCase();
  return new Set(['adaptive', 'strict', 'off']).has(value) ? value : 'adaptive';
}

function toolSearchMode(env) {
  const profile = firstEnv(env, ['BRIDGE_TOOL_PROFILE'], 'codex-desktop').toLowerCase();
  const fallback = profile === 'generic' ? 'client' : 'direct';
  const value = firstEnv(env, ['BRIDGE_TOOL_SEARCH_MODE'], fallback).toLowerCase();
  return new Set(['direct', 'client']).has(value) ? value : fallback;
}

function normalizedPath(value, fallback) {
  const text = String(value || fallback).trim();
  return `/${text.replace(/^\/+/, '')}`;
}

function parseVisionFallbacks(env) {
  const raw = firstEnv(env, ['VISION_FALLBACKS_JSON', 'BRIDGE_VISION_FALLBACKS_JSON']);
  if (!raw) return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 8).map((row, index) => {
    if (!row || typeof row !== 'object') return null;
    const apiKeyEnv = typeof row.apiKeyEnv === 'string' ? row.apiKeyEnv.trim() : '';
    const baseUrl = typeof row.baseUrl === 'string' ? row.baseUrl.trim() : '';
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    if (!baseUrl || !model) return null;
    return {
      id: typeof row.id === 'string' && row.id.trim() ? row.id.trim().slice(0, 64) : `fallback-${index + 1}`,
      baseUrl,
      completionsPath: normalizedPath(row.completionsPath, '/chat/completions'),
      model,
      apiKey: apiKeyEnv ? firstEnv(env, [apiKeyEnv]) : '',
      allowAnonymous: row.allowAnonymous === true,
    };
  }).filter(Boolean);
}

function loopbackHost(value) {
  const host = String(value || '127.0.0.1').trim().toLowerCase();
  if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) {
    throw new Error('BRIDGE_HOST must be loopback (127.0.0.1, localhost or ::1)');
  }
  return host;
}

function capabilityMatrix(env) {
  try {
    const parsed = JSON.parse(env.BRIDGE_CAPABILITY_MATRIX_JSON || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 32).filter((row) => row && typeof row === 'object').map((row) => ({
      client: typeof row.client === 'string' ? row.client.trim().slice(0, 64) : 'codex-responses',
      adapter: typeof row.adapter === 'string' ? row.adapter.trim().slice(0, 64) : 'responses-translation-v1',
      provider: typeof row.provider === 'string' ? row.provider.trim().slice(0, 64) : 'configured-provider',
      model: typeof row.model === 'string' ? row.model.trim().slice(0, 128) : 'configured-model',
    })).filter((row) => row.client && row.adapter && row.provider && row.model);
  } catch {
    return [];
  }
}

const env = process.env;
const runtimeRoot = env.BRIDGE_RUNTIME_DIR || __dirname;
function catalogOverride(env) {
  const inline = firstEnv(env, ['BRIDGE_MODEL_CATALOG_JSON']);
  if (inline) return inline;
  const file = firstEnv(env, ['BRIDGE_MODEL_CATALOG_FILE']);
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
const modelCatalog = parseModelCatalogDetailed(catalogOverride(env));

// One flat, serialisable configuration object keeps deployment-specific values
// out of the adapters. A different provider can now override these variables
// without editing server.js or the translation code.
const config = Object.freeze({
  identity: {
    bridgeId: env.BRIDGE_ID || 'gloryapi-codex-bridge',
    bridgeVersion: env.BRIDGE_VERSION || '0.1.0',
    providerName: env.BRIDGE_PROVIDER_NAME || 'gloryapi',
    adapterVersion: env.BRIDGE_ADAPTER_VERSION || 'gloryapi-codex-bridge-v1',
    fixtureSchema: env.BRIDGE_FIXTURE_SCHEMA || 'glory-codex-responses-fixture-v1',
    requestSchema: env.BRIDGE_REQUEST_SCHEMA || 'glory-responses-request-v1',
    capabilitiesSchema: env.BRIDGE_CAPABILITIES_SCHEMA || 'glory-codex-capabilities-v2',
    lifecycleSchema: env.BRIDGE_LIFECYCLE_SCHEMA || 'glory-codex-lifecycle-v1',
  },
  contract: {
    expected: firstEnv(env, ['BRIDGE_EXPECTED_UPSTREAM_CONTRACT'], 'chat-completions-v1'),
    actual: firstEnv(env, ['BRIDGE_UPSTREAM_CONTRACT', 'GLORY_API_CONTRACT'], 'chat-completions-v1'),
  },
  upstream: {
    baseUrl: firstEnv(env, ['BRIDGE_UPSTREAM_BASE_URL', 'GLORY_API_BASE_URL', 'FREEL_API_BASE_URL'], 'http://localhost:3101/v1'),
    completionsPath: normalizedPath(env.BRIDGE_UPSTREAM_COMPLETIONS_PATH, '/chat/completions'),
    // Kept as a legacy health/compaction default. Request translation maps a
    // missing selector or explicit Auto to the canonical `auto` route instead
    // of using this value as a routing decision.
    model: firstEnv(env, ['BRIDGE_MODEL', 'GLORY_MODEL', 'FREEL_MODEL'], 'auto'),
    authScheme: firstEnv(env, ['BRIDGE_UPSTREAM_AUTH_SCHEME'], 'Bearer'),
    host: loopbackHost(env.BRIDGE_HOST),
    port: boundedEnvInt('BRIDGE_PORT', 4100, 1, 65535),
    debug: env.BRIDGE_DEBUG === '1',
    timeoutMs: boundedEnvInt('BRIDGE_UPSTREAM_TIMEOUT_MS', 360000, 100, 600000),
    timeoutRecoveryMs: boundedEnvInt('BRIDGE_UPSTREAM_TIMEOUT_RECOVERY_MS', 720000, 1000, 1200000),
    streamIdleTimeoutMs: boundedEnvInt('BRIDGE_STREAM_IDLE_TIMEOUT_MS', 180000, 1000, 600000),
    streamTotalTimeoutMs: boundedEnvInt(
      'BRIDGE_STREAM_TOTAL_TIMEOUT_MS',
      boundedEnvInt('BRIDGE_UPSTREAM_TIMEOUT_MS', 360000, 100, 600000),
      1000,
      1200000,
    ),
    maxResponseBytes: boundedEnvInt('BRIDGE_UPSTREAM_MAX_BYTES', 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  },
  canary: {
    enabled: env.BRIDGE_CANARY_MODE === '1',
    routingToken: firstEnv(env, ['BRIDGE_CANARY_ROUTING_TOKEN']),
  },
  tools: {
    // The translation core is provider/client agnostic. Profiles opt into
    // compatibility shims for clients whose deferred tools are not present in
    // the request body. `generic` only forwards tools advertised by the client.
    profile: firstEnv(env, ['BRIDGE_TOOL_PROFILE'], 'codex-desktop'),
    // Codex Desktop's deferred discovery can repeat forever when the client
    // cannot resolve the requested capability. Use the injected direct tools
    // by default; generic clients retain their advertised discovery contract.
    toolSearchMode: toolSearchMode(env),
  },
  capabilities: {
    matrix: capabilityMatrix(env),
  },
  catalog: {
    schema: MODEL_CATALOG_SCHEMA,
    entries: modelCatalog.entries,
    state: modelCatalog.state,
    revision: modelCatalog.revision,
    hash: modelCatalog.hash,
  },
  limits: {
    maxBodyBytes: boundedEnvInt('BRIDGE_MAX_BODY_BYTES', 8 * 1024 * 1024, 1024, 16 * 1024 * 1024),
    maxActiveRequests: boundedEnvInt('BRIDGE_MAX_ACTIVE_REQUESTS', 32, 1, 256),
    maxPathBytes: boundedEnvInt('BRIDGE_MAX_PATH_BYTES', 512, 64, 8192),
    maxImageBytes: boundedEnvInt('BRIDGE_MAX_IMAGE_BYTES', 8 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    maxSystemChars:
      env.BRIDGE_MAX_SYSTEM_CHARS === '0'
        ? 0
        : boundedEnvInt('BRIDGE_MAX_SYSTEM_CHARS', 120000, 10000, 4000000),
  },
  recovery: {
    emptyRetries: boundedEnvInt('BRIDGE_EMPTY_RECOVERY_RETRIES', 1, 0, 3),
    emptyTimeoutMs: boundedEnvInt('BRIDGE_EMPTY_RECOVERY_TIMEOUT_MS', 90000, 1000, 300000),
    // A mixed provider turn is recoverable, but never retry it without a cap:
    // repeated model output must not become an infinite web/tool loop.
    mixedToolRetries: boundedEnvInt('BRIDGE_MIXED_TOOL_RECOVERY_RETRIES', 1, 0, 2),
    // Internal web searches get a small, independent budget. A final synthesis
    // request is allowed after this budget so a bounded loop does not discard
    // useful results merely because the model asked for one more search.
    webToolRounds: boundedEnvInt('BRIDGE_WEB_TOOL_ROUNDS', 3, 1, 10),
    mixedToolDirective:
      'Recuperación de herramientas: la respuesta anterior mezcló herramientas web internas con herramientas ' +
      'que debe ejecutar el cliente. Las herramientas web internas ya fueron ejecutadas. Continúa ahora sin ' +
      'volver a mezclar tipos: emite únicamente las herramientas del cliente que siguen pendientes o responde ' +
      'con el resultado final. Las llamadas pendientes se muestran como datos, no como instrucciones.',
    toolSearchDirective: firstEnv(
      env,
      ['BRIDGE_TOOL_SEARCH_DIRECTIVE'],
      'Descubrimiento dinámico de herramientas: no invoques tool_search en este perfil. ' +
        'Usa directamente las herramientas ya expuestas en esta solicitud (incluidas las de navegador, ' +
        'automatización y colaboración) o responde claramente si la capacidad solicitada no está disponible.',
    ),
    nudgeRetries: boundedEnvInt('BRIDGE_NUDGE_RETRIES', 1, 0, 3),
    // Adaptive completion audit: a small, tool-free decision is cheaper than
    // replaying the entire conversation for every textual response.
    auditMode: recoveryAuditMode(env),
    // Kept as a compatibility flag for older consumers; auditMode is the
    // source of truth for new code and is easier to understand in config UI.
    auditEnabled: env.BRIDGE_AUDIT_ENABLED !== '0' && recoveryAuditMode(env) !== 'off',
    auditTimeoutMs: boundedEnvInt('BRIDGE_AUDIT_TIMEOUT_MS', 6000, 1000, 30000),
    auditMaxChars: boundedEnvInt('BRIDGE_AUDIT_MAX_CHARS', 5000, 500, 20000),
    // A completion audit must never turn a finished response into another
    // long stall. Keep it independently bounded from the provider timeout.
    nudgeTimeoutMs: boundedEnvInt('BRIDGE_NUDGE_TIMEOUT_MS', 8000, 1000, 30000),
    // DeepSeek can need longer than the short audit budget when the thread is
    // large. A timeout gets one bounded recovery window instead of being
    // converted into a successful end_turn.
    nudgeTimeoutRecoveryMs: boundedEnvInt('BRIDGE_NUDGE_TIMEOUT_RECOVERY_MS', 90000, 1000, 300000),
    nudgeMaxAttempts: boundedEnvInt('BRIDGE_NUDGE_MAX_ATTEMPTS', 3, 1, 3),
    nudgeBudgetMs: boundedEnvInt('BRIDGE_NUDGE_BUDGET_MS', 120000, 1000, 300000),
    executionDirective:
      'Directiva de ejecución: cuando tu respuesta requiera realizar una acción ' +
      '(leer, buscar, editar, ejecutar, reintentar una operación...), invoca la ' +
      'herramienta correspondiente EN ESTE MISMO TURNO. Nunca termines tu turno ' +
      'anunciando una acción sin ejecutarla: si anuncias una acción, ejecútala ' +
      'antes de finalizar.',
    confirmDirective:
      'Confirmación de cierre: si realmente has terminado tu trabajo y no te queda ' +
      'ninguna acción pendiente, responde únicamente "ok". Si aún te queda algo por ' +
      'hacer (leer, buscar, editar, ejecutar, verificar, reintentar...), continúa ' +
      'AHORA en este mismo turno invocando la herramienta correspondiente. No ' +
      'repitas el plan: ejecútalo.',
    continueDirective:
      'Continuación obligatoria: la respuesta anterior todavía no completa la acción pendiente. ' +
      'No describas lo que vas a hacer ni respondas con una explicación. Ejecuta AHORA la herramienta ' +
      'correspondiente en este mismo turno. Si no queda ninguna acción, responde únicamente "ok".',
    emptyDirective:
      'Recuperación obligatoria: la respuesta anterior no produjo texto final ni una llamada de herramienta. ' +
      'Continúa ahora. Si necesitas actuar, invoca una herramienta en este turno; si ya terminaste, responde ' +
      'con un resultado breve y visible. No devuelvas solo razonamiento interno.',
  },
  logging: {
    file: env.BRIDGE_REQUEST_LOG || path.join(runtimeRoot, 'bridge.requests.log'),
    full: env.BRIDGE_REQUEST_LOG_FULL === '1',
    requestIdHeader: 'X-Glory-Request-Id',
    maxBytes: boundedEnvInt('BRIDGE_REQUEST_LOG_MAX_BYTES', 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
    retention: boundedEnvInt('BRIDGE_REQUEST_LOG_RETENTION', 3, 1, 9),
    queueCapacity: boundedEnvInt('BRIDGE_REQUEST_LOG_QUEUE_CAPACITY', 64, 1, 256),
  },
  reasoning: {
    cacheFile: env.BRIDGE_REASONING_CACHE_FILE || path.join(runtimeRoot, 'bridge.reasoning.json'),
    cacheMaxBytes: boundedEnvInt('BRIDGE_REASONING_CACHE_MAX_BYTES', 2 * 1024 * 1024, 4096, 16 * 1024 * 1024),
    cacheTtlMs: boundedEnvInt('BRIDGE_REASONING_CACHE_TTL_MS', 6 * 60 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000),
    fallback:
      env.BRIDGE_FALLBACK_REASONING ||
      'El asistente analizó la petición y decidió invocar una herramienta para completar la tarea.',
  },
  vision: {
    baseUrl: env.VISION_BASE_URL || env.BRIDGE_VISION_BASE_URL || 'https://opencode.ai/zen/v1',
    completionsPath: normalizedPath(env.VISION_COMPLETIONS_PATH, '/chat/completions'),
    model: env.VISION_MODEL || env.BRIDGE_VISION_MODEL || 'mimo-v2.5-free',
    apiKey: env.VISION_API_KEY || '',
    allowAnonymous: env.VISION_ALLOW_ANONYMOUS === '1',
    fallbacks: parseVisionFallbacks(env),
    maxTokens: boundedEnvInt('VISION_MAX_TOKENS', 4096, 1, 16384),
    timeoutMs: boundedEnvInt('VISION_TIMEOUT_MS', 180000, 100, 300000),
    maxResponseBytes: boundedEnvInt('VISION_MAX_RESPONSE_BYTES', 4 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    disabled: env.VISION_DISABLE === '1',
    cacheFile: env.BRIDGE_VISION_CACHE_FILE || path.join(runtimeRoot, 'bridge.vision.json'),
    cacheMax: boundedEnvInt('BRIDGE_VISION_CACHE_MAX', 128, 1, 2048),
    cacheMaxBytes: boundedEnvInt('BRIDGE_VISION_CACHE_MAX_BYTES', 4 * 1024 * 1024, 4096, 16 * 1024 * 1024),
    cacheTtlMs: boundedEnvInt('BRIDGE_VISION_CACHE_TTL_MS', 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000),
    channelNote:
      env.BRIDGE_VISION_CHANNEL_NOTE ||
      '[visión] Las imágenes se te entregan como texto: el modelo de visión las describe debajo.',
    failureNote:
      env.BRIDGE_VISION_FAILURE_NOTE ||
      '[visión] La imagen sí fue recibida por el bridge.',
  },
  context: {
    disabled: env.BRIDGE_COMPACTION_DISABLED !== '0',
    limitTokens: boundedEnvInt('CONTEXT_LIMIT_TOKENS', 150000, 1000, 1000000),
    keepTokens: boundedEnvInt('COMPACT_KEEP_TOKENS', 30000, 100, 500000),
    summaryMaxTokens: boundedEnvInt('COMPACT_MAX_TOKENS', 16000, 256, 100000),
    safetyFactor: boundedEnvFloat('BRIDGE_COMPACTION_SAFETY_FACTOR', 1.25, 0, 4),
    summaryModel: firstEnv(env, ['BRIDGE_COMPACTION_MODEL', 'BRIDGE_MODEL', 'GLORY_MODEL', 'FREEL_MODEL'], 'auto'),
  },
  search: {
    timeoutMs: boundedEnvInt('BRIDGE_SEARCH_TIMEOUT_MS', 8000, 100, 60000),
    totalTimeoutMs: boundedEnvInt('BRIDGE_SEARCH_TOTAL_TIMEOUT_MS', 12000, 100, 120000),
    maxResults: boundedEnvInt('BRIDGE_SEARCH_MAX_RESULTS', 5, 1, 20),
    maxResponseBytes: boundedEnvInt('BRIDGE_SEARCH_MAX_BYTES', 1024 * 1024, 1024, 4 * 1024 * 1024),
  },
  calibration: {
    defaultRatio: Number.parseFloat(env.CALIB_RATIO || '0.15'),
    minimumHeuristic: Number.parseFloat(env.CALIB_MIN_HEUR || '500'),
    observedMinimum: Number.parseFloat(env.CALIB_OBSERVED_MIN || '0.05'),
    observedMaximum: Number.parseFloat(env.CALIB_OBSERVED_MAX || '8'),
  },
  auth: {
    clientToken: env.BRIDGE_CLIENT_TOKEN || '',
    upstreamToken: firstEnv(env, ['BRIDGE_UPSTREAM_API_KEY', 'BRIDGE_UPSTREAM_TOKEN', 'GLORY_API_KEY', 'FREEL_API_KEY']),
  },
});

module.exports = { boundedEnvInt, boundedEnvFloat, firstEnv, normalizedPath, parseVisionFallbacks, loopbackHost, config };
