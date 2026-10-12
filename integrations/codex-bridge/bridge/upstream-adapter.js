const { crearWebSearch } = require('./web-search');
const { crearUpstreamTransport } = require('./upstream-transport');
const { crearUpstreamEmptyRecovery } = require('./upstream-empty-recovery');
const { crearWebToolLoop } = require('./web-tool-loop');

function createUpstreamAdapter({
  config,
  log,
  logRequest,
  redactText,
  formatRemoteFailure,
  assertSafeLoopbackUpstream,
  attachRequestId,
  compactContext,
  assistantMessageFrom,
  assistantText,
  assistantReasoning,
  assistantToolCalls,
  hasVisibleAssistantAction,
  lookupToolCall,
  visibleReasoning,
  reasoningFor,
  fallbackReasoning,
}) {
  const { upstream, search, recovery, logging } = config;
  const UPSTREAM = upstream.baseUrl;
  const COMPLETIONS_PATH = upstream.completionsPath;
  const UPSTREAM_TIMEOUT_MS = upstream.timeoutMs;
  const UPSTREAM_TIMEOUT_RECOVERY_MS = upstream.timeoutRecoveryMs;
  const STREAM_IDLE_TIMEOUT_MS = upstream.streamIdleTimeoutMs;
  const STREAM_TOTAL_TIMEOUT_MS = upstream.streamTotalTimeoutMs;
  const UPSTREAM_MAX_RESPONSE_BYTES = upstream.maxResponseBytes;
  const SEARCH_TIMEOUT_MS = search.timeoutMs;
  const SEARCH_TOTAL_TIMEOUT_MS = search.totalTimeoutMs;
  const SEARCH_MAX_RESULTS = search.maxResults;
  const SEARCH_MAX_RESPONSE_BYTES = search.maxResponseBytes;
  const EMPTY_RECOVERY_RETRIES = recovery.emptyRetries;
  const EMPTY_RECOVERY_TIMEOUT_MS = recovery.emptyTimeoutMs;
  const EMPTY_RECOVERY_DIRECTIVE = recovery.emptyDirective;
  const MIXED_TOOL_RECOVERY_RETRIES = recovery.mixedToolRetries;
  const WEB_TOOL_ROUNDS = recovery.webToolRounds;
  const MIXED_TOOL_DIRECTIVE = recovery.mixedToolDirective;
  const REQUEST_ID_HEADER = logging.requestIdHeader;
  const canaryRoutingHeaders = config.canary.enabled && config.canary.routingToken
    ? (chat) => chat.__canaryProvider
      ? {
          'X-Glory-Canary-Provider': chat.__canaryProvider,
          'X-Glory-Canary-Token': config.canary.routingToken,
        }
      : {}
    : () => ({});

  const { runWebSearch, parseSearchQuery } = crearWebSearch({
    log,
    formatRemoteFailure,
    SEARCH_TIMEOUT_MS,
    SEARCH_TOTAL_TIMEOUT_MS,
    SEARCH_MAX_RESULTS,
    SEARCH_MAX_RESPONSE_BYTES,
  });
  const { fetchUpstreamCompletion, fetchUpstreamStream, fetchWithTimeoutRecovery } = crearUpstreamTransport({
    assertSafeLoopbackUpstream,
    redactText,
    logRequest,
    UPSTREAM,
    COMPLETIONS_PATH,
    UPSTREAM_TIMEOUT_MS,
    UPSTREAM_TIMEOUT_RECOVERY_MS,
    UPSTREAM_MAX_RESPONSE_BYTES,
    STREAM_IDLE_TIMEOUT_MS,
    STREAM_TOTAL_TIMEOUT_MS,
    REQUEST_ID_HEADER,
    canaryRoutingHeaders,
  });
  const { recoverEmptyCompletion } = crearUpstreamEmptyRecovery({
    attachRequestId,
    compactContext,
    assistantMessageFrom,
    assistantText,
    assistantToolCalls,
    hasVisibleAssistantAction,
    logRequest,
    EMPTY_RECOVERY_RETRIES,
    EMPTY_RECOVERY_TIMEOUT_MS,
    EMPTY_RECOVERY_DIRECTIVE,
    fetchUpstreamCompletion,
  });
  const { hasWebTool, runInternalWebToolLoop } = crearWebToolLoop({
    logRequest,
    attachRequestId,
    compactContext,
    assistantMessageFrom,
    assistantToolCalls,
    assistantReasoning,
    hasVisibleAssistantAction,
    lookupToolCall,
    visibleReasoning,
    reasoningFor,
    fallbackReasoning,
    WEB_TOOL_ROUNDS,
    MIXED_TOOL_RECOVERY_RETRIES,
    MIXED_TOOL_DIRECTIVE,
    runWebSearch,
    parseSearchQuery,
    fetchWithTimeoutRecovery,
    recoverEmptyCompletion,
  });

  return {
    runWebSearch,
    hasWebTool,
    fetchUpstreamCompletion,
    fetchUpstreamStream,
    fetchWithTimeoutRecovery,
    runInternalWebToolLoop,
    recoverEmptyCompletion,
  };
}

module.exports = { createUpstreamAdapter };
