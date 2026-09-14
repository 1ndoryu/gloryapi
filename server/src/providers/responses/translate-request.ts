import type {
  ChatContent,
  ChatMessage,
  ChatToolDefinition,
  ChatToolChoice,
} from '@gloryapi/shared/types.js';
import type { CompletionOptions } from '../base.js';
import type { ResponsesReasoningItem } from './reasoning-cache.js';

/**
 * Translate a chat/completions request into the OpenAI Responses API request
 * body. OpenCode Go serves Muse Spark models (and Grok / GPT-5.6 Luna) only
 * through `/v1/responses`, so the provider adapter needs this inverse of the
 * bridge's Responses→chat translation when a model is pinned to the
 * `responses` endpoint kind.
 *
 * The mapping is intentionally lossy on fields that the Responses API does
 * not model (assistant `reasoning_content` history is dropped; images become
 * `input_image` parts so native vision is preserved). Tool calls follow the
 * Responses item shape: `function_call` + `function_call_output` items.
 *
 * Stateless multi-turn reasoning (same contract as the opencode CLI) needs
 * `store: false` + `include: ["reasoning.encrypted_content"]` plus a replay
 * of the previous turn's `reasoning` items at the front of `input`.
 */

export type ResponsesEndpointKind = 'chat' | 'responses';

const EFFORT_ORDER = ['low', 'medium', 'high', 'max'] as const;

/** Clamp the client effort against per-model/provider limits ('max' is
 * non-standard upstream, so it maps down). Shared shape with the chat
 * adapter's reasoning clamp so both transports agree. */
export function clampResponsesEffort(
  effort: string | undefined,
  modelId: string | undefined,
  limits: Map<string, 'low' | 'medium' | 'high' | 'max'>,
  providerMax: 'low' | 'medium' | 'high' | 'max',
): string | undefined {
  if (!effort) return undefined;
  const index = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  if (index < 0) return undefined;
  let limit = providerMax;
  if (modelId) {
    const lower = modelId.toLowerCase();
    for (const [pattern, value] of limits) {
      if (lower.includes(pattern.toLowerCase())) {
        limit = value;
        break;
      }
    }
  }
  const limitIndex = EFFORT_ORDER.indexOf(limit);
  return index > limitIndex ? limit : effort;
}

function contentParts(content: ChatContent): string | unknown[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'input_text' && typeof block.text === 'string') {
      parts.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'image_url' && block.image_url) {
      const url = typeof block.image_url === 'string'
        ? block.image_url
        : typeof block.image_url === 'object' && block.image_url && typeof (block.image_url as { url?: unknown }).url === 'string'
          ? (block.image_url as { url: string }).url
          : null;
      if (url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts;
}

function outputTextParts(content: ChatContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object')
    .map(block => (block.type === 'output_text' || block.type === 'text' || block.type === 'input_text' ? (block.text ?? '') : ''))
    .join('');
}

function translateMessages(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        items.push({ role: 'system', content: contentParts(message.content) });
        break;
      }
      case 'user': {
        items.push({ role: 'user', content: contentParts(message.content) });
        break;
      }
      case 'assistant': {
        const text = outputTextParts(message.content);
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        // An assistant turn with tool calls is represented as a text message
        // item (when it has text) followed by function_call items.
        if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        else if (toolCalls.length === 0 && message.content != null && message.content !== '') {
          items.push({ role: 'assistant', content: [{ type: 'output_text', text: String(message.content) }] });
        }
        for (const call of toolCalls) {
          items.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function?.name ?? '',
            arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
          });
        }
        break;
      }
      case 'tool': {
        items.push({
          type: 'function_call_output',
          call_id: message.tool_call_id ?? `call_${items.length}`,
          output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
        });
        break;
      }
      default:
        // Unknown roles cannot be represented; drop defensively.
        break;
    }
  }
  return items;
}

export const RESPONSES_INCLUDE_ENCRYPTED_REASONING = ['reasoning.encrypted_content'] as const;

/** Default output budget for the Responses transport when the chat client
 * sends no `max_tokens` (VS Code/Copilot omits it). Muse spends a large
 * share of the budget on encrypted reasoning; without a floor the visible
 * output is cut with `finish_reason: length`. Chat transports are untouched. */
export const DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS = 4096;

export function translateChatRequestToResponses(input: {
  model: string;
  messages: ChatMessage[];
  options?: CompletionOptions;
  reasoningEffort?: string;
  stream?: boolean;
  previousReasoning?: ResponsesReasoningItem[];
  /** Fail-open fallback: omit `store`/`include` and the replay when the
   * gateway rejects them as unknown parameters. */
  omitState?: boolean;
}): Record<string, unknown> {
  const { model, messages, options, reasoningEffort, stream, previousReasoning, omitState } = input;
  const history = translateMessages(messages);
  const replay: unknown[] = [];
  if (!omitState && Array.isArray(previousReasoning)) {
    for (const item of previousReasoning.slice(0, 8)) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.encrypted_content !== 'string' || !item.encrypted_content) continue;
      // The Go gateway rejects replayed reasoning without `summary`
      // (`input[0]` missing required field `summary`); the CLI replays the
      // stored item verbatim, which for Muse is `summary: []`.
      replay.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: Array.isArray(item.summary) ? item.summary : [] });
    }
  }
  const body: Record<string, unknown> = {
    model,
    input: [...replay, ...history],
    stream: stream === true,
  };
  if (!omitState) {
    body.store = false;
    body.include = [...RESPONSES_INCLUDE_ENCRYPTED_REASONING];
  }
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.top_p !== undefined) body.top_p = options.top_p;
  // The Go gateway rejects `max_output_tokens < 16`; the bridge completion
  // audit sends max_tokens: 8, which 400'd every audit against Muse (039A-1e).
  // Clamp to the gateway floor instead of failing the call.
  if (options?.max_tokens !== undefined) body.max_output_tokens = Math.max(16, options.max_tokens);
  else body.max_output_tokens = DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS;
  const tools = options?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    // The Responses API flattens the chat-completions function schema:
    // name/description/parameters are top-level siblings of `type` instead of
    // being nested under `function`. Only `function` tools are supported by
    // the gateway; any other tool type (web_search, custom, ...) makes the
    // whole request fail with "did not match any supported type", so those
    // tools are dropped instead of aborting the call.
    const converted: unknown[] = [];
    for (const tool of tools) {
      if (!tool || tool.type !== 'function' || !tool.function) continue;
      const fn = tool.function;
      if (typeof fn.name !== 'string' || !fn.name.trim()) continue;
      const flat: Record<string, unknown> = { type: 'function', name: fn.name };
      if (fn.description !== undefined) flat.description = fn.description;
      // The Meta gateway rejects tools that omit `parameters` with "did not
      // match any supported type", so a missing schema becomes an empty
      // object schema (same default the bridge applies to chat tools).
      flat.parameters = fn.parameters ?? { type: 'object', properties: {} };
      if (typeof fn.strict === 'boolean') flat.strict = fn.strict;
      converted.push(flat);
    }
    if (converted.length > 0) body.tools = converted as ChatToolDefinition[];
  }
  if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice as ChatToolChoice;
  if (options?.parallel_tool_calls !== undefined) body.parallel_tool_calls = options.parallel_tool_calls;
  // The Responses API reasons with effort levels up to 'high'; the chat-side
  // 'max' convention maps down here.
  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort === 'max' ? 'high' : reasoningEffort };
  }
  return body;
}