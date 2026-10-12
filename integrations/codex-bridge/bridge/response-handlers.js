const { crearNudge } = require('./response-nudge');
const { crearInternalWeb } = require('./response-stream-internal-web');
const { crearStreamChat } = require('./response-stream-chat');
const { crearNonStream } = require('./response-nonstream');

function createResponseHandlers({
  config,
  rand,
  logRequest,
  redactText,
  upstreamAuthHeader,
  sseParserError,
  SseStreamParser,
  runInternalWebToolLoop,
  hasWebTool,
  fetchUpstreamStream,
  fetchWithTimeoutRecovery,
  recoverEmptyCompletion,
  responseHelpers,
  context,
  rememberReasoning,
}) {
  const MODEL = config.upstream.model;
  const UPSTREAM_MAX_RESPONSE_BYTES = config.upstream.maxResponseBytes;
  const NUDGE_RETRIES = config.recovery.nudgeRetries;
  const { sseEvent, assistantMessageFrom, assistantText, assistantReasoning, assistantToolCalls, hasVisibleAssistantAction,
    responseItemsForToolCalls, responseUsageFromChatUsage, emitResponseCompleted, createReasoningForwarder } = responseHelpers;
  const {
    visibleReasoning, realTokens, totalTokens, calibrate, nudgeForToolCalls, auditThenNudge,
    isFutureIntentNarration, isConfirmationText, currentTurnHasToolMessages,
    shouldAuditCompletion,
  } = context;
  const SseParserError = sseParserError;

  function responseModel(chat) {
    return chat.__bridgePresentationModel || chat.model || MODEL;
  }

  const { runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure } = crearNudge({
    logRequest, upstreamAuthHeader, sseEvent, auditThenNudge, nudgeForToolCalls,
  });
  const { streamInternalWebLoopToResponses } = crearInternalWeb({
    rand, logRequest, redactText, upstreamAuthHeader, runInternalWebToolLoop, rememberReasoning, sseEvent,
    assistantMessageFrom, assistantText, assistantReasoning, assistantToolCalls, responseItemsForToolCalls,
    emitResponseCompleted, createReasoningForwarder, visibleReasoning, realTokens, totalTokens, calibrate,
    isFutureIntentNarration, isConfirmationText, shouldAuditCompletion, responseModel,
    runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure,
  });
  const { streamChatToResponses } = crearStreamChat({
    rand, logRequest, redactText, upstreamAuthHeader, fetchUpstreamStream, hasWebTool, responseModel,
    streamInternalWebLoopToResponses, SseStreamParser, SseParserError, UPSTREAM_MAX_RESPONSE_BYTES,
    createReasoningForwarder, sseEvent, recoverEmptyCompletion, rememberReasoning, assistantMessageFrom,
    assistantText, assistantReasoning, assistantToolCalls, responseItemsForToolCalls, emitResponseCompleted,
    visibleReasoning, realTokens, totalTokens, calibrate, isFutureIntentNarration, isConfirmationText,
    shouldAuditCompletion, runNudgeWithKeepAlive, nudgeFailure, emitNudgeFailure,
  });
  const { nonStreamingChatToResponses } = crearNonStream({
    rand, logRequest, redactText, upstreamAuthHeader, runInternalWebToolLoop, hasWebTool, fetchWithTimeoutRecovery,
    recoverEmptyCompletion, rememberReasoning, assistantMessageFrom, assistantText, assistantReasoning,
    assistantToolCalls, hasVisibleAssistantAction, responseItemsForToolCalls, responseUsageFromChatUsage,
    visibleReasoning, realTokens, totalTokens, calibrate, nudgeForToolCalls, auditThenNudge,
    isFutureIntentNarration, isConfirmationText, shouldAuditCompletion, responseModel, nudgeFailure,
  });

  return { streamChatToResponses, nonStreamingChatToResponses };
}

module.exports = { createResponseHandlers };
