import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@gloryapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureReasoningContent as addReasoningContent,
  normalizeChoices,
  replaceNullAssistantContent as normalizeNullAssistantContent,
} from './openai-message-normalization.js';
import { getProviderErrorMessage } from './error-response.js';
import { assertEffectiveModel, createModelIdentityError, extractEffectiveModel } from './compat/model-identity.js';
import { getEffectiveProviderModelSettings } from '../settings/registry.js';
import { getDb } from '../db/index.js';
import { getConfiguredProviderFromDb } from '../services/provider-configuration.js';
import { streamOpenAICompatStream } from './compat/openai-stream.js';

export function replaceNullAssistantContent(messages: ChatMessage[]): ChatMessage[] {
  return normalizeNullAssistantContent(messages);
}

export function ensureReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return addReasoningContent(messages);
}

const FAILED_REQUESTS_LOG = process.env.GLORYAPI_FAILED_REQUESTS_LOG
  ? process.env.GLORYAPI_FAILED_REQUESTS_LOG
  : join(dirname(fileURLToPath(import.meta.url)), '../../data/failed_requests.log');

class StreamError extends Error {
  retryable = false;
  streamAbort = false;
  cancelled = false;
}

function logFailedRequest(provider: string, status: number, body: unknown, errorText: string): void {
  try {
    mkdirSync(dirname(FAILED_REQUESTS_LOG), { recursive: true });
    appendFileSync(FAILED_REQUESTS_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      provider,
      status,
      body,
      error: errorText.slice(0, 2000),
    }) + '\n');
  } catch (e) {
    console.error(`[${provider}] failed to write ${FAILED_REQUESTS_LOG}:`, e);
  }
}

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  private readonly prepareMessages?: (messages: ChatMessage[]) => ChatMessage[];
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;
  /** Default maximum reasoning_effort for this provider. */
  private readonly maxReasoningEffort: 'low' | 'medium' | 'high' | 'max';
  /** Per-model overrides for max reasoning_effort. Keys are substrings to match
   * against the model ID (case-insensitive). First match wins. */
  private readonly modelReasoningLimits: Map<string, 'low' | 'medium' | 'high' | 'max'>;
  /** Map client-facing model_id → upstream model_id. Lets the catalog expose
   * a bare ID (e.g. `deepseek-v4-flash`) while the provider's API requires a
   * prefixed one (e.g. `deepseek/deepseek-v4-flash`). */
  private readonly modelAliases: Record<string, string>;
  /** Buffer reasoning-only deltas and only start forwarding once a real
   * content delta arrives. If the upstream stream ends without ever emitting
   * content (e.g. a proxy worker hitting its wall-time limit mid-reasoning),
   * throw so the router falls back to the next model instead of returning an
   * empty stream to the client ("Sorry, no response was returned"). */
  private readonly bufferUntilContent: boolean;
  /** Buffer the ENTIRE stream and only forward once the upstream finishes with
   * [DONE]. Any failure (including cuts mid-content) happens before anything
   * reaches the client, so the router can always fall back to the next model.
   * Trade-off: no live streaming from this provider. */
  private readonly bufferUntilDone: boolean;
  /** Ask providers that support it for the terminal usage SSE frame. */
  private readonly includeStreamUsage: boolean;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    prepareMessages?: (messages: ChatMessage[]) => ChatMessage[];
    timeoutMs?: number;
    maxReasoningEffort?: 'low' | 'medium' | 'high' | 'max';
    modelReasoningLimits?: Record<string, 'low' | 'medium' | 'high' | 'max'>;
    modelAliases?: Record<string, string>;
    bufferUntilContent?: boolean;
    bufferUntilDone?: boolean;
    includeStreamUsage?: boolean;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.prepareMessages = opts.prepareMessages;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxReasoningEffort = opts.maxReasoningEffort ?? 'high';
    this.modelReasoningLimits = new Map(Object.entries(opts.modelReasoningLimits ?? {}));
    this.modelAliases = opts.modelAliases ?? {};
    this.bufferUntilContent = opts.bufferUntilContent ?? false;
    this.bufferUntilDone = opts.bufferUntilDone ?? false;
    this.includeStreamUsage = opts.includeStreamUsage ?? false;
  }

  private effectiveTransport(modelId?: string): { baseUrl: string; timeoutMs: number; modelAlias: string | null } {
    // The isolated canary may point active adapters at a
    // loopback fixture. It is opt-in, loopback-only, and rejected unless the
    // process explicitly declares canary mode; production routing keeps the
    // registered HTTPS endpoint and settings validation unchanged.
    const canaryUrl = process.env.GLORYAPI_CANARY_UPSTREAM_URL?.trim();
    const canaryPlatforms = new Set(['andoryyu', 'opencode-zen', 'opencode-go']);
    if (canaryUrl && process.env.GLORYAPI_CANARY_MODE === '1' && canaryPlatforms.has(this.platform)) {
      let parsed: URL;
      try {
        parsed = new URL(canaryUrl);
      } catch {
        throw new Error('Invalid canary upstream URL');
      }
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
        throw new Error('Canary upstream must use loopback HTTP');
      }
      return {
        baseUrl: canaryUrl.replace(/\/$/, ''),
        timeoutMs: this.timeoutMs,
        modelAlias: null,
      };
    }

    try {
      const configured = getConfiguredProviderFromDb(getDb(), this.platform);
      if (configured && configured.enabled && configured.lifecycle === 'active') {
        return {
          baseUrl: configured.endpoint,
          timeoutMs: configured.timeoutMs,
          modelAlias: modelId ? configured.transport.modelAliases[modelId] ?? null : null,
        };
      }
    } catch {
      // Isolated provider tests may call an adapter before DB initialization.
    }

    try {
      const configured = getEffectiveProviderModelSettings(this.platform, modelId);
      if (configured) {
        if (configured.authScheme !== 'bearer') {
          throw new Error(`${this.name} does not support the configured authentication scheme`);
        }
        return configured;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('authentication scheme')) throw error;
      // Isolated adapter unit tests may not initialize SQLite; static adapter
      // defaults remain safe and deterministic in that context.
    }
    return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, modelAlias: null };
  }

  /* Map the catalog model_id to the upstream model ID if an alias exists. */
  private upstreamModelId(modelId: string, transport = this.effectiveTransport(modelId)): string {
    const configuredModel = transport.modelAlias ?? modelId;
    return this.modelAliases[configuredModel] ?? configuredModel;
  }

  /* Clamp reasoning_effort. Checks per-model limits first (substring match on
   * model ID), then falls back to the provider default. 'max' is non-standard;
   * models/providers that don't support it get it mapped down. */
  private clampReasoningEffort(effort?: string, modelId?: string): string | undefined {
    if (!effort) return undefined;
    const order = ['low', 'medium', 'high', 'max'];
    const curIdx = order.indexOf(effort);
    if (curIdx < 0) return undefined;

    // Check per-model overrides first
    if (modelId) {
      const lowerModel = modelId.toLowerCase();
      for (const [pattern, limit] of this.modelReasoningLimits) {
        if (lowerModel.includes(pattern.toLowerCase())) {
          const limitIdx = order.indexOf(limit);
          return curIdx > limitIdx ? limit : effort;
        }
      }
    }

    // Fall back to provider default
    const maxIdx = order.indexOf(this.maxReasoningEffort);
    return curIdx > maxIdx ? this.maxReasoningEffort : effort;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const requestMessages = this.prepareMessages ? this.prepareMessages(messages) : messages;
    const transport = this.effectiveTransport(modelId);
    const upstreamModel = this.upstreamModelId(modelId, transport);
    const res = await this.fetchWithTimeout(`${transport.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
        ...(options?.requestId ? { 'X-Glory-Request-Id': options.requestId } : {}),
      },
      body: JSON.stringify({
        model: upstreamModel,
        messages: requestMessages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        ...(options?.reasoning_effort ? { reasoning_effort: this.clampReasoningEffort(options.reasoning_effort, modelId) } : {}),
      }),
    }, transport.timeoutMs, options?.signal);

    if (!res.ok) {
      const err: unknown = await res.json().catch(() => null);
      const effectiveModel = extractEffectiveModel(err);
      if (effectiveModel && effectiveModel.toLowerCase() !== upstreamModel.toLowerCase()) {
        throw createModelIdentityError(upstreamModel, effectiveModel, Boolean(options?.tools?.length));
      }
      const msg = `${this.name} API error ${res.status}: ${getProviderErrorMessage(err, res.statusText)}`;
      logFailedRequest(this.platform, res.status, { model: upstreamModel, messages: requestMessages, options }, msg);
      throw new Error(msg);
    }

    const data = await res.json() as ChatCompletionResponse;
    assertEffectiveModel(data, upstreamModel, Boolean(options?.tools?.length));
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const requestMessages = this.prepareMessages ? this.prepareMessages(messages) : messages;
    const transport = this.effectiveTransport(modelId);
    const upstreamModel = this.upstreamModelId(modelId, transport);
    const res = await this.fetchWithTimeout(`${transport.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
        ...(options?.requestId ? { 'X-Glory-Request-Id': options.requestId } : {}),
      },
      body: JSON.stringify({
        model: upstreamModel,
        messages: requestMessages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        ...(options?.reasoning_effort ? { reasoning_effort: this.clampReasoningEffort(options.reasoning_effort, modelId) } : {}),
        ...(this.includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
        stream: true,
      }),
    }, transport.timeoutMs, options?.signal);

    if (!res.ok) {
      const err: unknown = await res.json().catch(() => null);
      const effectiveModel = extractEffectiveModel(err);
      if (effectiveModel && effectiveModel.toLowerCase() !== upstreamModel.toLowerCase()) {
        throw createModelIdentityError(upstreamModel, effectiveModel, Boolean(options?.tools?.length));
      }
      const msg = `${this.name} API error ${res.status}: ${getProviderErrorMessage(err, res.statusText)}`;
      logFailedRequest(this.platform, res.status, { model: upstreamModel, messages: requestMessages, options }, msg);
      throw new Error(msg);
    }

    yield* streamOpenAICompatStream({
      response: res,
      providerName: this.name,
      upstreamModel,
      options,
      bufferUntilContent: this.bufferUntilContent,
      bufferUntilDone: this.bufferUntilDone,
      hasTools: Boolean(options?.tools?.length),
    });
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const transport = this.effectiveTransport();
    const url = this.validateUrl ?? `${transport.baseUrl}/models`;
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...this.extraHeaders,
      },
    }, Math.min(10_000, transport.timeoutMs));
    return res.status !== 401 && res.status !== 403;
  }
}
