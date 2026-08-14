import {
  getProviderFailurePolicy,
  registerModelRoutes,
  setStickyModel,
  timingSafeStringEqual,
} from './proxy-routing.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  chatCompletionSchema,
  isToolSchemaCompatibilityError as classifyToolSchemaError,
  normalizeProxyError,
  toCanonicalChatRequest,
  type ProxyError,
} from './proxy-contract.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, isOnCooldown, getShortestCooldownRemainingMs } from '../services/ratelimit.js';
import { recordProviderFailure, recordProviderSuccess } from '../services/health.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { logProxyRequest, type ProxyRequestTelemetry } from './proxy-log.js';
import { getSettingNumber } from '../settings/registry.js';
import { beginRoutingAttempt, finishRoutingAttempt } from '../services/routing-runtime.js';
import { validateRouteCapabilities } from '../services/capabilities.js';
import { streamProxyResponse } from '../services/proxy-stream.js';
import {
  beginRoutingTrace,
  finishRoutingTrace,
  recordRoutingTraceAttempt,
} from '../services/routing-trace.js';
import { classifyProxyError, type ProxyErrorClassification } from './proxy-errors.js';
import { resolveProxyModelSelection } from './routing/proxy-selection.js';
import { currentConfigurationRevision } from '../services/configuration-v2.js';
import { validateCanaryRoutingDirective } from './routing/canary-routing.js';
import {
  reasoningTelemetryFromUsage,
  type ReasoningTelemetry,
} from '../lib/reasoning-telemetry.js';

export const proxyRouter = Router();
registerModelRoutes(proxyRouter);

export function isRetryableError(err: unknown): boolean {
  return classifyProxyError(err).retryable;
}

export function isToolSchemaCompatibilityError(err: unknown): boolean {
  return classifyToolSchemaError(err);
}

function routingTraceReason(err: ProxyError, options?: { coldStartRetryMs?: number | null }): string {
  if (isToolSchemaCompatibilityError(err)) return 'schema_incompatible';
  return classifyProxyError(err, options).code;
}

function publicProxyError(classification: ProxyErrorClassification): {
  message: string;
  type: string;
  code: string;
} {
  return {
    message: classification.safeMessage,
    type: classification.category === 'rate_limit' ? 'rate_limit_error' : 'provider_error',
    code: classification.code,
  };
}

function safeRequestId(req: Request): string | undefined {
  const value = req.header('x-glory-request-id');
  return value && /^[A-Za-z0-9._:-]{1,96}$/.test(value) ? value : undefined;
}

function requestTelemetry(req: Request): ProxyRequestTelemetry {
  const requestedKind = req.header('x-glory-request-kind');
  const requestKind = requestedKind && /^(main|audit|continuation|recovery|summary|auxiliary_title|web_limit_synthesis)$/.test(requestedKind)
    ? requestedKind
    : 'main';
  const parent = req.header('x-glory-parent-request-id');
  return {
    requestKind,
    parentRequestId: parent && /^[A-Za-z0-9._:-]{1,96}$/.test(parent) ? parent : null,
  };
}

function cacheTelemetry(usage: unknown): Pick<ProxyRequestTelemetry, 'cachedInputTokens' | 'cacheWriteTokens'> {
  if (!usage || typeof usage !== 'object') return {};
  const value = usage as {
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number };
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number };
  };
  const details = value.prompt_tokens_details ?? value.input_tokens_details;
  if (!details) return {};
  return {
    cachedInputTokens: details.cached_tokens ?? 0,
    cacheWriteTokens: details.cache_write_tokens ?? details.cache_creation_tokens ?? 0,
  };
}

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = safeRequestId(req);
  const telemetry = requestTelemetry(req);
  let selectionTelemetry: Pick<ProxyRequestTelemetry, 'requestedModel' | 'routeId' | 'configurationRevision' | 'selectionReason' | 'selectionConfidence'> = {};
  let requestedReasoningEffort: ProxyRequestTelemetry['reasoningEffort'] = null;
  const logRequest = (
    platform: string,
    modelId: string,
    status: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    error: string | null,
    keyId: number | null = null,
    usage?: unknown,
    reasoning?: ReasoningTelemetry,
  ) => logProxyRequest(platform, modelId, status, inputTokens, outputTokens, latencyMs, error, keyId, {
    ...telemetry,
    ...selectionTelemetry,
    reasoningEffort: requestedReasoningEffort,
    ...cacheTelemetry(usage),
    ...(reasoning ?? reasoningTelemetryFromUsage(usage)),
  });
  if (requestId) res.setHeader('X-Glory-Request-Id', requestId);
  const requestAbortController = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded) requestAbortController.abort();
  };
  req.once('aborted', abortOnDisconnect);
  res.once('close', abortOnDisconnect);

  // Authenticate with the unified API key for every proxy request, including
  // loopback callers. Browser pages can reach localhost, so socket locality is
  // not a reliable authorization boundary.
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const canonical = toCanonicalChatRequest(parsed.data);
  const {
    requestedModel,
    messages,
    temperature,
    max_tokens,
    top_p,
    stream,
    tools,
    tool_choice,
    parallel_tool_calls,
    reasoning_effort,
  } = canonical;
  requestedReasoningEffort = reasoning_effort ?? null;

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = contentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  const canaryValidation = validateCanaryRoutingDirective(
    req.header('x-glory-canary-provider'),
    req.header('x-glory-canary-token'),
  );
  if ('error' in canaryValidation) {
    res.status(403).json({
      error: { message: canaryValidation.error.message, type: 'forbidden', code: canaryValidation.error.code },
    });
    return;
  }
  const canaryProvider = canaryValidation.provider;
  const selection = resolveProxyModelSelection(requestedModel, messages, canaryProvider);
  if ('error' in selection) {
    res.status(400).json({
      error: { message: selection.error.message, type: 'invalid_request_error', code: selection.error.code },
    });
    return;
  }
  selectionTelemetry = {
    requestedModel: requestedModel ?? null,
    routeId: selection.routeId ?? null,
    configurationRevision: currentConfigurationRevision(),
    selectionReason: selection.selectionReason ?? null,
    selectionConfidence: selection.selectionConfidence ?? 'unknown',
  };
  const { preferredModel, restrictedChain } = selection;

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  // Capability rejection is a model-level decision. Keep it separate from
  // key failures so another credential cannot select the same incompatible
  // provider again during this request.
  const excludedModels = new Set<string>();
  // Track which model+key already got a cold-start retry so we don't loop forever
  const coldStartRetried = new Set<string>();
  let lastError: ProxyError | null = null;
  let lastErrorKind: 'retryable' | 'schema_mismatch' | 'model_downgrade' | null = null;

  const traceId = beginRoutingTrace();
  const maxAttempts = getSettingNumber('routing.maxAttempts');
  const routingDeadline = Date.now() + getSettingNumber('routing.maxDurationMs');
  for (let attempt = 0; attempt < maxAttempts && Date.now() < routingDeadline; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, restrictedChain, excludedModels.size > 0 ? excludedModels : undefined);
    } catch (rawError: unknown) {
      const err = normalizeProxyError(rawError);
      // No route available right now. First purge every skip entry whose
      // cooldown has already expired (or that has no cooldown at all, e.g.
      // opencode-go with cooldownMs:0 or a model that was only skip-listed
      // without a cooldown). This MUST run even when there is nothing to
      // wait for: otherwise a provider that only had a short/zero cooldown
      // would stay blocked in skipKeys for the whole request and the proxy
      // would answer 429 "All candidate models are temporarily unavailable"
      // even though opencode-go is healthy and available again.
      let purged = false;
      for (const skipId of [...skipKeys]) {
        const [platform, modelId, keyIdStr] = skipId.split(':');
        const keyId = Number(keyIdStr);
        if (!isOnCooldown(platform, modelId, keyId)) {
          skipKeys.delete(skipId);
          purged = true;
        }
      }
      // Purging re-opened at least one route: retry immediately instead of
      // failing. Bounded by maxAttempts/routingDeadline above.
      if (purged) continue;

      // Everything still cooling: if a short key cooldown is about to expire
      // (e.g. the 15s paid-provider cooldown on opencode-go), wait for it and
      // retry instead of failing fast — "everything should flow", and the
      // paid fallback should be retried rather than skipped.
      const waitMs = getShortestCooldownRemainingMs();
      const maxCooldownWaitMs = 60_000;
      if (waitMs > 0 && waitMs <= maxCooldownWaitMs && Date.now() + waitMs < routingDeadline) {
        console.log(`[Proxy] All routes cooling; waiting ${waitMs}ms for nearest cooldown to expire...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      // No more models available
      if (lastError) {
        const exhaustedBySchemaMismatch = lastErrorKind === 'schema_mismatch';
        const exhaustedByModelDowngrade = lastErrorKind === 'model_downgrade';
        const lastClassification = classifyProxyError(lastError);
        const publicError = exhaustedBySchemaMismatch
          ? { message: 'All compatible models rejected this request.', type: 'provider_error', code: 'schema_incompatible' }
          : exhaustedByModelDowngrade
            ? publicProxyError(lastClassification)
            : { message: 'All candidate models are temporarily unavailable.', type: 'rate_limit_error', code: lastClassification.code };
        res.status(exhaustedBySchemaMismatch || exhaustedByModelDowngrade ? 502 : 429).json({ error: publicError });
      } else {
        res.status(503).json({
          error: { message: 'No model is currently available for this request.', type: 'routing_error', code: 'no_route' },
        });
      }
      finishRoutingTrace(traceId, 'failed');
      return;
    }

    const routeStartedAt = Date.now();
    const capabilityError = validateRouteCapabilities(route, {
      stream,
      tools,
      reasoningEffort: reasoning_effort,
    });
    if (capabilityError) {
      excludedModels.add(`${route.platform}:${route.modelId}`); lastError = capabilityError; lastErrorKind = 'schema_mismatch';
      recordRoutingTraceAttempt(traceId, route, 'rejected', 'capability_not_supported', Date.now() - routeStartedAt);
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, Date.now() - start, capabilityError.message, route.keyId);
      continue;
    }

    recordRequest(route.platform, route.modelId, route.keyId);
    const routingAttemptId = beginRoutingAttempt(route);

    try {
      // Make the routing decision observable at the HTTP boundary for both
      // streaming and non-streaming clients. The bridge can carry these
      // headers into diagnostics without parsing prompt-bearing content.
      res.setHeader('X-Glory-Configuration-Revision', String(selectionTelemetry.configurationRevision ?? ''));
      res.setHeader('X-Glory-Route-Id', selection.routeId ?? 'legacy');
      res.setHeader('X-Glory-Selection-Reason', selection.selectionReason ?? 'unknown');
      if (stream) {
        await streamProxyResponse({
          route,
          messages,
          options: { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, reasoning_effort, requestId, signal: requestAbortController.signal },
          res,
          attempt,
          onSuccess: async (totalOutputTokens, reasoning) => {
          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          recordProviderSuccess(route.platform);
          setStickyModel(messages, route.modelDbId);
          finishRoutingAttempt(routingAttemptId, 'success', route);
          recordRoutingTraceAttempt(traceId, route, 'success', null, Date.now() - routeStartedAt);
          finishRoutingTrace(traceId, 'completed', route);
          logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, route.keyId, undefined, reasoning);
          },
          onMidStreamError: async (streamClassification, totalOutputTokens, reasoning) => {
            finishRoutingAttempt(routingAttemptId, 'error', route);
            recordRoutingTraceAttempt(traceId, route, 'error', 'stream_truncated', Date.now() - routeStartedAt);
            finishRoutingTrace(traceId, 'failed');
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamClassification.safeMessage, route.keyId, undefined, reasoning);
          },
        });
        return;
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, reasoning_effort, requestId, signal: requestAbortController.signal },
        );

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        recordProviderSuccess(route.platform);
        setStickyModel(messages, route.modelDbId);
        finishRoutingAttempt(routingAttemptId, 'success', route);
        recordRoutingTraceAttempt(traceId, route, 'success', null, Date.now() - routeStartedAt);
        finishRoutingTrace(traceId, 'completed', route);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(result);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null, route.keyId, result.usage,
        );
        return;
      }
    } catch (rawError: unknown) {
      finishRoutingAttempt(routingAttemptId, 'error', route);
      const err = normalizeProxyError(rawError);
      const errorClassification = classifyProxyError(err, { coldStartRetryMs: route.coldStartRetryMs });
      recordRoutingTraceAttempt(traceId, route, 'error', routingTraceReason(err, { coldStartRetryMs: route.coldStartRetryMs }), Date.now() - routeStartedAt);
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, errorClassification.safeMessage, route.keyId);

      const retryable = errorClassification.retryable || isRetryableError(err);
      const schemaMismatch = isToolSchemaCompatibilityError(err) || errorClassification.code === 'schema_incompatible';

      if (retryable || schemaMismatch) {
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;

        /* [265A-1] Cold-start retry: models with coldStartRetryMs (e.g.
         * nvidia/z-ai/glm-5.1 with ~2min NIM cold start) get one extra
         * chance after a pause before the router gives up on them.
         *
         * The wait gives the upstream container time to boot, after which
         * the same model+key is retried. If it still fails, the normal
         * fallback chain kicks in. This avoids skipping a working model
         * just because its cold-start timeout hit the HTTP timeout. */
        const coldRetryMs = route.coldStartRetryMs;
        if (retryable && coldRetryMs && !coldStartRetried.has(skipId)) {
          coldStartRetried.add(skipId);
          console.log(`[Proxy] ${errorClassification.code} from ${route.displayName}, waiting ${coldRetryMs}ms for warm-up...`);
          await new Promise(resolve => setTimeout(resolve, coldRetryMs));
          // Continue without adding to skipKeys or setting cooldown —
          // the next iteration will re-select the same model+key.
          continue;
        }

        // Put this model+key on cooldown and try the next one
        skipKeys.add(skipId);
        if (retryable) {
          if (errorClassification.cooldownEligible) {
            const policy = getProviderFailurePolicy(route.platform);
            // rate_limited (429) en un pool con cuota diaria (opencode-zen)
            // suele significar cuota agotada: escalar el cooldown a horas en
            // vez de los ~5 min de un fallo transitorio (503, timeout).
            const cooldownMs = errorClassification.code === 'rate_limited'
              ? (policy?.rateLimitCooldownMs ?? policy?.cooldownMs ?? 120_000)
              : (policy?.cooldownMs ?? 120_000);
            setCooldown(route.platform, route.modelId, route.keyId, cooldownMs);
            if (policy?.recordPenalty !== false) recordRateLimitHit(route.modelDbId);
            if (policy?.recordProviderFailure !== false) recordProviderFailure(route.platform);
          }
          lastErrorKind = errorClassification.code === 'model_downgrade' || errorClassification.code === 'foreign_toolset'
            ? 'model_downgrade'
            : 'retryable';
        } else {
          lastErrorKind = 'schema_mismatch';
        }
        lastError = err;
        console.log(`[Proxy] ${errorClassification.code} from ${route.displayName}, falling back (attempt ${attempt + 1}/${maxAttempts})`);

        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(errorClassification.status).json({
        error: publicProxyError(errorClassification),
      });
      finishRoutingTrace(traceId, 'failed');
      return;
    }
  }

  // Exhausted the bounded attempt/time budget.
  finishRoutingTrace(traceId, 'failed');
  const exhaustedBySchemaMismatch = lastErrorKind === 'schema_mismatch';
  const exhaustedByModelDowngrade = lastErrorKind === 'model_downgrade';
  const exhaustedClassification = lastError ? classifyProxyError(lastError) : null;
  res.status(exhaustedBySchemaMismatch || exhaustedByModelDowngrade ? 502 : 429).json({
    error: exhaustedBySchemaMismatch
      ? { message: 'All compatible models rejected this request.', type: 'provider_error', code: 'schema_incompatible' }
      : exhaustedByModelDowngrade && exhaustedClassification
        ? publicProxyError(exhaustedClassification)
        : {
            message: 'All candidate models are temporarily unavailable.',
            type: 'rate_limit_error',
            code: exhaustedClassification?.code ?? 'rate_limited',
          },
  });
});
