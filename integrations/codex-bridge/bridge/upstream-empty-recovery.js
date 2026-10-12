const { preserveCanaryProvider } = require('./upstream-metadata');

function crearUpstreamEmptyRecovery(ctx) {
  const { attachRequestId, compactContext, assistantMessageFrom, assistantText, assistantToolCalls, hasVisibleAssistantAction, logRequest, EMPTY_RECOVERY_RETRIES, EMPTY_RECOVERY_TIMEOUT_MS, EMPTY_RECOVERY_DIRECTIVE, fetchUpstreamCompletion } = ctx;

function cloneForEmptyRecovery(chat) {
  const recovered = preserveCanaryProvider({
    __canaryProvider: chat.__canaryProvider,
    __parentRouteId: chat.__parentRouteId,
    __parentConfigurationRevision: chat.__parentConfigurationRevision,
    __parentSelectionReason: chat.__parentSelectionReason,
  }, {
    ...chat,
    stream: false,
    messages: [...(chat.messages || [])],
  });
  attachRequestId(recovered, chat.__gloryRequestId);
  Object.defineProperty(recovered, '__requestKind', { value: 'recovery', enumerable: false });
  Object.defineProperty(recovered, '__parentRequestId', { value: chat.__gloryRequestId || '', enumerable: false });
  Object.defineProperty(recovered, '__userTools', {
    value: chat.__userTools === true,
    enumerable: false,
  });
  return recovered;
}

async function recoverEmptyCompletion(chat, authorization, source) {
  if (EMPTY_RECOVERY_RETRIES <= 0) return null;
  const recoveryChat = cloneForEmptyRecovery(chat);
  // Only pay the summarization cost after the provider has already returned an
  // unusable completion. This gives long-context sessions a smaller second
  // request without changing the healthy path or Codex's native compaction.
  await compactContext(recoveryChat, authorization, { emergency: true });
  recoveryChat.messages.push({ role: 'system', content: EMPTY_RECOVERY_DIRECTIVE });

  for (let attempt = 1; attempt <= EMPTY_RECOVERY_RETRIES; attempt += 1) {
    try {
      const json = await fetchUpstreamCompletion(recoveryChat, authorization, EMPTY_RECOVERY_TIMEOUT_MS);
      const message = assistantMessageFrom(json);
      if (hasVisibleAssistantAction(message)) {
        logRequest({
          ts: new Date().toISOString(),
          kind: 'empty_recovery_success',
          requestId: chat.__gloryRequestId,
          status: 200,
          source,
          attempt,
          routedVia: json.__routedVia || null,
          textLen: assistantText(message).length,
          toolCalls: assistantToolCalls(message).length,
        });
        return { json, chat: recoveryChat };
      }
      logRequest({
        ts: new Date().toISOString(),
        kind: 'empty_recovery_noop',
        requestId: chat.__gloryRequestId,
        status: 200,
        source,
        attempt,
        routedVia: json.__routedVia || null,
      });
    } catch (error) {
      logRequest({
        ts: new Date().toISOString(),
        kind: 'empty_recovery_error',
        requestId: chat.__gloryRequestId,
        status: error.statusCode || 502,
        source,
        attempt,
        error: error.message,
      });
    }
  }
  return null;
}

  return { recoverEmptyCompletion };
}

module.exports = { crearUpstreamEmptyRecovery };
