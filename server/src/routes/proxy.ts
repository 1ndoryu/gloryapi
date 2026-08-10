import {
  PROVIDER_FAILURE_POLICY,
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
import { logProxyRequest } from './proxy-log.js';
import { getSettingNumber } from '../settings/registry.js';
import { beginRoutingAttempt, finishRoutingAttempt } from '../services/routing-runtime.js';
import { validateRouteCapabilities } from '../services/capabilities.js';
import {
  beginRoutingTrace,
  finishRoutingTrace,
  recordRoutingTraceAttempt,
} from '../services/routing-trace.js';
import { classifyProxyError, type ProxyErrorClassification } from './proxy-errors.js';
import { resolveProxyModelSelection } from './routing/proxy-selection.js';

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

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = safeRequestId(req);
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
  const selection = resolveProxyModelSelection(requestedModel, messages);
  if ('error' in selection) {
    res.status(400).json({
      error: { message: selection.error.message, type: 'invalid_request_error', code: selection.error.code },
    });
    return;
  }
  const { preferredModel, restrictedChain } = selection;

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
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
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, restrictedChain);
    } catch (rawError: unknown) {
      const err = normalizeProxyError(rawError);
      // No route available right now. If a short key cooldown is about to
      // expire (e.g. the 15s paid-provider cooldown on opencode-go), wait
      // for it and retry instead of failing fast — "everything should flow",
      // and the paid fallback should be retried rather than skipped.
      const waitMs = getShortestCooldownRemainingMs();
      const maxCooldownWaitMs = 60_000;
      if (waitMs > 0 && waitMs <= maxCooldownWaitMs && Date.now() + waitMs < routingDeadline) {
        console.log(`[Proxy] All routes cooling; waiting ${waitMs}ms for nearest cooldown to expire...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        // Drop skip entries whose cooldown has expired so the next
        // routeRequest can pick them up again (e.g. retry opencode-go
        // after its short 15s cooldown instead of leaving it skipped).
        for (const skipId of skipKeys) {
          const [platform, modelId, keyIdStr] = skipId.split(':');
          const keyId = Number(keyIdStr);
          if (!isOnCooldown(platform, modelId, keyId)) skipKeys.delete(skipId);
        }
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
      lastError = capabilityError;
      lastErrorKind = 'schema_mismatch';
      recordRoutingTraceAttempt(traceId, route, 'rejected', 'capability_not_supported', Date.now() - routeStartedAt);
      logProxyRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, Date.now() - start, capabilityError.message, route.keyId);
      continue;
    }

    recordRequest(route.platform, route.modelId, route.keyId);
    const routingAttemptId = beginRoutingAttempt(route);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, reasoning_effort, requestId, signal: requestAbortController.signal },
          );

          for await (const chunk of gen) {
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
            // Upstream returned no chunks — emitting an empty `data: [DONE]`
            // makes clients like VSCode say "Sorry, no response was returned".
            // Fail instead so the router falls back to the next model.
            const err = new Error(`Provider ${route.displayName} returned no streamed chunks`) as ProxyError;
            err.retryable = true;
            throw err;
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          recordProviderSuccess(route.platform);
          setStickyModel(messages, route.modelDbId);
          finishRoutingAttempt(routingAttemptId, 'success', route);
          recordRoutingTraceAttempt(traceId, route, 'success', null, Date.now() - routeStartedAt);
          finishRoutingTrace(traceId, 'completed', route);
          logProxyRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, route.keyId);
          return;
        } catch (rawStreamError: unknown) {
          const streamErr = normalizeProxyError(rawStreamError);
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // The client and metadata log receive only the bounded error code/message.
            const streamClassification = classifyProxyError(streamErr, { coldStartRetryMs: route.coldStartRetryMs });
            console.error(`[Proxy] Mid-stream error from ${route.displayName}: ${streamClassification.code}`);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error', code: streamClassification.code } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            finishRoutingAttempt(routingAttemptId, 'error', route);
            recordRoutingTraceAttempt(traceId, route, 'error', 'stream_truncated', Date.now() - routeStartedAt);
            finishRoutingTrace(traceId, 'failed');
            logProxyRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamClassification.safeMessage, route.keyId);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
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

        logProxyRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null, route.keyId,
        );
        return;
      }
    } catch (rawError: unknown) {
      finishRoutingAttempt(routingAttemptId, 'error', route);
      const err = normalizeProxyError(rawError);
      const errorClassification = classifyProxyError(err, { coldStartRetryMs: route.coldStartRetryMs });
      recordRoutingTraceAttempt(traceId, route, 'error', routingTraceReason(err, { coldStartRetryMs: route.coldStartRetryMs }), Date.now() - routeStartedAt);
      const latency = Date.now() - start;
      logProxyRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, errorClassification.safeMessage, route.keyId);

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
            const policy = PROVIDER_FAILURE_POLICY[route.platform];
            setCooldown(route.platform, route.modelId, route.keyId, policy?.cooldownMs ?? 120_000);
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
