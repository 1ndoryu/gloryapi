import type { ChatCompletionChunk, TokenUsage } from '@gloryapi/shared/types.js';
import { SseParserError, SseStreamParser } from '../../lib/sse-parser.js';
import type { CompletionOptions } from '../base.js';
import type { ResponsesReasoningItem } from './reasoning-cache.js';
import { coerceIntegralFloatArgs } from './coerce-tool-args.js';

class StreamError extends Error {
  retryable = true;
  streamAbort = true;
  cancelled = false;
}

/**
 * Translate an OpenAI Responses API SSE stream (the wire protocol that
 * OpenCode Go uses for Muse Spark) into chat/completions chunks.
 *
 * Event mapping:
 *   - response.output_text.delta          -> delta.content
 *   - response.reasoning_summary_text.delta / reasoning_text.delta -> delta.reasoning_content
 *   - response.function_call_arguments.delta -> delta.tool_calls (indexed by item)
 *   - response.completed                  -> final chunk (finish_reason + usage)
 *   - response.failed / error             -> retryable StreamError so the
 *     router falls back to the next candidate.
 */
export async function* translateResponsesStream(args: {
  response: Response;
  providerName: string;
  upstreamModel: string;
  options?: CompletionOptions;
  /** Side-channel for the opaque reasoning replay: populated on `response.completed`
   * without altering the chat chunks. Never logged; memory-only in the caller cache. */
  collector?: { reasoningItems?: ResponsesReasoningItem[] };
}): AsyncGenerator<ChatCompletionChunk> {
  const { response, providerName, upstreamModel, options, collector } = args;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const sseParser = new SseStreamParser();
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let sawSse = false;
  let completed = false;
  let failed = false;
  let failureMessage = '';
  let usage: TokenUsage | undefined;
  let finishReason: string | null = null;
  const toolStates = new Map<string, { index: number; id: string; name: string; args: string; announced: boolean; flushed: boolean }>();
  const reasoningById = new Map<string, string>();
  const reasoningSummaryById = new Map<string, unknown[]>();

  // Argument deltas are BUFFERED per tool item and emitted once, coerced,
  // when the call completes. Chat clients append arguments, so a chunk split
  // mid-number (e.g. `15000` + `.0`) cannot be normalized safely delta by
  // delta; worse, models sometimes emit integral floats (`15000.0`) that
  // strict downstream schemas (`u64`) reject, looping the session. The
  // announce (id + name, empty args) still goes out as soon as the name is
  // known so clients see the call start promptly.
  const announce = function* (state: { index: number; id: string; name: string; announced: boolean }): Generator<ChatCompletionChunk> {
    if (state.announced || !state.name) return;
    state.announced = true;
    yield base({
      tool_calls: [{
        index: state.index,
        id: state.id,
        type: 'function',
        function: { name: state.name, arguments: '' },
      }],
    });
  };
  const flushToolCall = function* (state: { index: number; id: string; name: string; args: string; announced: boolean; flushed: boolean }): Generator<ChatCompletionChunk> {
    if (state.flushed) return;
    state.flushed = true;
    const args = coerceIntegralFloatArgs(state.args || '{}');
    if (!state.announced) {
      state.announced = true;
      yield base({
        tool_calls: [{
          index: state.index,
          id: state.id,
          type: 'function',
          function: { name: state.name, arguments: args },
        }],
      });
    } else {
      yield base({
        tool_calls: [{
          index: state.index,
          type: 'function',
          function: { arguments: args },
        }],
      });
    }
  };

  const base = (delta: Record<string, unknown>): ChatCompletionChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: upstreamModel,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  const terminal = (delta: Record<string, unknown>, finish: string | null, finalUsage?: TokenUsage): ChatCompletionChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: upstreamModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finalUsage ? { usage: finalUsage } : {}),
  });

  const readChunk = async () => {
    if (options?.signal?.aborted) {
      const error = new StreamError(`${providerName}: stream cancelled`);
      error.cancelled = true;
      throw error;
    }
    try {
      return await reader.read();
    } catch (error) {
      if (options?.signal?.aborted) {
        const abortError = new StreamError(`${providerName}: stream cancelled`);
        abortError.cancelled = true;
        throw abortError;
      }
      throw error;
    }
  };

  // Opening role chunk, mirroring chat-completions stream convention.
  yield base({ role: 'assistant' });

  while (true) {
    const { done, value } = await readChunk();
    if (done) break;
    let frames: string[];
    try {
      frames = sseParser.push(value);
    } catch (error) {
      const code = error instanceof SseParserError ? error.code : 'parser';
      const streamError = new StreamError(`${providerName}: invalid SSE stream (${code})`);
      throw streamError;
    }
    for (const data of frames) {
      sawSse = true;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        const streamError = new StreamError(`${providerName}: malformed SSE JSON`);
        throw streamError;
      }
      if (!event || typeof event !== 'object') continue;
      const type = event.type;

      if (type === 'response.output_item.added') {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'reasoning') {
          const rid = typeof item.id === 'string' && item.id ? item.id : (typeof event.item_id === 'string' ? String(event.item_id) : '');
          if (rid && !reasoningById.has(rid)) reasoningById.set(rid, '');
          const blob = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
          if (rid && blob) reasoningById.set(rid, blob);
          if (rid && Array.isArray(item.summary)) reasoningSummaryById.set(rid, item.summary as unknown[]);
        }
        if (item?.type === 'function_call') {
          // The item id/name live inside `item` on this event (there is no
          // top-level `item_id`); the later function_call_arguments.delta
          // events reference the same id as top-level `item_id`. Keying the
          // state by anything else (e.g. event.item_id) creates a miss and a
          // fallback state with an empty name, so the chat client receives a
          // tool call it cannot resolve (`The tool "" does not exist`).
          const itemId = String((item.id ?? event.item_id) ?? '');
          let state = toolStates.get(itemId);
          if (!state) {
            state = {
              index: Number.isInteger(event.output_index) ? Number(event.output_index) : toolStates.size,
              id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${toolStates.size + 1}`,
              name: typeof item.name === 'string' ? item.name : '',
              args: '',
              announced: false,
              flushed: false,
            };
            toolStates.set(itemId, state);
          } else if (typeof item.name === 'string' && item.name && !state.name) {
            state.name = item.name;
          }
          yield* announce(state);
        }
        continue;
      }

      if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
        yield base({ content: event.delta });
        continue;
      }

      if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta')
        && typeof event.delta === 'string' && event.delta) {
        yield base({ reasoning_content: event.delta });
        continue;
      }

      if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const itemId = String(event.item_id ?? '');
        let state = toolStates.get(itemId);
        if (!state) {
          state = {
            index: Number.isInteger(event.output_index) ? Number(event.output_index) : toolStates.size,
            id: `call_${toolStates.size + 1}`,
            name: '',
            args: '',
            announced: false,
            flushed: false,
          };
          toolStates.set(itemId, state);
        }
        if (type === 'response.function_call_arguments.delta') {
          state.args += typeof event.delta === 'string' ? event.delta : '';
          yield* announce(state);
        } else {
          // The done event carries the authoritative final arguments and the
          // tool name: flush the buffered (coerced) call exactly once.
          if (typeof event.arguments === 'string') state.args = event.arguments;
          if (typeof event.name === 'string' && event.name) state.name = event.name;
          yield* flushToolCall(state);
        }
        continue;
      }

      if (type === 'response.output_item.done') {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'reasoning') {
          const rid = String((item.id ?? event.item_id) ?? '');
          const blob = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
          if (rid && blob) reasoningById.set(rid, blob);
          else if (rid && !reasoningById.has(rid)) reasoningById.set(rid, '');
          if (rid && Array.isArray(item.summary)) reasoningSummaryById.set(rid, item.summary as unknown[]);
        }
        if (item?.type === 'function_call') {
          // Terminal item: backfill name/args for any state that only saw
          // argument deltas (belt-and-braces for gateways that omit the name
          // on the added/done-arguments events). If the arguments-done event
          // never arrived, this is also the flush point for the buffered call.
          const itemId = String((item.id ?? event.item_id) ?? '');
          const state = toolStates.get(itemId);
          if (state && !state.flushed) {
            if (typeof item.name === 'string' && item.name) state.name = item.name;
            if (typeof item.arguments === 'string' && item.arguments) state.args = item.arguments;
            if (state.name && (state.args || typeof item.arguments === 'string')) {
              yield* flushToolCall(state);
            }
          }
        }
        continue;
      }

      if (type === 'response.completed' || type === 'response.incomplete') {
        completed = true;
        const response = (event.response ?? {}) as Record<string, unknown>;
        const status = typeof response.status === 'string' ? response.status : (type === 'response.incomplete' ? 'incomplete' : 'completed');
        const incompleteReason = (response.incomplete_details && typeof response.incomplete_details === 'object')
          ? (response.incomplete_details as Record<string, unknown>).reason
          : null;
        const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
        for (const outItem of output) {
          if (!outItem || typeof outItem !== 'object' || outItem.type !== 'reasoning') continue;
          const rid = typeof outItem.id === 'string' ? outItem.id : '';
          const blob = typeof outItem.encrypted_content === 'string' ? outItem.encrypted_content : '';
          if (rid && blob) reasoningById.set(rid, blob);
          if (rid && Array.isArray(outItem.summary)) reasoningSummaryById.set(rid, outItem.summary as unknown[]);
        }
        // Safety net: a tool call whose done events never arrived (truncated
        // item stream) still reaches the client with its buffered arguments
        // instead of being silently dropped.
        for (const state of toolStates.values()) {
          if (!state.flushed && (state.args || state.announced)) {
            yield* flushToolCall(state);
          }
        }
        const hasToolCalls = output.some(item => item?.type === 'function_call');
        if (hasToolCalls) finishReason = 'tool_calls';
        else if (status === 'incomplete' && incompleteReason === 'max_output_tokens') finishReason = 'length';
        else finishReason = 'stop';
        const rawUsage = response.usage as Record<string, unknown> | undefined;
        if (rawUsage) {
          const inputDetails = (rawUsage.input_tokens_details ?? {}) as Record<string, unknown>;
          const outputDetails = (rawUsage.output_tokens_details ?? {}) as Record<string, unknown>;
          usage = {
            prompt_tokens: typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : 0,
            completion_tokens: typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : 0,
            total_tokens: typeof rawUsage.total_tokens === 'number' ? rawUsage.total_tokens : 0,
            completion_tokens_details: { reasoning_tokens: typeof outputDetails.reasoning_tokens === 'number' ? outputDetails.reasoning_tokens : 0 },
            prompt_tokens_details: { cached_tokens: typeof inputDetails.cached_tokens === 'number' ? inputDetails.cached_tokens : 0 },
          };
        }
        continue;
      }

      if (type === 'response.failed') {
        failed = true;
        const response = (event.response ?? {}) as Record<string, unknown>;
        const error = response.error as Record<string, unknown> | undefined;
        failureMessage = error && typeof error.message === 'string' ? error.message : 'responses stream failed';
        break;
      }

      if (type === 'error') {
        failed = true;
        failureMessage = typeof event.message === 'string' ? event.message : 'unknown error';
        break;
      }
    }
    if (failed) break;
  }

  try {
    sseParser.finish();
  } catch (error) {
    const code = error instanceof SseParserError ? error.code : 'parser';
    if (!completed) {
      const streamError = new StreamError(`${providerName}: invalid SSE stream (${code})`);
      throw streamError;
    }
  }

  if (failed) {
    const streamError = new StreamError(`${providerName}: ${failureMessage || 'responses stream failed'}`);
    throw streamError;
  }
  if (!sawSse) {
    const streamError = new StreamError(`${providerName}: empty response (no SSE data)`);
    throw streamError;
  }
  if (!completed) {
    const streamError = new StreamError(`${providerName}: stream truncated (no response.completed)`);
    console.error(`[${providerName}] stream truncated (no response.completed)`);
    throw streamError;
  }

  if (collector) {
    const items: ResponsesReasoningItem[] = [];
    let bytes = 0;
    for (const [id, blob] of reasoningById) {
      if (items.length >= 8 || bytes >= 32 * 1024) break;
      if (!id || !blob) continue;
      bytes += Buffer.byteLength(blob, 'utf8');
      if (bytes > 32 * 1024) break;
      items.push({ id, encrypted_content: blob, summary: reasoningSummaryById.get(id) ?? [] });
    }
    if (items.length > 0) collector.reasoningItems = items;
  }

  yield terminal({}, finishReason ?? 'stop', usage);
}