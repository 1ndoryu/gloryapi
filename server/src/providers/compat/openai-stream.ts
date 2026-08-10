import type { ChatCompletionChunk } from '@gloryapi/shared/types.js';
import type { CompletionOptions } from '../base.js';
import { assertEffectiveModel } from './model-identity.js';
import { SseParserError, SseStreamParser } from '../../lib/sse-parser.js';

class StreamError extends Error {
  retryable = false;
  streamAbort = false;
  cancelled = false;
}

type StreamArgs = {
  response: Response;
  providerName: string;
  upstreamModel: string;
  options?: CompletionOptions;
  bufferUntilContent: boolean;
  bufferUntilDone: boolean;
  hasTools: boolean;
};

/** Consume one OpenAI-compatible SSE stream and enforce its completion contract. */
export async function* streamOpenAICompatStream(args: StreamArgs): AsyncGenerator<ChatCompletionChunk> {
  const { response, providerName, upstreamModel, options, bufferUntilContent, bufferUntilDone, hasTools } = args;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const sseParser = new SseStreamParser();
    let sawSse = false;
    let sawContent = false;
    // Text deltas seen (vs tool_calls deltas, which are valid but stay buffered
    // until [DONE] so a truncated tool_calls stream can fall back).
    let sawTextContent = false;
    // Stream diagnostics — attached to failure messages so the dashboard log
    // shows whether the upstream sent nothing at all, only reasoning, or cut
    // mid-stream (and how long it waited before the first chunk).
    const streamStart = Date.now();
    const stats = {
      chunks: 0,
      reasoningDeltas: 0,
      toolCallDeltas: 0,
      contentDeltas: 0,
      firstChunkAt: 0,
      lastChunkAt: 0,
      done: false,
      bytes: 0,
    };
    const statsStr = () =>
      `[chunks=${stats.chunks} reasoning=${stats.reasoningDeltas} tool_calls=${stats.toolCallDeltas} ` +
      `content=${stats.contentDeltas} first_chunk=${stats.firstChunkAt}ms last_chunk=${stats.lastChunkAt}ms ` +
      `done=${stats.done} bytes=${stats.bytes}]`;
    // Reasoning-only chunks held back until the first real content delta
    // (only used when bufferUntilContent is enabled).
    const pending: ChatCompletionChunk[] = [];
    const flushPending = function* (): Generator<ChatCompletionChunk> {
      while (pending.length > 0) yield pending.shift()!;
    };
    const cancellationError = () => {
      const error = new StreamError(`${providerName}: stream cancelled`);
      error.cancelled = true;
      error.streamAbort = true;
      return error;
    };
    const readChunk = async () => {
      if (options?.signal?.aborted) throw cancellationError();
      try {
        return await reader.read();
      } catch (error) {
        if (options?.signal?.aborted) throw cancellationError();
        throw error;
      }
    };

    while (true) {
      const { done, value } = await readChunk();
      if (done) break;
      stats.bytes += value.length;

      let frames: string[];
      try {
        frames = sseParser.push(value);
      } catch (error) {
        const code = error instanceof SseParserError ? error.code : 'parser';
        const streamError = new StreamError(`${providerName}: invalid SSE stream (${code})`);
        streamError.retryable = true;
        streamError.streamAbort = true;
        throw streamError;
      }
      for (const data of frames) {
        if (data === '[DONE]') {
          stats.done = true;
          // Stream ended without any content or tool-call delta (e.g. a proxy
          // worker cut off mid-reasoning). Fail so the router falls back to
          // the next model instead of returning an empty stream to the client
          // ("Sorry, no response was returned"). Responses that contain only
          // tool_calls are valid and must NOT hit this branch.
          if ((bufferUntilDone || bufferUntilContent) && !sawContent) {
            const err = new StreamError(`${providerName}: stream ended without content ${statsStr()}`);
            err.retryable = true;
            err.streamAbort = true;
            console.error(`[${providerName}] stream ended without content ${statsStr()}`);
            throw err;
          }
          // Deliver buffered chunks now that the stream completed cleanly.
          if (bufferUntilDone || (bufferUntilContent && !sawTextContent)) {
            yield* flushPending();
          }
          return;
        }
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          const streamError = new StreamError(`${providerName}: malformed SSE JSON`);
          streamError.retryable = true;
          streamError.streamAbort = true;
          throw streamError;
        }
        if (!Array.isArray(chunk.choices)) {
          const streamError = new StreamError(`${providerName}: SSE chunk has no choices`);
          streamError.retryable = true;
          streamError.streamAbort = true;
          throw streamError;
        }
        try {
          assertEffectiveModel(chunk, upstreamModel, hasTools);
        } catch (error) {
          const identityError = error as StreamError;
          identityError.streamAbort = true;
          throw identityError;
        }
        sawSse = true;
        stats.chunks++;
        stats.lastChunkAt = Date.now() - streamStart;
        if (stats.firstChunkAt === 0) stats.firstChunkAt = stats.lastChunkAt;
        const delta = chunk.choices?.[0]?.delta;
        const content = delta?.content;
        const hasContent = typeof content === 'string' && content.length > 0;
        if (hasContent) stats.contentDeltas++;
        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) stats.reasoningDeltas++;
        // Tool-call deltas are valid stream content: a model may legitimately
        // answer with only reasoning + tool_calls (content=null). Treat them
        // like text content so bufferUntilContent doesn't discard the stream.
        const toolDeltas = delta?.tool_calls;
        const hasToolCalls = Array.isArray(toolDeltas) && toolDeltas.length > 0;
        if (hasToolCalls) stats.toolCallDeltas++;
        if (hasContent) sawTextContent = true;
        if (hasContent || hasToolCalls) sawContent = true;

        // bufferUntilDone: hold the ENTIRE stream back until [DONE] so any
        // failure (even mid-content) is still retryable and the router can
        // fall back — nothing reaches the client prematurely.
        // bufferUntilContent: buffer reasoning + tool_calls deltas until real
        // text starts flowing. Text streams live once started; tool_calls-only
        // streams stay buffered so a truncated one is still retryable.
        if (bufferUntilDone) {
          pending.push(chunk);
        } else if (bufferUntilContent && !sawTextContent) {
          pending.push(chunk);
        } else if (bufferUntilContent && sawTextContent) {
          yield* flushPending();
          yield chunk;
        } else {
          yield chunk;
        }
      }
    }
    try {
      sseParser.finish();
    } catch (error) {
      const code = error instanceof SseParserError ? error.code : 'parser';
      const streamError = new StreamError(`${providerName}: invalid SSE stream (${code})`);
      streamError.retryable = true;
      streamError.streamAbort = true;
      throw streamError;
    }

    // Upstream returned 200 with no parseable SSE at all (e.g. a JSON error
    // body from a proxy worker) — treat as failure so the router retries.
    if (!sawSse) {
      const err = new StreamError(`${providerName}: empty response (no SSE data) ${statsStr()}`);
      if (bufferUntilDone || bufferUntilContent) {
        err.retryable = true;
        err.streamAbort = true;
      }
      throw err;
    }

    // Stream closed without [DONE] — truncated. For bufferUntilDone/
    // bufferUntilContent providers this is abnormal: successful streams always
    // end with [DONE]. Nothing has been yielded to the client yet (everything
    // is buffered), so the router falls back to the next model.
    if (!stats.done) {
      const err = new StreamError(`${providerName}: stream truncated (no [DONE]) ${statsStr()}`);
      err.retryable = true;
      err.streamAbort = true;
      console.error(`[${providerName}] stream truncated (no [DONE]) ${statsStr()}`);
      throw err;
    }
}


