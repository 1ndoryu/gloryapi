const path = require('node:path');

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

function normalizedPath(value, fallback) {
  const text = String(value || fallback).trim();
  return `/${text.replace(/^\/+/, '')}`;
}

function loopbackHost(value) {
  const host = String(value || '127.0.0.1').trim().toLowerCase();
  if (!new Set(['127.0.0.1', 'localhost', '::1']).has(host)) {
    throw new Error('BRIDGE_HOST must be loopback (127.0.0.1, localhost or ::1)');
  }
  return host;
}

const env = process.env;
const runtimeRoot = env.BRIDGE_RUNTIME_DIR || __dirname;

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
    model: firstEnv(env, ['BRIDGE_MODEL', 'GLORY_MODEL', 'FREEL_MODEL'], 'deepseek-v4-flash'),
    authScheme: firstEnv(env, ['BRIDGE_UPSTREAM_AUTH_SCHEME'], 'Bearer'),
    host: loopbackHost(env.BRIDGE_HOST),
    port: boundedEnvInt('BRIDGE_PORT', 4100, 1, 65535),
    debug: env.BRIDGE_DEBUG === '1',
    timeoutMs: boundedEnvInt('BRIDGE_UPSTREAM_TIMEOUT_MS', 360000, 100, 600000),
    timeoutRecoveryMs: boundedEnvInt('BRIDGE_UPSTREAM_TIMEOUT_RECOVERY_MS', 720000, 1000, 1200000),
    maxResponseBytes: boundedEnvInt('BRIDGE_UPSTREAM_MAX_BYTES', 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
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
    nudgeRetries: boundedEnvInt('BRIDGE_NUDGE_RETRIES', 1, 0, 3),
    nudgeTimeoutMs: boundedEnvInt('BRIDGE_NUDGE_TIMEOUT_MS', 60000, 1000, 300000),
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
    fallback:
      env.BRIDGE_FALLBACK_REASONING ||
      'El asistente analizó la petición y decidió invocar una herramienta para completar la tarea.',
  },
  vision: {
    baseUrl: env.VISION_BASE_URL || env.BRIDGE_VISION_BASE_URL || 'https://opencode.ai/zen/v1',
    completionsPath: normalizedPath(env.VISION_COMPLETIONS_PATH, '/chat/completions'),
    model: env.VISION_MODEL || env.BRIDGE_VISION_MODEL || 'mimo-v2.5-free',
    apiKey: env.VISION_API_KEY || '',
    maxTokens: boundedEnvInt('VISION_MAX_TOKENS', 4096, 1, 16384),
    timeoutMs: boundedEnvInt('VISION_TIMEOUT_MS', 180000, 100, 300000),
    disabled: env.VISION_DISABLE === '1',
    cacheFile: env.BRIDGE_VISION_CACHE_FILE || path.join(runtimeRoot, 'bridge.vision.json'),
    cacheMax: boundedEnvInt('BRIDGE_VISION_CACHE_MAX', 128, 1, 2048),
    channelNote:
      env.BRIDGE_VISION_CHANNEL_NOTE ||
      '[visión] Las imágenes se te entregan como texto: el modelo de visión las describe debajo.',
  },
  context: {
    disabled: env.BRIDGE_COMPACTION_DISABLED !== '0',
    limitTokens: boundedEnvInt('CONTEXT_LIMIT_TOKENS', 120000, 1000, 1000000),
    keepTokens: boundedEnvInt('COMPACT_KEEP_TOKENS', 30000, 100, 500000),
    summaryMaxTokens: boundedEnvInt('COMPACT_MAX_TOKENS', 16000, 256, 100000),
    safetyFactor: boundedEnvFloat('BRIDGE_COMPACTION_SAFETY_FACTOR', 1.25, 0, 4),
    summaryModel: firstEnv(env, ['BRIDGE_COMPACTION_MODEL', 'BRIDGE_MODEL', 'GLORY_MODEL', 'FREEL_MODEL'], 'deepseek-v4-flash'),
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

module.exports = { boundedEnvInt, boundedEnvFloat, firstEnv, normalizedPath, loopbackHost, config };
