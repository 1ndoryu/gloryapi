function createResponsesAdapter({
  logRequest,
  visibleReasoning,
  normalizeReasoningText,
  fallbackReasoning,
  withSpawnForkFix,
}) {
  const FALLBACK_REASONING = fallbackReasoning;

// Response translation: chat/completions SSE -> Responses SSE
// ---------------------------------------------------------------------------

function sseEvent(res, kind, data) {
  res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
}

function assistantMessageFrom(json) {
  return json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message
    : {};
}

function assistantText(message) {
  return message && typeof message.content === 'string' ? message.content : '';
}

function assistantToolCalls(message) {
  return message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

// Reasoning alone is internal work, not a visible answer. A tool-only message
// is valid and must be surfaced as a function_call so the client can execute it.
// Only text or a tool call is therefore sufficient to close this adapter turn.
function hasVisibleAssistantAction(message) {
  return Boolean(assistantText(message).trim() || assistantToolCalls(message).length);
}

function collaborationTool(name) {
  return name === 'spawn_agent' || name === 'send_message' || name === 'followup_task';
}

function responseItemForToolCall(tc, toolMap, customTools) {
  const wireName = tc && tc.function && tc.function.name;
  const route = lookupToolCall(wireName, toolMap, customTools);
  const args = (tc && tc.function && tc.function.arguments) || '{}';
  if (route.web) return { error: { type: 'web_loop_error', message: 'unresolved internal web tool' } };
  if (route.search) {
    return {
      item: {
        type: 'tool_search_call',
        call_id: tc.id,
        name: route.name,
        arguments: args,
        status: 'completed',
      },
    };
  }
  if (route.custom) {
    let rawInput = args;
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed.input === 'string') rawInput = parsed.input;
      else if (typeof parsed === 'string') rawInput = parsed;
    } catch {}
    return { item: { type: 'custom_tool_call', call_id: tc.id, name: route.name, input: rawInput } };
  }
  const item = {
    type: 'function_call',
    call_id: tc.id,
    name: route.name,
    arguments: withSpawnForkFix(route.name, args),
  };
  if (route.namespace) item.namespace = route.namespace;
  if (route.namespace === 'collaboration' && collaborationTool(route.name)) item.encrypted_function_args = [];
  return { item };
}

function responseItemsForToolCalls(toolCalls, toolMap, customTools) {
  const items = [];
  for (const tc of toolCalls || []) {
    const result = responseItemForToolCall(tc, toolMap, customTools);
    if (result.error) return { items, error: result.error };
    items.push(result.item);
  }
  return { items, error: null };
}

function responseUsageFromChatUsage(usage) {
  return {
    input_tokens: usage ? usage.prompt_tokens || 0 : 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: usage ? usage.completion_tokens || 0 : 0,
    output_tokens_details: {
      reasoning_tokens:
        usage && usage.completion_tokens_details ? usage.completion_tokens_details.reasoning_tokens || 0 : 0,
    },
    total_tokens: usage ? usage.total_tokens || 0 : 0,
  };
}

function emitResponseCompleted(res, responseId, usage, hasToolCalls, routedVia, requestId, textLen, toolNames, internalWebLoop = false) {
  sseEvent(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: responseUsageFromChatUsage(usage),
      // A function_call is a continuation boundary. `end_turn: true` here was
      // interpreted by the desktop client as a completed task before the tool
      // result could be sent back, especially for tool-only model responses.
      end_turn: !hasToolCalls,
    },
  });
  logRequest({
    ts: new Date().toISOString(),
    kind: 'result',
    requestId,
    status: 200,
    routedVia,
    textLen,
    toolCalls: toolNames.length,
    toolNames,
    ...(internalWebLoop ? { internalWebLoop: true } : {}),
  });
}

// Keep reasoning streaming for real model output, but hold a prefix long
// enough to detect the exact synthetic fallback. This prevents both a whole
// fallback and a fragmented fallback from becoming visible in the app.
function createReasoningForwarder(res, reasoningId) {
  let pending = '';
  let emitted = false;
  const emit = (text) => {
    const visible = visibleReasoning(text);
    if (!visible) return;
    if (!emitted) {
      emitted = true;
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: reasoningId, summary: [{ type: 'summary_text', text: '' }] },
      });
    }
    sseEvent(res, 'response.reasoning_text.delta', {
      type: 'response.reasoning_text.delta',
      item_id: reasoningId,
      content_index: 0,
      delta: visible,
    });
  };
  return {
    add(chunk) {
      if (!chunk) return;
      pending += chunk;
      const normalized = normalizeReasoningText(pending);
      const fallback = normalizeReasoningText(FALLBACK_REASONING);
      if (fallback.startsWith(normalized) && normalized.length <= fallback.length) return;
      emit(pending);
      pending = '';
    },
    finish() {
      emit(pending);
      pending = '';
      return emitted;
    },
  };
}

function lookupToolCall(wireName, toolMap, customTools) {
  const hit = toolMap.get(wireName);
  if (hit) return hit;
  // Generic de-mangling: DeepSeek strips the FIRST '__' from namespaced tool
  // identifiers (collaboration__spawn_agent -> collaborationspawn_agent, and
  // mcp__node_repl__js -> mcpnode_repl__js). No exact toolMap hit means the app
  // receives a bare function_call without namespace and rejects it. Rebuild the
  // namespace:name pair by removing the first '__' from every registered key
  // and comparing against the mangled call name. Covers any current or future
  // namespaced tool without a hardcoded alias (O(n) on a small map, once per
  // function_call).
  if (wireName && toolMap) {
    for (const [key, mapped] of toolMap) {
      const sep = key.indexOf('__');
      if (sep > 0 && key.slice(0, sep) + key.slice(sep + 2) === wireName) {
        return mapped;
      }
    }
  }
  // Robustness: DeepSeek mangles MCP identifiers (e.g. mcp__node_repl__js ->
  // mcpnode_repl__js). If the call name still mentions node_repl, route it to
  // the known in-app browser JS tool regardless of the exact separator form.
  // namespace must be `mcp__node_repl` (Codex MCP namespace = mcp__<server>).
  if (wireName && wireName.includes('node_repl')) {
    return { namespace: 'mcp__node_repl', name: 'js' };
  }
  return {
    namespace: null,
    name: wireName,
    custom: !!customTools && customTools.has(wireName),
  };
}

// ---------------------------------------------------------------------------

  return {
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
  };
}

module.exports = { createResponsesAdapter };
