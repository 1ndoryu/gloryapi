const { NODE_REPL_JS_TOOL, AUTOMATION_UPDATE_TOOL } = require('./request-tables');

function crearTools(ctx) {
  const { log, toolProfile } = ctx;

/**
 * Flatten a single Responses tool into a chat function tool.
 *
 * Mutates the shared `tools`, `toolMap` and `customTools` so the same routine
 * can be used for the request's body.tools AND for tools the app reports as
 * discovered via tool_search (tool_search_output / additional_tools input
 * items). Codex does NOT re-inject discovered tools into body.tools, so without
 * this the upstream model can never call e.g. `mcp__node_repl__js` (the in-app
 * browser's privileged runtime) and falls back to shell_command, which fails.
 */
function flattenOneTool(tool, tools, toolMap, customTools) {
  const type = tool && tool.type;
  if (type === 'function') {
    const fn = tool.function || tool; // tolerate both shapes
    tools.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
        ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
      },
    });
    // MCP-style names arrive prefixed as "ns__tool" (e.g. mcp__node_repl__js).
    // Remember the split so the response comes back as function_call with
    // namespace+name SEPARATED (Codex's router needs the pair, otherwise MCP
    // tools fail with "unsupported call"/"no conectada").
    // Use LAST '__' as the split point: Codex MCP namespaces carry the `mcp__`
    // prefix themselves (mcp__node_repl__js -> namespace 'mcp__node_repl',
    // name 'js'), so a first-'__' split would yield the wrong pair.
    const sep = fn.name.lastIndexOf('__');
    if (sep > 0) toolMap.set(fn.name, { namespace: fn.name.slice(0, sep), name: fn.name.slice(sep + 2) });
  } else if (type === 'custom') {
    // Freeform tools (e.g. apply_patch) have no JSON schema. Expose them as a
    // normal function whose single argument carries the freeform payload.
    // Remember them so responses come back as `custom_tool_call` (raw input),
    // which is the ONLY payload shape codex 0.147's ApplyPatchHandler accepts
    // (ToolPayload::Custom). As a function_call it fails with
    // "tool apply_patch invoked with incompatible payload".
    customTools.add(tool.name);
    tools.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: 'Freeform tool input.' } },
          required: ['input'],
        },
      },
    });
  } else if (type === 'namespace') {
    // Namespace (MCP, plugin...) -> flatten each child to "ns__name"
    // (e.g. namespace mcp + child node_repl__js -> mcp__node_repl__js).
    for (const inner of tool.tools || []) {
      const fn = inner.function || inner;
      const flat = `${tool.name}__${inner.name}`;
      toolMap.set(flat, { namespace: tool.name, name: fn.name });
      tools.push({
        type: 'function',
        function: {
          name: flat,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} },
        },
      });
    }
  } else if (type === 'tool_search' || type === 'web_search') {
    // Discovery tools. Keep them callable so DeepSeek can request tool
    // discovery (the in-app browser skill requires discovery of `node_repl js`).
    // Responses come back as tool_search_call / web_search_call, which the app
    // handles itself and answers with tool_search_output / web_search_call data.
    const name = tool.name || type;
    const isSearch = type === 'tool_search';
    toolMap.set(name, { namespace: null, name, search: isSearch, web: !isSearch });
    tools.push({
      type: 'function',
      function: {
        name,
        description: isSearch
          ? tool.description ||
            'Search for additional tools that can help complete the task. Returns newly discovered tools which can then be called directly.'
          : tool.description || 'Search the web for up-to-date information to answer the user request.',
        parameters: isSearch
          ? {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Query describing the tool(s) to find.' },
                limit: { type: 'integer', description: 'Maximum number of tools to return.' },
              },
              required: ['query'],
            }
          : {
              type: 'object',
              properties: { query: { type: 'string', description: 'Search query.' } },
              required: ['query'],
            },
      },
    });
  } else {
    // computer_use / ... unsupported locally -> drop
    log(`drop tool type=${type} name=${(tool && tool.name) || ''}`);
  }
}

/**
 * Flatten Responses tools into chat function tools.
 * Returns { tools, toolMap, customTools } where toolMap maps the flattened (wire)
 * name the model will call back with -> { namespace, name } so we can restore the
 * namespace/name pair Codex expects in function_call output items.
 */
function translateTools(responsesTools, options = {}) {
  const tools = [];
  const toolMap = new Map();
  const customTools = new Set();
  const searchMode = options.toolSearchMode || 'client';
  for (const tool of responsesTools || []) {
    // A client-owned tool_search has no useful retry protocol at this boundary:
    // if discovery returns no usable tool, the app sends the same request and
    // DeepSeek repeats the search. Direct mode removes that loop trigger.
    if (tool && tool.type === 'tool_search' && searchMode === 'direct') {
      log(`tool_search disabled mode=${searchMode}`);
      continue;
    }
    flattenOneTool(tool, tools, toolMap, customTools);
  }
  // The codex-desktop profile injects the in-app browser's Node REPL `js` tool.
  // The app only exposes
  // it via tool_search discovery (which DeepSeek never performs), so without this
  // the browser skill stalls: the model can never call mcp__node_repl__js.
  // The identifier mcp__node_repl__js splits as { namespace: 'mcp__node_repl',
  // name: 'js' } — Codex's MCP namespace is `mcp__<server>` (verified in
  // openai/codex: `let namespace = format!("mcp__{server}")` in
  // app-server/tests/suite/v2/mcp_tool.rs, and ToolInfo.callable_namespace
  // carries the `mcp__` prefix). Splitting as { 'mcp', 'node_repl__js' } makes
  // the app look for ToolName('mcp','node_repl__js') = 'mcpnode_repl__js',
  // which matches no registered tool, so the call is silently dropped and the
  // model retries forever.
  // CONDITIONAL: newer Codex Desktop builds expose mcp__node_repl__js directly
  // in body.tools (namespace mcp__node_repl with children js, js_reset,
  // js_add_node_module_dir). Pushing unconditionally duplicated the name and
  // the upstream rejected the whole request with "Tool names must be unique"
  // (observed 2026-08-10, request req_df522... -> 400 -> "Provider rejected the
  // request"). Only inject when the client did not already provide it.
  if (toolProfile.injectNodeRepl) {
    if (!tools.some((t) => t.function && t.function.name === NODE_REPL_JS_TOOL.function.name)) {
      tools.push(NODE_REPL_JS_TOOL);
    }
    toolMap.set('mcp__node_repl__js', { namespace: 'mcp__node_repl', name: 'js' });
  // DeepSeek does NOT echo the double-underscore verbatim: it calls the tool as
  // `mcpnode_repl__js` (single underscores around the namespace), so the exact
  // toolMap key never matches and lookupToolCall falls back to a bare
  // function_call with no namespace -> the app rejects it as an unknown tool and
  // the model retries forever (observed 820x in bridge.requests.log). Register
  // the alias the model actually produces, mapping to the same MCP pair.
    toolMap.set('mcpnode_repl__js', { namespace: 'mcp__node_repl', name: 'js' });
  }
  // The codex-desktop profile injects the app's `automation_update` dynamic tool ("guardar
  // recuerdo"/recurring automations). Same deferred-discovery failure as
  // node_repl: the app marks it deferLoading:true and only materializes it via
  // tool_search (which DeepSeek never performs), so without this injection the
  // model can never call it. The app's dispatcher only requires a local thread,
  // so a function_call with namespace `codex_app` + name `automation_update`
  // executes. Register the namespace/name pair AND the alias DeepSeek actually
  // emits (it strips the FIRST '__', producing `codex_appautomation_update`; the
  // generic de-mangling in lookupToolCall would also match, this makes it exact).
  if (toolProfile.injectAutomation) {
    if (!tools.some((t) => t.function && t.function.name === AUTOMATION_UPDATE_TOOL.function.name)) {
      tools.push(AUTOMATION_UPDATE_TOOL);
    }
    toolMap.set('codex_app__automation_update', { namespace: 'codex_app', name: 'automation_update' });
    toolMap.set('codex_appautomation_update', { namespace: 'codex_app', name: 'automation_update' });
  }
  // Multi-agent v2 (namespace `collaboration`) has the SAME failure mode: the
  // model calls `collaboration__spawn_agent` as `collaborationspawn_agent`
  // (first '__' stripped), so the app receives a bare function_call without the
  // `collaboration` namespace. The app's fallback then either drops the spawn
  // message (thinker never sees the proposal) or rejects the call outright
  // ("unsupported call: collaborationsend_message"), and the parent retries
  // forever (163x spawn + followup in bridge.requests.log). Register explicit
  // aliases for every collaboration tool so the response carries the proper
  // namespace:name pair and the app dispatches through the normal path.
  if (toolProfile.collaborationAliases) {
    const COLLAB_TOOLS = [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
      'close_agent',
      'update_agent',
    ];
    for (const t of COLLAB_TOOLS) {
      toolMap.set(`collaboration${t}`, { namespace: 'collaboration', name: t });
    }
  }
  // Dedupe by wire name as a final safety net: if the client already listed a
  // tool (directly or via namespace flattening) we must not send duplicates.
  // The upstream (FreeBuff/DeepSeek) rejects duplicate tool names with 400
  // "Tool names must be unique" -> "Provider rejected the request".
  const seen = new Set();
  const deduped = [];
  for (const t of tools) {
    const name = t.function && t.function.name;
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    deduped.push(t);
  }
  return { tools: deduped, toolMap, customTools };
}

  return { translateTools, flattenOneTool };
}

module.exports = { crearTools };
