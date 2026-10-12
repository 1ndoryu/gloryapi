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

module.exports = { NODE_REPL_JS_TOOL, AUTOMATION_UPDATE_TOOL };
