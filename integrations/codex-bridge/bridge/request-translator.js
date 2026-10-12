const { resolveToolProfile } = require('./tool-profile');
const { resolveModelSelection, resolvePresentationModel } = require('./model-catalog');
const { normalizeReasoningEffort, requestReasoningEffort, extractReasoningText } = require('./request-reasoning');
const { crearContent } = require('./request-content');
const { crearTools } = require('./request-tools');

function createRequestTranslator({ config, describeImage, describeImageResult, extractFocusHint, validateImageReference, boundSystemContent, log, reasoningFor }) {
  const DEFAULT_MODEL = config.upstream.model;
  const MODEL_CATALOG = Array.isArray(config.catalog.entries) ? config.catalog.entries : [];
  const VISION_CHANNEL_NOTE = config.vision.channelNote;
  const VISION_FAILURE_NOTE = config.vision.failureNote;
  const FALLBACK_REASONING = config.reasoning.fallback;
  const NUDGE_RETRIES = config.recovery.nudgeRetries;
  const EXECUTION_DIRECTIVE = config.recovery.executionDirective;
  const LOOP_DIRECTIVE = config.recovery.loopDirective || '';
  const toolProfile = resolveToolProfile(config.tools.profile);
  const toolSearchMode = config.tools.toolSearchMode || (toolProfile.name === 'generic' ? 'client' : 'direct');
  const TOOL_SEARCH_DIRECTIVE = config.recovery.toolSearchDirective ||
    'No invoques tool_search en este perfil. Usa directamente las herramientas ya expuestas en esta solicitud.';

  // content y tools son factorías que reciben solo su ctx; reasoning es top-level.
  const ctx = { log, describeImage, describeImageResult, validateImageReference, VISION_CHANNEL_NOTE, VISION_FAILURE_NOTE, toolProfile };
  const { normalizeOutput, chatContentParts, partsStartWith } = crearContent(ctx);
  const { translateTools, flattenOneTool } = crearTools(ctx);

// Request translation: Responses request body -> chat/completions body
// ---------------------------------------------------------------------------

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
  const presentationModel = resolvePresentationModel(MODEL_CATALOG, body.model);
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
  // Codex Desktop calculates the context indicator from the response model
  // slug. Keep the physical wire model for GloryAPI, but persist the catalog
  // picker id so old routed ids cannot trigger the Desktop default window.
  Object.defineProperty(chat, '__bridgePresentationModel', {
    value: presentationModel,
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
  // Anti-loop master prompt (039A-1d): own trailing system message, next to
  // the execution directive (never mutates Codex's system). Gated only on
  // its own text — independent of NUDGE_RETRIES — so stub configs without it
  // simply skip it. The empty-payload guard above still applies: no
  // conversation is created from an invalid empty body.
  if (chat.messages.length > 0 && chat.tools && chat.tools.length && LOOP_DIRECTIVE) {
    chat.messages.push({ role: 'system', content: LOOP_DIRECTIVE });
  }

  return { chat, toolMap, customTools };
}

// ---------------------------------------------------------------------------

  return { translateRequest, translateTools, flattenOneTool, normalizeOutput };
}

module.exports = { createRequestTranslator, normalizeReasoningEffort, requestReasoningEffort };
