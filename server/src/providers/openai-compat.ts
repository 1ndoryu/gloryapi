import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@gloryapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { normalizeChoices } from './openai-message-normalization.js';
import { getProviderErrorMessage } from './error-response.js';
import { assertEffectiveModel, createModelIdentityError, extractEffectiveModel } from './compat/model-identity.js';
import { CompatTransport, clampReasoningEffort } from './compat/provider-transport.js';
import { logFailedRequest } from './compat/request-log.js';
import {
  isResponsesReplayError,
  isResponsesStateError,
  responsesReplayBytes,
} from './compat/responses-errors.js';
import { streamOpenAICompatStream } from './compat/openai-stream.js';
import { clampResponsesEffort, translateChatRequestToResponses } from './responses/translate-request.js';
import { extractReasoningItems, translateResponsesResponse } from './responses/translate-response.js';
import { translateResponsesStream } from './responses/translate-stream.js';
import { lookupResponsesReasoning, storeResponsesReasoning } from './responses/reasoning-cache.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  private readonly prepareMessages?: (messages: ChatMessage[]) => ChatMessage[];
  /** Resolución del transporte efectivo (canary/DB/settings). Ver `compat/provider-transport.ts`. */
  private readonly transport: CompatTransport;
  /** Default maximum reasoning_effort for this provider. */
  private readonly maxReasoningEffort: 'low' | 'medium' | 'high' | 'max';
  /** Per-model overrides for max reasoning_effort. Keys are substrings to match
   * against the model ID (case-insensitive). First match wins. */
  private readonly modelReasoningLimits: Map<string, 'low' | 'medium' | 'high' | 'max'>;
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
    endpointKinds?: Record<string, 'chat' | 'responses'>;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.transport = new CompatTransport({
      platform: opts.platform,
      name: opts.name,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      modelAliases: opts.modelAliases,
      endpointKinds: opts.endpointKinds,
    });
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.prepareMessages = opts.prepareMessages;
    this.maxReasoningEffort = opts.maxReasoningEffort ?? 'high';
    this.modelReasoningLimits = new Map(Object.entries(opts.modelReasoningLimits ?? {}));
    this.bufferUntilContent = opts.bufferUntilContent ?? false;
    this.bufferUntilDone = opts.bufferUntilDone ?? false;
    this.includeStreamUsage = opts.includeStreamUsage ?? false;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const requestMessages = this.prepareMessages ? this.prepareMessages(messages) : messages;
    const transport = this.transport.effectiveTransport(modelId);
    const upstreamModel = this.transport.upstreamModelId(modelId, transport);
    const useResponses = this.transport.endpointKindFor(modelId) === 'responses';
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
          ...(options?.reasoning_effort ? { reasoning_effort: clampReasoningEffort(options.reasoning_effort, modelId, this.modelReasoningLimits, this.maxReasoningEffort) } : {}),
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
    const transport = this.transport.effectiveTransport(modelId);
    const upstreamModel = this.transport.upstreamModelId(modelId, transport);
    const useResponses = this.transport.endpointKindFor(modelId) === 'responses';
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
          ...(options?.reasoning_effort ? { reasoning_effort: clampReasoningEffort(options.reasoning_effort, modelId, this.modelReasoningLimits, this.maxReasoningEffort) } : {}),
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
    const transport = this.transport.effectiveTransport();
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
