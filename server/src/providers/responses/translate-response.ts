import type { ChatCompletionResponse, ChatToolCall, TokenUsage } from '@gloryapi/shared/types.js';
import type { ResponsesReasoningItem } from './reasoning-cache.js';
import { coerceIntegralFloatArgs } from './coerce-tool-args.js';

/**
 * Translate a non-streaming OpenAI Responses API response into the
 * chat/completions contract the rest of GloryAPI consumes. The bridge (or any
 * chat-completions client) already handles `reasoning_content` and
 * `tool_calls`, so the reasoning summaries and function_call items map onto
 * the chat message shape.
 *
 * The opaque `reasoning` items (`id` + `encrypted_content`) are NOT part of
 * the chat contract; use `extractReasoningItems` to capture them for the
 * stateless replay of the next turn. They must never be logged or persisted.
 */

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageFrom(usage: Record<string, unknown> | undefined): TokenUsage {
  const inputDetails = (usage?.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (usage?.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    prompt_tokens: numberOrZero(usage?.input_tokens),
    completion_tokens: numberOrZero(usage?.output_tokens),
    total_tokens: numberOrZero(usage?.total_tokens),
    completion_tokens_details: { reasoning_tokens: numberOrZero(outputDetails.reasoning_tokens) },
    prompt_tokens_details: { cached_tokens: numberOrZero(inputDetails.cached_tokens) },
  };
}

/** Extract the opaque reasoning state for the next-turn replay. Bounded and
 * fail-open: invalid/oversized items are dropped, never thrown. The `summary`
 * array is preserved because the gateway requires it back on replay. */
export function extractReasoningItems(json: unknown): ResponsesReasoningItem[] {
  const record = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const output = Array.isArray(record.output) ? (record.output as Array<Record<string, unknown>>) : [];
  const items: ResponsesReasoningItem[] = [];
  let bytes = 0;
  for (const item of output) {
    if (items.length >= 8 || bytes >= 32 * 1024) break;
    if (!item || typeof item !== 'object' || item.type !== 'reasoning') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const blob = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
    if (!id || !blob) continue;
    bytes += Buffer.byteLength(blob, 'utf8');
    if (bytes > 32 * 1024) break;
    items.push({ id, encrypted_content: blob, summary: Array.isArray(item.summary) ? (item.summary as unknown[]) : [] });
  }
  return items;
}

export function translateResponsesResponse(json: unknown, upstreamModel: string): ChatCompletionResponse {
  const record = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const output = Array.isArray(record.output) ? (record.output as Array<Record<string, unknown>>) : [];

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'message': {
        const content = item.content;
        if (typeof content === 'string') {
          if (content) textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const part of content as Array<Record<string, unknown>>) {
            if ((part.type === 'output_text' || part.type === 'input_text') && typeof part.text === 'string') {
              textParts.push(part.text);
            }
          }
        }
        break;
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? (item.summary as Array<Record<string, unknown>>) : [];
        for (const entry of summary) {
          if (entry?.type === 'summary_text' && typeof entry.text === 'string' && entry.text) reasoningParts.push(entry.text);
        }
        const content = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [];
        for (const entry of content) {
          if (entry && typeof entry.text === 'string' && entry.text) reasoningParts.push(entry.text);
        }
        break;
      }
      case 'function_call': {
        // Downstream harnesses parse arguments against strict schemas
        // (e.g. `u64` rejects the `15000.0` some models emit). Integral
        // floats are numerically identical to ints, so normalize them here.
        const rawArgs = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
        toolCalls.push({
          id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${toolCalls.length + 1}`,
          type: 'function',
          function: {
            name: typeof item.name === 'string' ? item.name : '',
            arguments: coerceIntegralFloatArgs(rawArgs),
          },
        });
        break;
      }
      default:
        // web_search_call / local_shell_call / custom_tool_call / ... are not
        // representable in the chat contract and are intentionally dropped.
        break;
    }
  }

  const status = record.status;
  const incomplete = (record.incomplete_details && typeof record.incomplete_details === 'object')
    ? (record.incomplete_details as Record<string, unknown>).reason
    : null;
  let finishReason: string;
  if (toolCalls.length > 0) finishReason = 'tool_calls';
  else if (status === 'incomplete' && incomplete === 'max_output_tokens') finishReason = 'length';
  else finishReason = 'stop';

  const reasoning = reasoningParts.length > 0 ? reasoningParts.join('\n') : undefined;

  return {
    id: typeof record.id === 'string' && record.id ? record.id : `resp_${Date.now()}`,
    object: 'chat.completion',
    created: typeof record.created_at === 'number' ? record.created_at : Math.floor(Date.now() / 1000),
    model: typeof record.model === 'string' && record.model ? record.model : upstreamModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join('') || null,
          ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: usageFrom(record.usage as Record<string, unknown> | undefined),
  };
}