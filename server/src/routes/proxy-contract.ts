import { z } from 'zod'
import type { ChatMessage } from '@gloryapi/shared/types.js'

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
})

const contentBlockSchema = z.object({ type: z.string() }).passthrough()
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)])

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0
  if (Array.isArray(content)) return content.length > 0
  return false
}

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
})

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
})

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  reasoning_content: z.string().optional(),
  reasoning: z.string().optional(),
}).refine(msg => {
  if (hasNonEmptyContent(msg.content)) return true;
  if ((msg.tool_calls?.length ?? 0) > 0) return true;
  // Assistant turns carrying only thinking text (DeepSeek-style clients send
  // `content: ''` with `reasoning_content` filled) are valid even with no
  // visible content; a bare empty content (e.g. `content: []`) is not.
  return (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
    || (typeof msg.reasoning === 'string' && msg.reasoning.length > 0);
}, {
  message: 'assistant messages must include non-empty content, reasoning, or tool_calls',
})

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: contentSchema,
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
})

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
})

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1) }),
  }),
])

/**
 * Repair malformed-but-recoverable request fields before the strict schema
 * rejects the whole call. Observed from real Copilot-style clients:
 *   - a function tool whose `function.name` is an empty string;
 *   - an assistant `tool_calls` entry with an empty `id` or `function.name`;
 *   - a `tool` message with an empty `tool_call_id` (or referencing a call
 *     that was dropped);
 *   - a `tool_choice` object with an empty `function.name`.
 * A tool/call that cannot be named is unusable anyway, so dropping it (and
 * its orphaned `tool` result) keeps the conversation coherent instead of
 * rejecting the whole request with a 400.
 */
export function sanitizeChatRequest(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };

  if (Array.isArray(record.tools)) {
    const kept = (record.tools as unknown[]).filter(tool => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
      const candidate = tool as { type?: unknown; function?: { name?: unknown } };
      if (candidate.type !== 'function' || !candidate.function || typeof candidate.function !== 'object') return false;
      return typeof candidate.function.name === 'string' && candidate.function.name.trim().length > 0;
    });
    result.tools = kept.length > 0 ? kept : undefined;
  }

  if (record.tool_choice && typeof record.tool_choice === 'object' && !Array.isArray(record.tool_choice)) {
    const choice = record.tool_choice as Record<string, unknown>;
    const fn = choice.function as Record<string, unknown> | undefined;
    const name = fn && typeof fn === 'object' ? fn.name : '';
    if (choice.type === 'function' && (typeof name !== 'string' || !String(name).trim())) {
      result.tool_choice = 'auto';
    }
  }

  if (Array.isArray(record.messages)) {
    const droppedCallIds = new Set<string>();
    const messages: unknown[] = [];
    for (const message of record.messages as unknown[]) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        messages.push(message);
        continue;
      }
      const msg = message as Record<string, unknown>;
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        const keptCalls: unknown[] = [];
        for (const call of msg.tool_calls as unknown[]) {
          if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
          const candidate = call as { id?: unknown; function?: { name?: unknown } };
          const id = typeof candidate.id === 'string' ? candidate.id : '';
          const name = candidate.function && typeof candidate.function === 'object' ? candidate.function.name : '';
          if (id.trim() && typeof name === 'string' && name.trim()) {
            keptCalls.push(call);
          } else if (id.trim()) {
            droppedCallIds.add(id);
          } else {
            // Empty-id calls are dropped; their tool results (also with empty
            // ids) are removed below.
            droppedCallIds.add('');
          }
        }
        messages.push({ ...msg, tool_calls: keptCalls.length > 0 ? keptCalls : undefined });
        continue;
      }
      if (msg.role === 'tool') {
        const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
        if (!callId.trim() || droppedCallIds.has(callId)) continue;
      }
      messages.push(message);
    }
    result.messages = messages;
  }

  return result;
}

export const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
})

export interface CanonicalChatRequest {
  requestedModel?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: z.infer<typeof toolDefinitionSchema>[];
  tool_choice?: z.infer<typeof toolChoiceSchema>;
  parallel_tool_calls?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max';
}

export function toCanonicalChatRequest(input: z.infer<typeof chatCompletionSchema>): CanonicalChatRequest {
  const messages: ChatMessage[] = input.messages.map(message => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content ?? null,
        ...(message.name ? { name: message.name } : {}),
        ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
        ...(typeof message.reasoning === 'string' ? { reasoning: message.reasoning } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map(toolCall => ({
          id: toolCall.id,
          type: toolCall.type,
          function: toolCall.function,
          thought_signature: toolCall.thought_signature,
        })) } : {}),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
        ...(message.name ? { name: message.name } : {}),
      };
    }
    return {
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    };
  });
  return {
    requestedModel: input.model,
    messages,
    temperature: input.temperature,
    max_tokens: input.max_tokens,
    top_p: input.top_p,
    stream: input.stream,
    tools: input.tools,
    tool_choice: input.tool_choice,
    parallel_tool_calls: input.parallel_tool_calls,
    reasoning_effort: input.reasoning_effort,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (isRecord(err) && typeof err.message === 'string') return err.message
  return ''
}

export type ProxyError = Error & {
  status?: number;
  retryable?: boolean;
  streamAbort?: boolean;
  cancelled?: boolean;
  modelDowngrade?: boolean;
  requestedModel?: string;
  effectiveModel?: string;
  foreignToolset?: boolean;
};

export function normalizeProxyError(value: unknown): ProxyError {
  if (value instanceof Error) return value as ProxyError;
  if (isRecord(value)) {
    const error = new Error(typeof value.message === 'string' ? value.message : 'Unknown provider error') as ProxyError;
    if (typeof value.status === 'number') error.status = value.status;
    if (typeof value.retryable === 'boolean') error.retryable = value.retryable;
    if (typeof value.streamAbort === 'boolean') error.streamAbort = value.streamAbort;
    if (typeof value.cancelled === 'boolean') error.cancelled = value.cancelled;
    if (typeof value.modelDowngrade === 'boolean') error.modelDowngrade = value.modelDowngrade;
    if (typeof value.requestedModel === 'string') error.requestedModel = value.requestedModel;
    if (typeof value.effectiveModel === 'string') error.effectiveModel = value.effectiveModel;
    if (typeof value.foreignToolset === 'boolean') error.foreignToolset = value.foreignToolset;
    return error;
  }
  return new Error(String(value)) as ProxyError;
}

export function isRetryableError(err: unknown): boolean {
  if (isRecord(err) && err.cancelled === true) return false
  if (isRecord(err) && err.retryable === true) return true
  const msg = errorMessage(err).toLowerCase()
  const statusMatch = msg.match(/(?:api error|status)\s+(\d{3})/i) ?? msg.match(/\b(\d{3})\b/)
  const status = statusMatch ? Number(statusMatch[1]) : Number.NaN

  if (!Number.isNaN(status)) {
    if (status === 400) return false
    if (status === 401 || status === 402 || status === 403) return true
    if (status === 404) return true
    if (status === 408 || status === 409 || status === 413 || status === 429) return true
    if (status >= 500 && status <= 599) return true
    return false
  }

  return msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')
    || msg.includes('403') || msg.includes('forbidden') || msg.includes('access denied')
    || msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('402') || msg.includes('payment required')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('insufficient credits') || msg.includes('insufficient balance')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
}

export function isToolSchemaCompatibilityError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase()
  const looksLikeBadRequest = msg.includes('400') || msg.includes('bad request') || msg.includes('invalid json payload')
  if (!looksLikeBadRequest) return false

  const unknownField = msg.includes('unknown name') || msg.includes('cannot find field') || msg.includes('unknown field')
  const thoughtSignatureContext = msg.includes('thought_signature')
    || msg.includes('thought signature')
    || msg.includes('thoughtsignature')
  const missingRequiredField = msg.includes('missing')
    || msg.includes('required')
    || msg.includes('must be specified')
    || msg.includes('should be specified')
    || msg.includes('must be set')
  const toolContext = msg.includes('function_declarations')
    || msg.includes('functiondeclarations')
    || msg.includes('toolconfig')
    || msg.includes('tools[')
    || msg.includes('parameters.properties')
    || msg.includes('enumdescriptions')
    || msg.includes('tool_calls[')
    || msg.includes('tool calls')
    || thoughtSignatureContext

  return toolContext && (unknownField || (thoughtSignatureContext && missingRequiredField))
}
