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
  fillMissingToolReasoning as fillToolReasoning,
  normalizeChoices,
  replaceNullAssistantContent as normalizeNullAssistantContent,
  stripEmptyReasoning as dropEmptyReasoning,
} from './openai-message-normalization.js';
import { getProviderErrorMessage } from './error-response.js';
import { assertEffectiveModel, createModelIdentityError, extractEffectiveModel } from './compat/model-identity.js';
import { getEffectiveProviderModelSettings } from '../settings/registry.js';
import { getDb } from '../db/index.js';
import { getConfiguredProviderFromDb } from '../services/provider-configuration.js';
import { streamOpenAICompatStream } from './compat/openai-stream.js';
import { clampResponsesEffort, translateChatRequestToResponses } from './responses/translate-request.js';
import { extractReasoningItems, translateResponsesResponse } from './responses/translate-response.js';
import { translateResponsesStream } from './responses/translate-stream.js';
import { lookupResponsesReasoning, storeResponsesReasoning } from './responses/reasoning-cache.js';

function responsesReplayBytes(items: Array<{ encrypted_content: string }> | undefined): number {
  if (!items) return 0;
  return items.reduce((sum, item) => sum + Buffer.byteLength(item.encrypted_content, 'utf8'), 0);
}

function isResponsesStateError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const text = JSON.stringify(err).toLowerCase();
  return text.includes('unknown parameter') && (text.includes('store') || text.includes('include') || text.includes('reasoning'))
    || (text.includes('store') && text.includes('unexpected'))
    || (text.includes('include') && text.includes('unexpected'));
}

/** Fail-open for a malformed replay: if the gateway rejects the replayed
 * `reasoning` item itself (e.g. a newly required field), retry once without
 * any replayed state instead of failing a request that used to succeed. */
function isResponsesReplayError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const text = JSON.stringify(err).toLowerCase();
  return text.includes('invalid_request') && (text.includes('reasoning') || text.includes('encrypted_content') || text.includes('summary'));
}

export function replaceNullAssistantContent(messages: ChatMessage[]): ChatMessage[] {
  return normalizeNullAssistantContent(messages);
}

export function ensureReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return addReasoningContent(messages);
}

export function stripEmptyReasoning(messages: ChatMessage[]): ChatMessage[] {
  return dropEmptyReasoning(messages);
}

export function fillMissingToolReasoning(messages: ChatMessage[]): ChatMessage[] {
  return fillToolReasoning(messages);
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
  /** Per-model transport override: substring-matched against the model id
   * (case-insensitive). Models whose upstream only serves the Responses API
   * (e.g. Muse Spark on OpenCode Go) pin `responses` here; everything else
   * keeps the OpenAI chat-completions contract. */
  private readonly endpointKinds: Map<string, 'chat' | 'responses'>;

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
    endpointKinds?: Record<string, 'chat' | 'responses'>;
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
    this.endpointKinds = new Map(Object.entries(opts.endpointKinds ?? {}));
  }

  private endpointKindFor(modelId?: string): 'chat' | 'responses' {
    if (modelId) {
      const lower = modelId.toLowerCase();
      for (const [pattern, kind] of this.endpointKinds) {
        if (lower.includes(pattern.toLowerCase())) return kind;
      }
    }
    return 'chat';
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
    const useResponses = this.endpointKindFor(modelId) === 'responses';
    const url = useResponses ? `${transport.baseUrl}/responses` : `${transport.baseUrl}/chat/completions`;
    const previousReasoning = useResponses ? lookupResponsesReasoning(requestMessages, upstreamModel) : undefined;
    const responsesEffort = options?.reasoning_effort
      ? clampResponsesEffort(options.reasoning_effort, modelId, this.modelReasoningLimits, this.maxReasoningEffort)
      : undefined;
    const buildResponsesBody = (omitState: boolean): string => JSON.stringify(translateChatRequestToResponses({
      model: upstreamModel,
      messages: requestMessages,
      options,
      reasoningEffort: responsesEffort,
      ...(omitState ? { omitState: true } : previousReasoning ? { previousReasoning } : {}),
    }));
    const body = useResponses
      ? buildResponsesBody(false)
      : JSON.stringify({
          model: upstreamModel,
          messages: requestMessages,
          temperature: options?.temperature,
          max_tokens: options?.max_tokens,
          top_p: options?.top_p,
          tools: options?.tools,
          tool_choice: options?.tool_choice,
          parallel_tool_calls: options?.parallel_tool_calls,
          ...(options?.reasoning_effort ? { reasoning_effort: this.clampReasoningEffort(options.reasoning_effort, modelId) } : {}),
        });
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...this.extraHeaders,
      ...(options?.requestId ? { 'X-Glory-Request-Id': options.requestId } : {}),
    };
    let res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body,
    }, transport.timeoutMs, options?.signal);

    // Fail-open: gateways that do not know `store`/`include` answer 400
    // `unknown parameter`. Retry once without the stateless-reasoning state
    // instead of failing a usable model.
    if (useResponses && !res.ok && res.status === 400) {
      const probe: unknown = await res.clone().json().catch(() => null);
      if (isResponsesStateError(probe)) {
        if (process.env.GLORYAPI_DEBUG_RESPONSES === '1') console.info(`[${this.name}] responses state fallback (omit store/include)`);
        res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: buildResponsesBody(true),
        }, transport.timeoutMs, options?.signal);
      } else if (previousReasoning?.length && isResponsesReplayError(probe)) {
        if (process.env.GLORYAPI_DEBUG_RESPONSES === '1') console.info(`[${this.name}] responses replay fallback (omit replay)`);
        res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: buildResponsesBody(true),
        }, transport.timeoutMs, options?.signal);
      }
    }

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

    if (useResponses) {
      const raw = await res.json() as Record<string, unknown>;
      if (raw.status === 'failed') {
        const error = (raw.error ?? {}) as Record<string, unknown>;
        const msg = `${this.name} API error: ${typeof error.message === 'string' ? error.message : 'response failed'}`;
        logFailedRequest(this.platform, 500, { model: upstreamModel, messages: requestMessages, options }, msg);
        throw new Error(msg);
      }
      const newReasoning = extractReasoningItems(raw);
      if (newReasoning.length > 0) storeResponsesReasoning(requestMessages, upstreamModel, newReasoning);
      if (process.env.GLORYAPI_DEBUG_RESPONSES === '1') {
        console.info(`[${this.name}] responses replay hit=${previousReasoning?.length ? 1 : 0} prevBytes=${responsesReplayBytes(previousReasoning)} newItems=${newReasoning.length}`);
      }
      const data = translateResponsesResponse(raw, upstreamModel);
      assertEffectiveModel(data, upstreamModel, Boolean(options?.tools?.length));
      normalizeChoices(data);
      data._routed_via = { platform: this.platform, model: modelId };
      return data;
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
    const useResponses = this.endpointKindFor(modelId) === 'responses';
    const url = useResponses ? `${transport.baseUrl}/responses` : `${transport.baseUrl}/chat/completions`;
    const previousReasoning = useResponses ? lookupResponsesReasoning(requestMessages, upstreamModel) : undefined;
    const responsesEffort = options?.reasoning_effort
      ? clampResponsesEffort(options.reasoning_effort, modelId, this.modelReasoningLimits, this.maxReasoningEffort)
      : undefined;
    const buildResponsesBody = (omitState: boolean): string => JSON.stringify(translateChatRequestToResponses({
      model: upstreamModel,
      messages: requestMessages,
      options,
      stream: true,
      reasoningEffort: responsesEffort,
      ...(omitState ? { omitState: true } : previousReasoning ? { previousReasoning } : {}),
    }));
    const body = useResponses
      ? buildResponsesBody(false)
      : JSON.stringify({
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
        });
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...this.extraHeaders,
      ...(options?.requestId ? { 'X-Glory-Request-Id': options.requestId } : {}),
    };
    let res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body,
    }, transport.timeoutMs, options?.signal);

    if (useResponses && !res.ok && res.status === 400) {
      const probe: unknown = await res.clone().json().catch(() => null);
      if (isResponsesStateError(probe)) {
        if (process.env.GLORYAPI_DEBUG_RESPONSES === '1') console.info(`[${this.name}] responses state fallback (omit store/include)`);
        res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: buildResponsesBody(true),
        }, transport.timeoutMs, options?.signal);
      } else if (previousReasoning?.length && isResponsesReplayError(probe)) {
        if (process.env.GLORYAPI_DEBUG_RESPONSES === '1') console.info(`[${this.name}] responses replay fallback (omit replay)`);
        res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: buildResponsesBody(true),
        }, transport.timeoutMs, options?.signal);
      }
    }

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

    if (useResponses) {
      const collector: { reasoningItems?: import('./responses/reasoning-cache.js').ResponsesReasoningItem[] } = {};
      yield* translateResponsesStream({
        response: res,
        providerName: this.name,
        upstreamModel,
        options,
        collector,
      });
      if (collector.reasoningItems?.length) storeResponsesReasoning(requestMessages, upstreamModel, collector.reasoningItems);
      if (process.env.GLORYAPI_DEBUG_RESPONSES === '1') {
        console.info(`[${this.name}] responses replay hit=${previousReasoning?.length ? 1 : 0} prevBytes=${responsesReplayBytes(previousReasoning)} newItems=${collector.reasoningItems?.length ?? 0}`);
      }
      return;
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
