#!/usr/bin/env node
/**
 * Bridge Codex (Responses API) -> OpenAI-compatible upstream (chat/completions)
 *
 * Codex CLI 0.146+ ONLY speaks the Responses wire protocol (wire_api = "responses").
 * The configured upstream exposes chat/completions, so this zero-dependency Node
 * server translates between the two:
 *
 *   Codex --(Responses SSE)--> bridge --(chat/completions SSE)--> upstream
 *
 * The model, provider identity, upstream URL and limits are configuration values;
 * the bridge does not contain provider-specific routing logic.
 *
 * Env vars:
 *   BRIDGE_UPSTREAM_BASE_URL  upstream base URL (legacy GLORY/FREEL aliases supported)
 *   BRIDGE_MODEL              upstream model
 *   BRIDGE_PORT         listen port            (default 4100)
 *   BRIDGE_DEBUG        log translated requests (default off)
 *
 * Vision (agent-vision-toolkit pattern): input_image items in the Responses
 * request are replaced by a text description from a cheap vision model. The
 * vision model ONLY receives the image plus a short description task (the
 * user's latest text as focus hint) - never the full conversation.
 *   VISION_BASE_URL     vision base URL        (default https://opencode.ai/zen/v1)
 *   VISION_MODEL        vision model id        (default mimo-v2.5-free)
 *   VISION_API_KEY      vision api key         (no default; optional)
 *   VISION_FALLBACKS_JSON extra vision routes  (JSON; keys use apiKeyEnv)
 *   VISION_MAX_TOKENS   vision max tokens      (default 4096)
 *   VISION_DISABLE      1 -> skip image description (images dropped)
 *
 * Context window: when the translated messages exceed the limit, the oldest
 * messages are compacted into a single system summary (native autocompaction,
 * like ChatGPT) keeping the most recent turns intact.
 *   CONTEXT_LIMIT_TOKENS   context window      (default 120000)
 *   COMPACT_KEEP_TOKENS    recent tokens kept intact (default 30000)
 */

const crypto = require('crypto');
const { format } = require('node:util');
const { config } = require('./config');
const { createReasoningCache } = require('./reasoning-cache');
const { createVisionAdapter } = require('./vision');
const { createRequestTranslator } = require('./request-translator');
const { createContextAdapter } = require('./context-adapter');
const { createResponsesAdapter } = require('./responses-adapter');
const { createUpstreamAdapter } = require('./upstream-adapter');
const { createResponseHandlers } = require('./response-handlers');
const { createBridgeHttpServer } = require('./http-server');
const { SseParserError, SseStreamParser } = require('./responses-sse');
const { assertSafeVisionEndpoint, resolveSafeVisionEndpoint, assertSafeLoopbackUpstream } = require('./endpoint-security');
const { formatRemoteFailure, responseByteLength } = require('./diagnostics');
const { createRequestLogger } = require('./request-log');
const { redactString, redactValue } = require('./redaction');
const { validateResponsesRequest } = require('./responses-schema');
const { createMetrics } = require('./metrics');

// Metadata-only diagnostics by default. Prompt bodies can contain credentials,
// private files and conversation content, so full logging is explicit opt-in.
// The shared redactor covers api[_-]?key, bearer, cookie, token and tool payload fields.
function redactText(value, maxLength = 500) {
  return redactString(value, maxLength);
}
function logRequest(entry) {
  requestLogger(entry);
}

function requestIdFor(req) {
  const supplied = Array.isArray(req.headers['x-glory-request-id'])
    ? req.headers['x-glory-request-id'][0]
    : req.headers['x-glory-request-id'];
  if (typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(supplied)) return supplied;
  return `req_${crypto.randomUUID().replace(/-/g, '')}`;
}

function attachRequestId(chat, requestId) {
  Object.defineProperty(chat, '__gloryRequestId', {
    value: requestId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return chat;
}

function upstreamAuthHeader() {
  return config.auth.upstreamToken
    ? `${config.upstream.authScheme} ${config.auth.upstreamToken}`
    : null;
}

const requestLogger = createRequestLogger({
  file: config.logging.file,
  maxBytes: config.logging.maxBytes,
  retention: config.logging.retention,
  queueCapacity: config.logging.queueCapacity,
  sanitize: (entry) => {
    const safe = { ...entry };
    if (!config.logging.full) delete safe.body;
    else if (safe.body) safe.body = redactValue(safe.body);
    if (safe.headers) safe.headers = redactValue(safe.headers);
    if (safe.error) {
      const errorText = String(safe.error);
      safe.errorBytes = Buffer.byteLength(errorText, 'utf8');
      if (!config.logging.full) delete safe.error;
      else safe.error = redactText(errorText);
    }
    return safe;
  },
});

const rand = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

// DeepSeek requires reasoning_content for assistant tool calls. This adapter
// owns the persistence and synthetic-reasoning filtering in a dedicated cache.
const reasoningCache = createReasoningCache({
  file: config.reasoning.cacheFile,
  fallback: config.reasoning.fallback,
  log,
  maxBytes: config.reasoning.cacheMaxBytes,
  ttlMs: config.reasoning.cacheTtlMs,
});
const { visibleReasoning, normalizeReasoningText, rememberReasoning, reasoningFor } = reasoningCache;

const visionAdapter = createVisionAdapter({
  config,
  assertSafeVisionEndpoint,
  resolveSafeVisionEndpoint,
  formatRemoteFailure,
  log,
});
const { describeImage, describeImageResult, extractFocusHint, validateImageReference } = visionAdapter;

function log(...args) {
  process.stderr.write(`${format(`[${new Date().toISOString()}]`, ...args)}\n`);
}

// ---------------------------------------------------------------------------
let upstreamAdapter;

const contextAdapter = createContextAdapter({
  config,
  log,
  logRequest,
  formatRemoteFailure,
  normalizeReasoningText,
  visibleReasoning,
  fallbackReasoning: config.reasoning.fallback,
  attachRequestId,
  fetchUpstreamCompletion: (...args) => upstreamAdapter.fetchUpstreamCompletion(...args),
});
const {
  boundSystemContent,
  compactContext,
  totalTokens,
  realTokens,
  calibrate,
  withSpawnForkFix,
  isFutureIntentNarration,
  isConfirmationText,
  currentTurnHasToolMessages,
  nudgeForToolCalls,
} = contextAdapter;

const requestTranslator = createRequestTranslator({
  config,
  describeImage,
  describeImageResult,
  extractFocusHint,
  boundSystemContent,
  log,
  reasoningFor,
});
const { translateRequest } = requestTranslator;

const responsesAdapter = createResponsesAdapter({
  logRequest,
  visibleReasoning,
  normalizeReasoningText,
  fallbackReasoning: config.reasoning.fallback,
  withSpawnForkFix,
  toolProfile: config.tools.profile,
});
const {
  sseEvent,
  assistantMessageFrom,
  assistantText,
  assistantToolCalls,
  hasVisibleAssistantAction,
  responseItemsForToolCalls,
  responseUsageFromChatUsage,
  emitResponseCompleted,
  createReasoningForwarder,
  lookupToolCall,
} = responsesAdapter;

upstreamAdapter = createUpstreamAdapter({
  config,
  log,
  logRequest,
  redactText,
  formatRemoteFailure,
  assertSafeLoopbackUpstream,
  attachRequestId,
  compactContext: (...args) => contextAdapter.compactContext(...args),
  assistantMessageFrom,
  assistantText,
  assistantToolCalls,
  hasVisibleAssistantAction,
  lookupToolCall,
  visibleReasoning,
  reasoningFor,
  fallbackReasoning: config.reasoning.fallback,
});

const {
  runWebSearch,
  hasWebTool,
  fetchUpstreamCompletion,
  fetchUpstreamStream,
  fetchWithTimeoutRecovery,
  runInternalWebToolLoop,
  recoverEmptyCompletion,
} = upstreamAdapter;

// ---------------------------------------------------------------------------
const responseHandlers = createResponseHandlers({
  config,
  rand,
  logRequest,
  redactText,
  upstreamAuthHeader,
  sseParserError: SseParserError,
  SseStreamParser,
  runInternalWebToolLoop,
  hasWebTool,
  fetchUpstreamStream,
  fetchWithTimeoutRecovery,
  recoverEmptyCompletion,
  responseHelpers: responsesAdapter,
  context: {
    visibleReasoning,
    realTokens,
    totalTokens,
    calibrate,
    nudgeForToolCalls,
    isFutureIntentNarration,
    isConfirmationText,
    currentTurnHasToolMessages,
  },
  rememberReasoning,
});
const { streamChatToResponses, nonStreamingChatToResponses } = responseHandlers;

// ---------------------------------------------------------------------------
// HTTP server composition
// ---------------------------------------------------------------------------

const bridgeState = {
  lifecyclePhase: 'starting',
  lifecycleStartedAt: null,
  shutdownRequested: false,
  activeRequests: 0,
};
const bridgeMetrics = createMetrics();

const bridgeHttp = createBridgeHttpServer({
  config,
  state: bridgeState,
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
  metrics: bridgeMetrics,
});

process.once('SIGINT', () => bridgeHttp.requestShutdown('SIGINT'));
process.once('SIGTERM', () => bridgeHttp.requestShutdown('SIGTERM'));
bridgeHttp.start();
