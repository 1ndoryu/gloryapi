const { resolveToolProfile } = require('./tool-profile');
const { resolveModelSelection } = require('./model-catalog');

// Codex Responses sends the picker value as `reasoning.effort`. Keep the
// legacy flat field too because some clients/profiles send
// `reasoning_effort` directly. GloryAPI intentionally accepts only its
// canonical four values; aliases are normalized here at the client boundary.
function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'minimal': return 'low';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'max': return 'max';
    case 'xhigh':
    case 'ultra': return 'max';
    case 'none':
    case 'off': return undefined;
    default: return undefined;
  }
}

function requestReasoningEffort(body, selection) {
  if (!selection.supportsReasoning) return undefined;
  const nested = body.reasoning && typeof body.reasoning === 'object'
    ? body.reasoning.effort
    : undefined;
  return normalizeReasoningEffort(nested ?? body.reasoning_effort);
}

function createRequestTranslator({ config, describeImage, describeImageResult, extractFocusHint, validateImageReference, boundSystemContent, log, reasoningFor }) {
  const DEFAULT_MODEL = config.upstream.model;
  const MODEL_CATALOG = Array.isArray(config.catalog.entries) ? config.catalog.entries : [];
  const VISION_CHANNEL_NOTE = config.vision.channelNote;
  const VISION_FAILURE_NOTE = config.vision.failureNote;
  const FALLBACK_REASONING = config.reasoning.fallback;
  const NUDGE_RETRIES = config.recovery.nudgeRetries;
  const EXECUTION_DIRECTIVE = config.recovery.executionDirective;
  const toolProfile = resolveToolProfile(config.tools.profile);
  const toolSearchMode = config.tools.toolSearchMode || (toolProfile.name === 'generic' ? 'client' : 'direct');
  const TOOL_SEARCH_DIRECTIVE = config.recovery.toolSearchDirective ||
    'No invoques tool_search en este perfil. Usa directamente las herramientas ya expuestas en esta solicitud.';

// Request translation: Responses request body -> chat/completions body
// ---------------------------------------------------------------------------

function normalizeOutput(output) {
  // Responses function_call_output.output can be:
  //   - a plain string
  //   - an array of content items [{type:"input_text", text}, ...]
  //   - an object { body: <string | content items> } (internal payload)
  let value = output;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'body' in value) {
    value = value.body;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((c) => (c && c.type === 'input_text' ? c.text : c && c.type === 'output_text' ? c.text : ''))
      .filter((t) => typeof t === 'string')
      .join('\n');
  }
  return String(value ?? '');
}

/**
 * Convert Responses content parts into chat content parts.
 *
 * input_image items are replaced by a text description produced by the vision
 * model (agent-vision-toolkit pattern): the image itself is NEVER forwarded to
 * the text-only main model. The vision model only receives the image + the
 * focus hint (the user's latest text) and its description is injected here.
 * All images in one message are described in parallel; on vision failure the
 * image is replaced by an explicit diagnostic note (fail-open), never breaking
 * the request or allowing the text-only model to infer that the image was empty.
 */
async function chatContentParts(content, focusHint, channelNote, nativeVision) {
  const textParts = [];
  const imageJobs = [];
  for (const c of content || []) {
    if (!c) continue;
    if (c.type === 'input_text' || c.type === 'output_text') {
      textParts.push({ type: 'text', text: c.text });
    } else if (c.type === 'input_image') {
      imageJobs.push(c);
    }
    // input_audio / encrypted_content: not supported locally -> skipped
  }
  if (!imageJobs.length) return textParts;

  // Native vision (Muse Spark 1.2): forward the validated image_url block to
  // the upstream so the multimodal model sees the image directly instead of a
  // lossy text description. Each image is fail-closed: an invalid reference
  // becomes an explicit diagnostic note, never a silent drop that the model
  // could misread as "the folder is empty".
  if (nativeVision) {
    const parts = textParts.slice();
    for (let i = 0; i < imageJobs.length; i++) {
      const image = imageJobs[i];
      try {
        validateImageReference(image.image_url);
        parts.push({ type: 'image_url', image_url: { url: image.image_url } });
      } catch {
        parts.push({
          type: 'text',
          text: formatVisionFailure(i + 1, { kind: 'validation', status: 'none', bytes: 0 }, VISION_FAILURE_NOTE),
        });
      }
    }
    return parts;
  }

  const descriptions = await Promise.all(imageJobs.map(async (c) => {
    try {
      validateImageReference(c.image_url);
    } catch {
      return { text: null, failure: { kind: 'validation', status: 'none', bytes: 0 } };
    }
    if (typeof describeImageResult === 'function') return describeImageResult(c.image_url, focusHint);
    const text = await describeImage(c.image_url, focusHint);
    return text ? { text, failure: null } : { text: null, failure: { kind: 'unknown', status: 'none', bytes: 0 } };
  }));
  const parts = [];
  // Channel note: tell the main model once per request that images arrive as
  // text (only when there actually is an image to describe).
  if (channelNote && !channelNote.sent) {
    channelNote.sent = true;
    parts.push({ type: 'text', text: VISION_CHANNEL_NOTE });
  }
  for (let i = 0; i < descriptions.length; i++) {
    const result = descriptions[i] || {};
    const desc = typeof result === 'string' ? result : result.text;
    parts.push(
      desc
        ? { type: 'text', text: `[Imagen ${i + 1} descrita por el modelo de visión:]
${desc}` }
        : { type: 'text', text: formatVisionFailure(i + 1, typeof result === 'string' ? null : result.failure, VISION_FAILURE_NOTE) }
    );
  }
  return parts;
}

function formatVisionFailure(index, failure, configuredNote) {
  const status = failure && Number.isSafeInteger(failure.status) ? ` HTTP ${failure.status}` : '';
  const detail = failure && failure.kind === 'validation'
    ? 'la referencia no pudo validarse'
    : failure && failure.kind === 'disabled'
      ? 'la visión está desactivada'
      : failure && failure.kind === 'http' && failure.status === 429
        ? 'el proveedor de visión está temporalmente limitado o sin cuota'
        : 'el proveedor de visión no devolvió una descripción';
  const prefix = configuredNote || '[visión] La imagen sí fue recibida por el bridge.';
  return `${prefix} [Imagen ${index} no descrita: ${detail}${status}. No concluyas que la imagen, carpeta o visualización está vacía; informa de esta limitación o continúa sin inventar su contenido.]`;
}

/**
 * True when the leading text of the content parts starts with `prefix`
 * (case-insensitive, after trimming). Used to detect supervisor reminders that
 * must be relayed as `user` messages instead of weak `system` ones.
 */
function partsStartWith(parts, prefix) {
  for (const p of parts) {
    if (p && typeof p.text === 'string' && p.text.trim()) {
      return p.text.trimStart().toLowerCase().startsWith(prefix.toLowerCase());
    }
  }
  return false;
}

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
 * The in-app browser plugin (control-in-app-browser skill) REQUIRES the Node
 * REPL `js` execution tool to run browser automation. In the app its callable
 * id is `mcp__node_repl__js`, but the app NEVER exposes it in body.tools: it
 * only surfaces it via tool_search discovery ("use tool discovery for
 * `node_repl js`"), and DeepSeek never performs tool_search. Without it the
 * model reads the skill, says it will locate the JS tool, and stalls forever
 * calling shell_command. The codex-desktop profile injects it here with the
 * real schema; generic clients keep their advertised toolset unchanged.
 */
const NODE_REPL_JS_TOOL = {
  type: 'function',
  function: {
    name: 'mcp__node_repl__js',
    description:
      'Run JavaScript in a persistent Node-backed kernel with top-level await. This is the JavaScript execution tool for the `node_repl` MCP server; use it whenever instructions say to use `node_repl`, the Node REPL MCP, or run Node REPL code. ' +
      'The runtime exposes nodeRepl.cwd, nodeRepl.homeDir, nodeRepl.tmpDir, nodeRepl.requestMeta, nodeRepl.setResponseMeta(...), and await nodeRepl.emitImage(...). ' +
      'Use nodeRepl.write(value) to add output without a newline; strings are unchanged, other values use console-style formatting. ' +
      'Top-level bindings persist across calls until js_reset; reuse existing bindings, use top-level `var` for reusable state that may be assigned again, or choose a fresh descriptive name. ' +
      'Use dynamic imports like await import("playwright") rather than filesystem paths. ' +
      'If timeout_ms is omitted, execution times out after 30000 ms (30 seconds); pass a larger timeout_ms for slow browser automation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript source to execute in the persistent Node-backed kernel. The code runs with top-level await and can use the `nodeRepl` helpers. Examples: nodeRepl.write(nodeRepl.cwd), const { chromium } = await import("playwright"), or await nodeRepl.emitImage(pngBuffer).',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
          description: 'Optional execution timeout in milliseconds. Defaults to 30000 (30 seconds) when omitted.',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description: 'Short user-facing description of what this code block is doing. Use a few words, for example `Inspect package metadata` or `Render chart preview`.',
        },
      },
      required: ['code'],
    },
  },
};

/**
 * The app's `automation_update` tool (dynamic namespace `codex_app`, name
 * `automation_update`) is how "guardar recuerdo" / recurring automations are
 * persisted. It has the SAME failure mode as the Node REPL tool: in app.asar
 * the builder Tgl() marks it `deferLoading:true` (its name is NOT in the
 * `Agl` eager set), so the app never includes it in body.tools - it only
 * materializes after the model performs tool_search, which DeepSeek never
 * does. The dispatcher (`case Lzn` in app.asar, offset 38461319) requires only
 * a local thread (A7(hostId), true in these sessions) and does NOT check
 * deferLoading, so injecting the tool here and routing the function_call with
 * namespace `codex_app` + name `automation_update` makes the app execute it.
 *
 * The schema below is faithful to the app's zod input (`Fzn` = union
 * discriminated by `mode`: view | create/suggested_create with kind
 * heartbeat|cron | update/suggested_update with id+kind | delete). Heartbeat
 * variants require EITHER `destination: 'thread'` OR `targetThreadId` (the
 * app's `azn` superRefine rejects with "Missing targetThreadId or
 * destination=thread").
 */
const AUTOMATION_UPDATE_TOOL = {
  type: 'function',
  function: {
    name: 'codex_app__automation_update',
    description:
      `Create, update, view, or delete recurring automations in the Codex app. ` +
      `Use this when the user asks for a scheduled task, automation, recurring run, repeated task, reminder, follow-up, monitor, ` +
      `or asks you to watch something, keep an eye on it, check back later, wake up later, notify them, or keep working later. ` +
      `Heartbeat automations are proactive follow-ups attached to the current local thread and are the default for recurring requests. ` +
      `Use a heartbeat unless the user explicitly asks for a new task per run or standalone project work. ` +
      `Cron automations run as standalone local jobs against one project; use list_projects to find its project id. ` +
      `Never write raw automation directives by hand, show raw RRULE strings to the user, or create a workaround cron automation for a thread heartbeat unless the user explicitly asks for that. ` +
      `For requests about existing automations, inspect $CODEX_HOME/automations/*/automation.toml to find matching automation ids by name or prompt. ` +
      `Prefer updating an existing automation over creating a duplicate. For updates, preserve existing fields unless the user asks to change them, ` +
      `and call automation_update with the resolved id and full updated fields. ` +
      `Treat requests such as 'don't notify me' or 'mute this automation' as notificationPolicy=failed_runs_only, ` +
      `and set notificationPolicy=null when the user asks to unmute. Keep notification preferences out of the automation prompt.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['create', 'suggested_create', 'view', 'update', 'suggested_update', 'delete'],
          description:
            'Which operation to perform: create (new automation), suggested_create (create that needs user review before saving), ' +
            'view (inspect an existing automation), update (modify an existing automation), suggested_update (update that needs review), or delete (remove an existing automation).',
        },
        id: {
          type: 'string',
          description:
            'Automation id. Required for mode=view, mode=update, mode=delete, and mode=suggested_update. Omit for mode=create and mode=suggested_create.',
        },
        kind: {
          type: 'string',
          enum: ['heartbeat', 'cron'],
          description:
            "heartbeat: recurring runs continue in this thread (default; use for reminders/recuerdos). " +
            "cron: each run starts a new task or standalone recurring work against a workspace (use only when the user explicitly asks).",
        },
        name: {
          type: 'string',
          description: 'Short human-readable automation name. If the user does not provide one, choose a concise name.',
        },
        prompt: {
          type: 'string',
          description:
            'The automation prompt. Describe only the task itself; do not include schedule, workspace, or thread details because those are provided separately. ' +
            'Keep it self-sufficient, include output expectations when useful, and do not ask it to write a file or announce nothing to do unless the user explicitly asked for that.',
        },
        rrule: {
          type: 'string',
          description:
            'RRULE schedule string. Interpret requested times in the user locale; for mode=create do not include DTSTART or convert local wall-clock times to UTC; ' +
            'encode them directly with FREQ, BYDAY, BYHOUR, and BYMINUTE. For updates preserve the existing value unless the user asks to change it. ' +
            'Cron automations use hourly interval or weekly schedules. Heartbeat automations attached to a thread can use minute-based intervals such as FREQ=MINUTELY;INTERVAL=30 or daily/weekly wall-clock schedules.',
        },
        status: {
          type: 'string',
          enum: ['ACTIVE', 'PAUSED'],
          description: 'One of ACTIVE or PAUSED. Default to ACTIVE unless the user asks to start paused.',
        },
        notificationPolicy: {
          type: ['string', 'null'],
          description:
            'Optional notification policy. Use failed_runs_only when the user asks to mute or suppress completed-run notifications. ' +
            "For updates, omit to preserve the existing value and use null only when the user explicitly asks to unmute. On create, omit for the existing default behavior.",
        },
        destination: {
          type: 'string',
          enum: ['local', 'thread', 'worktree'],
          description:
            "Optional automation destination. Use 'thread' for heartbeat automations attached to the current local thread. " +
            "For cron automations use 'local' or 'worktree'.",
        },
        targetThreadId: {
          type: 'string',
          description:
            'Target thread id for heartbeat automations. Prefer destination=thread for the current local thread instead of inventing or copying raw thread ids.',
        },
        projectId: {
          type: ['string', 'null'],
          description: 'Cron automations only. The target project id, or null for Threads. Use list_projects to find project ids.',
        },
        model: {
          type: ['string', 'null'],
          description: 'Model to use for cron automations.',
        },
        reasoningEffort: {
          type: ['string', 'null'],
          description: 'Reasoning effort to use for cron automations. One of none, minimal, low, medium, high, xhigh, max, or ultra.',
        },
        executionEnvironment: {
          type: 'string',
          enum: ['local', 'worktree'],
          description:
            'Cron automation execution environment. New automations must use local; updates may preserve worktree for existing automations.',
        },
        localEnvironmentConfigPath: {
          type: ['string', 'null'],
          description: 'Optional path to a local environment configuration for cron automations. Omit unless required.',
        },
      },
      oneOf: [
        { properties: { mode: { enum: ['view'] } }, required: ['mode', 'id'] },
        { properties: { mode: { enum: ['delete'] } }, required: ['mode', 'id'] },
        {
          properties: { mode: { enum: ['create', 'suggested_create'] }, kind: { enum: ['heartbeat'] } },
          required: ['mode', 'kind', 'name', 'prompt', 'rrule'],
        },
        {
          properties: { mode: { enum: ['create', 'suggested_create'] }, kind: { enum: ['cron'] } },
          required: ['mode', 'kind', 'name', 'prompt', 'rrule'],
        },
        {
          properties: { mode: { enum: ['update', 'suggested_update'] }, kind: { enum: ['heartbeat'] } },
          required: ['mode', 'kind', 'id'],
        },
        {
          properties: { mode: { enum: ['update', 'suggested_update'] }, kind: { enum: ['cron'] } },
          required: ['mode', 'kind', 'id'],
        },
      ],
    },
  },
};

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

function extractReasoningText(item) {
  const parts = [];
  for (const s of item.summary || []) {
    if (s && typeof s.text === 'string' && s.text) parts.push(s.text);
  }
  for (const c of item.content || []) {
    // Codex reasoning items carry `reasoning_text` content, not output_text.
    if (c && typeof c.text === 'string' && c.text &&
        (c.type === 'output_text' || c.type === 'input_text' || c.type === 'reasoning_text')) {
      parts.push(c.text);
    }
  }
  return parts.join('\n') || null;
}

async function translateRequest(body) {
  const messages = [];
  let latestVisibleUserText = '';
  const userToolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const requestedToolSearch = Array.isArray(body.tools) && body.tools.some((tool) => tool?.type === 'tool_search');
  const { tools, toolMap, customTools } = translateTools(body.tools, { toolSearchMode });
  let pendingReasoning = null; // reasoning item from Codex, attached to the next assistant tool_calls message
  const focusHint = extractFocusHint(body);
  const channelNote = { sent: false };
  // Selector de modelos: `body.model` (lo que el cliente eligió en el picker)
  // decide el modelo wire y si la imagen viaja nativa (visión) o como texto.
  const selection = resolveModelSelection(MODEL_CATALOG, body.model, DEFAULT_MODEL);
  const nativeVision = selection.nativeVision === true;
  const reasoningEffort = requestReasoningEffort(body, selection);

  if (body.instructions) {
    // El system de Codex Desktop (plugins del navegador, doc de tools) puede
    // ser enorme; se recorta para que el modelo no se sature y devuelva vacío.
    messages.push({ role: 'system', content: boundSystemContent(body.instructions) });
  }
  if (requestedToolSearch && toolSearchMode === 'direct') {
    messages.push({ role: 'system', content: TOOL_SEARCH_DIRECTIVE });
  }

  for (const item of body.input || []) {
    if (!item) continue;
    switch (item.type) {
      case 'message': {
        let role = item.role || 'user';
        if (role === 'developer' || role === 'system') role = 'system';
        const parts = await chatContentParts(item.content, focusHint, channelNote, nativeVision);
        if (parts.length) {
          if (role === 'user') {
            latestVisibleUserText = parts.map((part) => part?.text || '').filter(Boolean).join('\n');
          }
          // Supervisor reminders (injected by the codex-supervisor PostToolUse
          // hook as `additionalContext`, which Codex relays as a developer
          // message) must carry maximum weight for DeepSeek. Mid-conversation
          // `system` messages are treated as weak context and routinely ignored
          // (observed: the model skipped the "DEBES delegar" reminders). Relay
          // them as `user` messages instead, so they behave like a direct,
          // high-priority instruction.
          if (role === 'system' && partsStartWith(parts, 'Supervisor')) role = 'user';
          messages.push({ role, content: role === 'system' ? boundSystemContent(parts) : parts });
        }
        break;
      }
      case 'reasoning': {
        const txt = extractReasoningText(item);
        if (txt) {
          pendingReasoning = txt;
          log(`reasoning captured ${txt.length} chars`);
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        // custom_tool_call (freeform tools like apply_patch) arrive with the raw
        // payload in `input`; upstream chat format needs a function whose single
        // `input` string argument carries it.
        const isCustom = item.type === 'custom_tool_call';
        const name = isCustom
          ? item.name
          : item.namespace
            ? `${item.namespace}${item.name}`
            : item.name;
        const args = isCustom
          ? JSON.stringify({ input: typeof item.input === 'string' ? item.input : '' })
          : item.arguments || '{}';
        const tc = {
          id: item.call_id,
          type: 'function',
          function: { name, arguments: args },
        };
        const prev = messages[messages.length - 1];
        // Parallel tool calls: Codex sends one function_call item per call. DeepSeek
        // rejects consecutive assistant tool_calls messages (400 'reasoning_content
        // ... must be passed back'), so merge them into a single assistant message.
        if (prev && prev.role === 'assistant' && prev.tool_calls && prev.content === '') {
          // Merge parallel call into the same assistant message. If the cached
          // reasoning is missing on it, backfill from cache or fallback.
          if (!prev.reasoning_content) {
            prev.reasoning_content = reasoningFor(item.call_id) || FALLBACK_REASONING;
          }
          prev.tool_calls.push(tc);
        } else {
          const asst = { role: 'assistant', content: '', tool_calls: [tc] };
          if (pendingReasoning) {
            asst.reasoning_content = pendingReasoning;
            pendingReasoning = null;
          } else {
            // Codex didn't resend the reasoning item; reuse what we saw upstream.
            // The fallback guarantees DeepSeek never rejects for a missing field.
            asst.reasoning_content = reasoningFor(item.call_id) || FALLBACK_REASONING;
          }
          messages.push(asst);
        }
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: normalizeOutput(item.output) });
        break;
      }
      case 'agent_message': {
        // Multi-agent v2: when a spawn/send/followup carries plaintext
        // (encrypted_function_args: [] on the parent's function_call), the app
        // delivers the task to the subagent as an `agent_message` item whose
        // content is an envelope ("Message Type: NEW_TASK ... Payload:\n") plus
        // the task text. Surface it as a user message so the subagent actually
        // sees the task; otherwise it falls in `default` and is dropped, leaving
        // the subagent with only its role instructions.
        const parts = await chatContentParts(item.content, focusHint, channelNote, nativeVision);
        if (parts.length) {
          messages.push({ role: 'user', content: parts });
        } else if (typeof item.text === 'string' && item.text) {
          messages.push({ role: 'user', content: [{ type: 'text', text: item.text }] });
        }
        break;
      }
      case 'tool_search_output':
      case 'additional_tools': {
        // The app reports the tools it discovered via tool_search here. Codex
        // does NOT re-inject them into body.tools, so flatten them into
        // chat.tools (and toolMap) or the upstream model can never call the MCP
        // tool (e.g. mcp__node_repl__js for the in-app browser). The output item
        // itself has no chat representation, so it is consumed, not sent.
        const discovered = item.tools || item.output || item.items || [];
        for (const t of discovered) flattenOneTool(t, tools, toolMap, customTools);
        break;
      }
      default:
        // local_shell_call, compaction, web_search_call, ... -> not representable in chat format
        log(`skip input item type=${item.type}`);
    }
  }

  // Merge consecutive same-role messages without tool_calls (some chat APIs reject
  // adjacent same-role messages). Text content is concatenated. Tool messages are
  // NEVER merged: merging two tool responses would drop one tool_call_id and leave
  // a tool call without its response (400 from DeepSeek).
  const merged = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && prev.role !== 'tool' && !prev.tool_calls && !m.tool_calls) {
      const prevText = Array.isArray(prev.content)
        ? prev.content.map((p) => p.text || '').join('')
        : prev.content || '';
      const newText = Array.isArray(m.content)
        ? m.content.map((p) => p.text || '').join('')
        : m.content || '';
      prev.content = [{ type: 'text', text: prevText + newText }];
      continue;
    }
    merged.push({ ...m, content: m.content && !Array.isArray(m.content) ? m.content : m.content });
  }

  // DeepSeek requires tool messages to IMMEDIATELY follow the assistant message
  // that made the tool_calls. Codex/the app sometimes interleaves a system message
  // (e.g. the app-injected "Supervisor: ..." instruction) between a tool_call and
  // its output, which yields:
  //   "An assistant message with 'tool_calls' must be followed by tool messages
  //    responding to each 'tool_call_id'"
  // Move those interleaved system/user messages to just before the assistant so
  // the tool responses stay adjacent.
  const reorder = [];
  let i = 0;
  while (i < merged.length) {
    const m = merged[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const need = m.tool_calls.length;
      let j = i + 1;
      const moved = [];
      const tools = [];
      while (j < merged.length) {
        const n = merged[j];
        if (n.role === 'tool') {
          tools.push(n);
          j++;
        } else if ((n.role === 'system' || n.role === 'user') && tools.length < need) {
          // Interleaved message that would break tool adjacency -> relocate before
          // the assistant message.
          moved.push(n);
          j++;
        } else {
          break;
        }
      }
      reorder.push(...moved, m, ...tools);
      i = j;
    } else {
      reorder.push(m);
      i++;
    }
  }
  const mergedFinal = reorder;

  const chat = {
    model: selection.id,
    messages: mergedFinal,
    stream: !!body.stream,
    stream_options: { include_usage: true },
  };
  if (tools.length) chat.tools = tools;
  // tools del usuario (sin las inyectadas node_repl/automation_update): solo con
  // ellas el hook de confirmación pregunta por el cierre. No-enumerable para que
  // JSON.stringify no la envíe a upstream.
  Object.defineProperty(chat, '__userTools', {
    value: userToolCount > 0,
    enumerable: false,
  });
  Object.defineProperty(chat, '__latestUserText', {
    value: latestVisibleUserText,
    enumerable: false,
  });
  if (typeof body.tool_choice === 'string' && body.tool_choice) chat.tool_choice = body.tool_choice;
  if (typeof body.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  if (reasoningEffort) chat.reasoning_effort = reasoningEffort;

  // Anti falso-complete (capa preventiva, 2026-08-10): con tools disponibles y
  // una conversación real, recordamos al modelo ejecutar en este turno. Mensaje
  // system propio al final (no muta el system de Codex ni el recorte de
  // boundSystemContent). El guard de messages evita "crear" conversación desde
  // un payload inválido vacío (que debe seguir siendo 400 invalid_request).
  if (chat.messages.length > 0 && chat.tools && chat.tools.length && NUDGE_RETRIES > 0) {
    chat.messages.push({ role: 'system', content: EXECUTION_DIRECTIVE });
  }

  return { chat, toolMap, customTools };
}

// ---------------------------------------------------------------------------

  return { translateRequest, translateTools, flattenOneTool, normalizeOutput };
}

module.exports = { createRequestTranslator, normalizeReasoningEffort, requestReasoningEffort };
