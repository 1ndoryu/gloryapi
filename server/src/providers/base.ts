import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@gloryapi/shared/types.js';
import { assertSafeUpstreamUrl } from '../services/endpoint-security.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max';
  /** Bounded metadata-only correlation id propagated to compatible upstreams. */
  requestId?: string;
  signal?: AbortSignal;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string): Promise<boolean>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
    signal?: AbortSignal,
  ): Promise<Response> {
    await assertSafeUpstreamUrl(url);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
