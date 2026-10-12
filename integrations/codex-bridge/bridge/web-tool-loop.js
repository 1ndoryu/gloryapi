const { preserveCanaryProvider } = require('./upstream-metadata');

function crearWebToolLoop(ctx) {
  const { logRequest, attachRequestId, compactContext, assistantMessageFrom, assistantToolCalls, assistantReasoning, hasVisibleAssistantAction, lookupToolCall, visibleReasoning, reasoningFor, fallbackReasoning, WEB_TOOL_ROUNDS, MIXED_TOOL_RECOVERY_RETRIES, MIXED_TOOL_DIRECTIVE, runWebSearch, parseSearchQuery, fetchWithTimeoutRecovery, recoverEmptyCompletion } = ctx;
  const FALLBACK_REASONING = fallbackReasoning;

function hasWebTool(toolMap) {
  return [...toolMap.values()].some((entry) => entry && entry.web);
}

function assistantMessageForToolCalls(message, calls) {
  const assistantMessage = {
    role: 'assistant',
    content: message.content == null ? '' : message.content,
    tool_calls: calls,
  };
  const reasoningText = assistantReasoning
    ? assistantReasoning(message)
    : message.reasoning_content || message.reasoning || '';
  if (visibleReasoning(reasoningText)) {
    assistantMessage.reasoning_content = reasoningText;
  } else if (calls.length) {
    // DeepSeek requires reasoning_content on assistant tool-call messages.
    // This value is only sent to the upstream provider and is filtered before
    // the Responses client sees the turn.
    assistantMessage.reasoning_content = reasoningFor(calls[0].id) || FALLBACK_REASONING;
  }
  return assistantMessage;
}

function deferredClientToolSummary(calls) {
  // Do not copy provider-controlled arguments into a system message. The
  // model must regenerate them from the original user context; otherwise a
  // prompt injection inside a tool argument could gain system-message priority.
  const summary = calls.map(({ call }) => ({
    name: call && call.function && call.function.name,
  }));
  let encoded = '';
  try {
    encoded = JSON.stringify(summary);
  } catch {
    encoded = '[]';
  }
  return encoded.length <= 12000 ? encoded : `${encoded.slice(0, 11980)}...]`;
}

async function appendWebToolTurn(working, message, webCalls) {
  const calls = webCalls.map((entry) => entry.call);
  working.messages.push(assistantMessageForToolCalls(message, calls));

  for (const { call } of webCalls) {
    const args = (call.function && call.function.arguments) || '{}';
    const output = await runWebSearch(parseSearchQuery(args));
    working.messages.push({
      role: 'tool',
      tool_call_id: call.id,
      name: call.function && call.function.name,
      content: output,
    });
  }
}

function toolDefinitionName(tool) {
  if (tool && tool.function && typeof tool.function.name === 'string') return tool.function.name;
  return tool && typeof tool.name === 'string' ? tool.name : '';
}

function cloneForWebLimitSynthesis(chat, toolMap) {
  const webToolNames = new Set(
    [...toolMap.entries()]
      .filter(([, route]) => route && route.web)
      .map(([name]) => name),
  );
  // Do not copy the source request kind: preserveCanaryProvider also copies
  // non-configurable lifecycle metadata, while this recovery must be tagged as
  // a new bounded synthesis request.
  const synthesisChat = preserveCanaryProvider({
    __canaryProvider: chat.__canaryProvider,
    __parentRouteId: chat.__parentRouteId,
    __parentConfigurationRevision: chat.__parentConfigurationRevision,
    __parentSelectionReason: chat.__parentSelectionReason,
  }, {
    ...chat,
    messages: [...(chat.messages || [])],
    stream: false,
  });
  if (Array.isArray(chat.tools)) {
    const retainedTools = chat.tools.filter((tool) => !webToolNames.has(toolDefinitionName(tool)));
    if (retainedTools.length) synthesisChat.tools = retainedTools;
    else delete synthesisChat.tools;
  }
  attachRequestId(synthesisChat, chat.__gloryRequestId);
  for (const key of ['__userTools', '__latestUserText']) {
    if (typeof chat[key] === 'boolean' || typeof chat[key] === 'string') {
      Object.defineProperty(synthesisChat, key, {
        value: chat[key],
        enumerable: false,
      });
    }
  }
  return synthesisChat;
}

async function synthesizeAfterWebLimit(working, toolMap, authorization, addUsage, rounds) {
  const synthesisChat = cloneForWebLimitSynthesis(working, toolMap);
  synthesisChat.messages.push({
    role: 'system',
    content:
      'Se alcanzó el límite seguro de búsquedas web internas. Usa únicamente los resultados ya obtenidos. ' +
      'No solicites otra búsqueda web. Responde con una síntesis útil; si faltan datos, indícalo claramente.',
  });
  Object.defineProperty(synthesisChat, '__requestKind', { value: 'web_limit_synthesis', enumerable: false });
  Object.defineProperty(synthesisChat, '__parentRequestId', {
    value: working.__gloryRequestId || '',
    enumerable: false,
  });
  logRequest({
    ts: new Date().toISOString(),
    kind: 'web_loop_limit_synthesis',
    requestId: working.__gloryRequestId,
    status: 200,
    rounds,
    removedWebTools: true,
  });
  const json = await fetchWithTimeoutRecovery(synthesisChat, authorization);
  addUsage(json);
  const message = assistantMessageFrom(json);
  const webCalls = assistantToolCalls(message).filter((call) => {
    const route = lookupToolCall(call.function && call.function.name, toolMap, new Set());
    return route && route.web;
  });
  if (webCalls.length) {
    const error = new Error('El modelo siguió solicitando búsquedas web después de la recuperación acotada');
    error.statusCode = 502;
    error.code = 'web_tool_limit_recovery_exhausted';
    throw error;
  }
  return { json, synthesisChat };
}

function mixedToolRecoveryMessage(clientCalls) {
  return `${MIXED_TOOL_DIRECTIVE}\n` +
    `Llamadas de cliente pendientes (JSON de datos): ${deferredClientToolSummary(clientCalls)}`;
}

/**
 * Resolve provider-requested web tools entirely behind the Responses boundary.
 * The client receives only the final assistant response (or external tool
 * calls). This follows the public function-calling loop without asking Codex
 * Desktop to accept a fabricated function_call_output in response.output.
 */
async function runInternalWebToolLoop(chat, toolMap, authorization) {
  const working = preserveCanaryProvider(chat, attachRequestId(
    { ...chat, messages: [...(chat.messages || [])], stream: false },
    chat.__gloryRequestId,
  ));
  // El spread no copia propiedades no-enumerables; el hook de confirmación
  // necesita __userTools en el working para saber si el cliente expuso tools.
  Object.defineProperty(working, '__userTools', {
    value: chat.__userTools === true,
    enumerable: false,
  });
  const aggregateUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
  let lastPromptTokens = 0;
  let mixedRecoveryAttempts = 0;
  let webRounds = 0;

  const addUsage = (json) => {
    const usage = json && json.usage || {};
    lastPromptTokens = usage.prompt_tokens || lastPromptTokens;
    aggregateUsage.prompt_tokens += usage.prompt_tokens || 0;
    aggregateUsage.completion_tokens += usage.completion_tokens || 0;
    aggregateUsage.total_tokens += usage.total_tokens || 0;
    aggregateUsage.reasoning_tokens +=
      (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
  };

  // Mixed recovery consumes a provider round. Reserve enough additional
  // rounds for the configured recoveries plus the normal web-loop budget,
  // so a final web-only response still gets a follow-up completion request.
  const maxRounds = WEB_TOOL_ROUNDS + MIXED_TOOL_RECOVERY_RETRIES;
  for (let round = 0; round < maxRounds; round += 1) {
    let json = await fetchWithTimeoutRecovery(working, authorization);
    addUsage(json);

    let message = assistantMessageFrom(json);
    if (!message || !Object.keys(message).length) {
      const error = new Error('upstream response has no assistant message');
      error.statusCode = 502;
      throw error;
    }
    if (!hasVisibleAssistantAction(message)) {
      const recovered = await recoverEmptyCompletion(working, authorization, 'web-loop');
      if (recovered) {
        working.messages = recovered.chat.messages;
        json = recovered.json;
        message = assistantMessageFrom(json);
        lastPromptTokens = (json.usage && json.usage.prompt_tokens) || lastPromptTokens;
      }
    }
    const calls = assistantToolCalls(message);
    const classified = calls.map((call) => ({
      call,
      route: lookupToolCall(call.function && call.function.name, toolMap, new Set()),
    }));
    const webCalls = classified.filter((entry) => entry.route.web);
    if (!webCalls.length) return { json, aggregateUsage, lastPromptTokens, working };
    const clientCalls = classified.filter((entry) => !entry.route.web);
    if (clientCalls.length) {
      if (mixedRecoveryAttempts >= MIXED_TOOL_RECOVERY_RETRIES) {
        const error = new Error('upstream mixed internal web tools after bounded recovery');
        error.statusCode = 502;
        error.code = 'mixed_tool_recovery_exhausted';
        throw error;
      }
      mixedRecoveryAttempts += 1;
      // Keep the provider-side tool protocol valid: append only the web calls
      // with their matching outputs, then tell the model to re-emit the client
      // calls. We never fabricate a client function_call_output or expose the
      // internal web result as if the app had executed it.
      await compactContext(working, authorization, { emergency: true });
      await appendWebToolTurn(working, message, webCalls);
      working.messages.push({ role: 'system', content: mixedToolRecoveryMessage(clientCalls) });
      logRequest({
        ts: new Date().toISOString(),
        kind: 'mixed_tool_recovery',
        requestId: chat.__gloryRequestId,
        status: 200,
        attempt: mixedRecoveryAttempts,
        webTools: webCalls.map(({ call }) => call.function && call.function.name).filter(Boolean),
        clientTools: clientCalls.map(({ call }) => call.function && call.function.name).filter(Boolean),
        contextMessages: working.messages.length,
      });
      continue;
    }
    await appendWebToolTurn(working, message, webCalls);
    webRounds += 1;
    if (webRounds >= WEB_TOOL_ROUNDS) {
      const synthesis = await synthesizeAfterWebLimit(working, toolMap, authorization, addUsage, round + 1);
      return { json: synthesis.json, aggregateUsage, lastPromptTokens, working: synthesis.synthesisChat };
    }
  }

  const error = new Error('web loop ended without a bounded synthesis recovery');
  error.statusCode = 502;
  error.code = 'web_tool_loop_incomplete';
  throw error;
}

  return { hasWebTool, runInternalWebToolLoop };
}

module.exports = { crearWebToolLoop };
