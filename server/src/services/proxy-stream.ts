import type { Response } from 'express';
import type { ChatMessage } from '@gloryapi/shared/types.js';
import type { CompletionOptions } from '../providers/base.js';
import type { RouteResult } from './router.js';
import { normalizeProxyError, type ProxyError } from '../routes/proxy-contract.js';
import { classifyProxyError, type ProxyErrorClassification } from '../routes/proxy-errors.js';
import {
  estimateReasoningTokens,
  extractProviderReasoningTokens,
  type ReasoningTelemetry,
} from '../lib/reasoning-telemetry.js';

type StreamMessages = ChatMessage[];

export async function streamProxyResponse({
  route,
  messages,
  options,
  res,
  attempt,
  onSuccess,
  onMidStreamError,
}: {
  route: RouteResult;
  messages: StreamMessages;
  options: CompletionOptions;
  res: Response;
  attempt: number;
  onSuccess: (totalOutputTokens: number, reasoning: ReasoningTelemetry) => void | Promise<void>;
  onMidStreamError: (
    classification: ProxyErrorClassification,
    totalOutputTokens: number,
    reasoning: ReasoningTelemetry,
  ) => void | Promise<void>;
}): Promise<void> {
  let totalOutputTokens = 0;
  let estimatedReasoningTokens = 0;
  let providerReasoningTokens: number | null = null;
  let streamStarted = false;

  const reasoningTelemetry = (): ReasoningTelemetry => providerReasoningTokens === null
    ? {
      reasoningTokens: estimatedReasoningTokens,
      reasoningTokensSource: estimatedReasoningTokens > 0 ? 'estimated' : 'none',
    }
    : { reasoningTokens: providerReasoningTokens, reasoningTokensSource: 'provider' };

  try {
    const generator = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, options);
    for await (const chunk of generator) {
      const reportedReasoningTokens = extractProviderReasoningTokens(chunk.usage);
      if (reportedReasoningTokens !== null) providerReasoningTokens = reportedReasoningTokens;
      const delta = chunk.choices[0]?.delta;
      // CommandCode (Anthropic-style) streams reasoning in `delta.reasoning`;
      // DeepSeek-style clients (e.g. the VSCode Copilot bridge) read
      // `delta.reasoning_content`. Mirror whichever field the upstream sent so
      // the thinking block renders regardless of the field name the provider
      // uses. Both fields stay present; the mirror is additive, never drops
      // the provider's original field.
      if (delta && typeof delta.reasoning === 'string' && delta.reasoning_content === undefined) {
        delta.reasoning_content = delta.reasoning;
      } else if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning === undefined) {
        delta.reasoning = delta.reasoning_content;
      }
      // Keep estimating from observed reasoning deltas until a positive
      // provider value arrives. A provisional usage=0 frame must not suppress
      // evidence that the model actually emitted reasoning.
      estimatedReasoningTokens += estimateReasoningTokens(delta?.reasoning_content ?? delta?.reasoning);
      if (!streamStarted) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        streamStarted = true;
      }
      const text = chunk.choices[0]?.delta?.content ?? '';
      totalOutputTokens += Math.ceil(text.length / 4);
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    if (!streamStarted) {
      const error = new Error(`Provider ${route.displayName} returned no streamed chunks`) as ProxyError;
      error.retryable = true;
      throw error;
    }
    res.write('data: [DONE]\n\n');
    res.end();
    await onSuccess(totalOutputTokens, reasoningTelemetry());
  } catch (rawError: unknown) {
    const streamError = normalizeProxyError(rawError);
    if (!streamStarted) throw streamError;

    const classification = classifyProxyError(streamError, { coldStartRetryMs: route.coldStartRetryMs });
    console.error(`[Proxy] Mid-stream error from ${route.displayName}: ${classification.code}`);
    const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error', code: classification.code } };
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
    await onMidStreamError(classification, totalOutputTokens, reasoningTelemetry());
  }
}
