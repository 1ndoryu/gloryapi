/* Helpers del handler de chat completions.
 * [por que] proxy-chat.ts superaba el limite de 300 lineas con el handler
 * completo; los helpers de telemetria, errores, clasificacion y preparacion
 * de la solicitud viven aqui. */
import type { Request, Response } from 'express';
import {
  chatCompletionSchema,
  isToolSchemaCompatibilityError as classifyToolSchemaError,
  toCanonicalChatRequest,
  type CanonicalChatRequest,
  type ProxyError,
} from './proxy-contract.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { timingSafeStringEqual } from './proxy-routing.js';
import { resolveProxyModelSelection } from './routing/proxy-selection.js';
import { currentConfigurationRevision } from '../services/configuration-v2.js';
import { validateCanaryRoutingDirective } from './routing/canary-routing.js';
import { classifyProxyError, type ProxyErrorClassification } from './proxy-errors.js';
import type { ProxyRequestTelemetry } from './proxy-log.js';
import type { CompletionOptions } from '../providers/base.js';

export function isToolSchemaCompatibilityError(err: unknown): boolean {
  return classifyToolSchemaError(err);
}

export function isRetryableError(err: unknown): boolean {
  return classifyProxyError(err).retryable;
}

export function routingTraceReason(err: ProxyError, options?: { coldStartRetryMs?: number | null }): string {
  if (isToolSchemaCompatibilityError(err)) return 'schema_incompatible';
  return classifyProxyError(err, options).code;
}

export function publicProxyError(classification: ProxyErrorClassification): {
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

export function safeRequestId(req: Request): string | undefined {
  const value = req.header('x-glory-request-id');
  return value && /^[A-Za-z0-9._:-]{1,96}$/.test(value) ? value : undefined;
}

export function requestTelemetry(req: Request): ProxyRequestTelemetry {
  const requestedKind = req.header('x-glory-request-kind');
  const requestKind = requestedKind && /^(main|audit|continuation|recovery|summary|auxiliary_title|web_limit_synthesis)$/.test(requestedKind)
    ? requestedKind
    : 'main';
  const parent = req.header('x-glory-parent-request-id');
  const parentRoute = req.header('x-glory-parent-route-id');
  const parentRevisionText = req.header('x-glory-parent-configuration-revision');
  const parentRevision = Number(parentRevisionText);
  const parentSelectionReason = req.header('x-glory-parent-selection-reason');
  return {
    requestKind,
    parentRequestId: parent && /^[A-Za-z0-9._:-]{1,96}$/.test(parent) ? parent : null,
    parentRouteId: parentRoute && /^[a-z][a-z0-9:_-]{1,127}$/.test(parentRoute) ? parentRoute : null,
    parentConfigurationRevision: Number.isSafeInteger(parentRevision) && parentRevision >= 0 ? parentRevision : null,
    parentSelectionReason: parentSelectionReason && /^[A-Za-z0-9._:-]{1,96}$/.test(parentSelectionReason) ? parentSelectionReason : null,
  };
}

export function cacheTelemetry(usage: unknown): Pick<ProxyRequestTelemetry, 'cachedInputTokens' | 'cacheWriteTokens'> {
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

/* Autentica, valida y selecciona la ruta del chat. Devuelve null si ya se
 * respondio un error y el caller debe terminar. [por que] Extraido del handler
 * para mantener proxy-chat.ts bajo el limite de lineas. */
export function prepareChatRequest(req: Request, res: Response): {
  requestedReasoningEffort: ProxyRequestTelemetry['reasoningEffort'];
  selectionTelemetry: Pick<ProxyRequestTelemetry, 'requestedModel' | 'routeId' | 'configurationRevision' | 'selectionReason' | 'selectionConfidence'>;
  messages: CanonicalChatRequest['messages'];
  temperature: CanonicalChatRequest['temperature'];
  max_tokens: CanonicalChatRequest['max_tokens'];
  top_p: CanonicalChatRequest['top_p'];
  stream: CanonicalChatRequest['stream'];
  tools: CanonicalChatRequest['tools'];
  tool_choice: CanonicalChatRequest['tool_choice'];
  parallel_tool_calls: CanonicalChatRequest['parallel_tool_calls'];
  reasoning_effort: CanonicalChatRequest['reasoning_effort'];
  estimatedInputTokens: number;
  estimatedTotal: number;
  options: CompletionOptions;
  preferredModel: number | undefined;
  restrictedChain: number[] | undefined;
} | null {
  // Authenticate with the unified API key for every proxy request, including
  // loopback callers. Browser pages can reach localhost, so socket locality is
  // not a reliable authorization boundary.
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return null;
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
    return null;
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
  const requestedReasoningEffort = reasoning_effort ?? null;

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
    return null;
  }
  const canaryProvider = canaryValidation.provider;
  const selection = resolveProxyModelSelection(requestedModel, messages, canaryProvider);
  if ('error' in selection) {
    res.status(400).json({
      error: { message: selection.error.message, type: 'invalid_request_error', code: selection.error.code },
    });
    return null;
  }
  const selectionTelemetry = {
    requestedModel: requestedModel ?? null,
    routeId: selection.routeId ?? null,
    configurationRevision: currentConfigurationRevision(),
    selectionReason: selection.selectionReason ?? null,
    selectionConfidence: selection.selectionConfidence ?? 'unknown',
  };
  const options: CompletionOptions = {
    temperature,
    max_tokens,
    top_p,
    tools: tools as CompletionOptions['tools'],
    tool_choice: tool_choice as CompletionOptions['tool_choice'],
    parallel_tool_calls,
    reasoning_effort: reasoning_effort as CompletionOptions['reasoning_effort'],
  };
  return {
    requestedReasoningEffort,
    selectionTelemetry,
    messages,
    temperature,
    max_tokens,
    top_p,
    stream,
    tools,
    tool_choice,
    parallel_tool_calls,
    reasoning_effort,
    estimatedInputTokens,
    estimatedTotal,
    options,
    preferredModel: selection.preferredModel,
    restrictedChain: selection.restrictedChain,
  };
}
