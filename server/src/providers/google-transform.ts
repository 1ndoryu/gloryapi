import type {
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@gloryapi/shared/types.js'
import { contentToString } from '../lib/content.js'

export interface GeminiPart {
  text?: string
  thoughtSignature?: string
  functionCall?: {
    id?: string
    name?: string
    args?: unknown
  }
  functionResponse?: {
    id?: string
    name?: string
    response?: unknown
  }
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] }
  finishReason?: string
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { value: raw }
  }
}

function normalizeGeminiArgs(args: unknown): string {
  if (typeof args === 'string') return args
  return JSON.stringify(args ?? {})
}

export function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase()
  if (!r) return 'stop'
  if (r === 'MAX_TOKENS') return 'length'
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
    return 'content_filter'
  }
  return 'stop'
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'definitions',
  'enumDescriptions',
  'exclusiveMinimum', 'exclusiveMaximum',
  'additionalProperties',
  'const',
  'anyOf', 'oneOf', 'allOf',
  'any_of', 'one_of', 'all_of',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'dependentRequired', 'dependentSchemas',
])

export function sanitizeForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini)
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (!GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) out[key] = sanitizeForGemini(value)
    }
    return out
  }
  return schema
}

export function toGeminiTools(tools?: ChatToolDefinition[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!tools || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeForGemini(t.function.parameters),
    })),
  }]
}

export function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined
  if (typeof toolChoice === 'string') {
    const mode = toolChoice === 'none' ? 'NONE' : toolChoice === 'required' ? 'ANY' : 'AUTO'
    return { functionCallingConfig: { mode } }
  }
  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.function.name],
    },
  }
}

export function toGeminiContents(messages: ChatMessage[]) {
  const systemMessages = messages
    .filter(m => m.role === 'system')
    .map(m => contentToString(m.content))
    .filter(s => s.length > 0)

  const toolNameByCallId = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) toolNameByCallId.set(call.id, call.function.name)
  }

  const contents = messages
    .filter(m => m.role !== 'system')
    .map((message): { role: 'user' | 'model'; parts: GeminiPart[] } | null => {
      if (message.role === 'assistant') {
        const parts: GeminiPart[] = []
        const assistantText = contentToString(message.content)
        if (assistantText.length > 0) parts.push({ text: assistantText })
        for (const call of message.tool_calls ?? []) {
          parts.push({
            thoughtSignature: call.thought_signature,
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: safeParseObject(call.function.arguments),
            },
          })
        }
        if (parts.length === 0) return null
        return { role: 'model', parts }
      }

      if (message.role === 'tool') {
        const toolCallId = message.tool_call_id
        if (!toolCallId) return null
        const toolName = message.name ?? toolNameByCallId.get(toolCallId) ?? 'tool'
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolCallId,
              name: toolName,
              response: safeParseObject(contentToString(message.content)),
            },
          }],
        }
      }

      return { role: 'user', parts: [{ text: contentToString(message.content) }] }
    })
    .filter((entry): entry is { role: 'user' | 'model'; parts: GeminiPart[] } => entry !== null)

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined,
  }
}

export function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = []
  if (!parts) return calls
  let fallbackIndex = 0
  for (const part of parts) {
    if (!part.functionCall?.name) continue
    const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`
    calls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: normalizeGeminiArgs(part.functionCall.args),
      },
      thought_signature: part.thoughtSignature,
    })
  }
  return calls
}

export function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null
  const text = parts.map(part => part.text ?? '').join('')
  return text.length > 0 ? text : null
}
