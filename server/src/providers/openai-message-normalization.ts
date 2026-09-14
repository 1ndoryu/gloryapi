import type { ChatMessage, ChatCompletionResponse } from '@gloryapi/shared/types.js'

export function replaceNullAssistantContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => (
    message.role === 'assistant' && message.content == null
      ? { ...message, content: '' }
      : message
  ))
}

export function ensureReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => (
    message.role === 'assistant' && message.reasoning_content === undefined
      ? { ...message, reasoning_content: '' }
      : message
  ))
}

/* Gateways estrictos (Experiential Labs) rechazan `reasoning_content` vacío en
 * cualquier turno ("must be non-empty plaintext reasoning or a
 * gateway-issued carrier") y rechazan razonamiento ajeno en turnos de
 * tool-call ("must be a gateway-issued carrier on an assistant tool-call
 * turn"). Los clientes estilo DeepSeek reenvían el historial con
 * `reasoning_content: ''` cuando el turno previo no razonó, y con trazas de
 * otros proveedores en turnos con tool_calls; ambos casos devuelven 400.
 * Se quitan los vacíos en todos los turnos y todo el razonamiento en turnos
 * con tool_calls (los tool_calls + sus resultados conservan el contexto).
 * No toca a los proveedores que exigen el campo. */
export function stripEmptyReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    const candidate = message as ChatMessage & { reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown };
    const hasToolCalls = Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0;
    const stripContent = 'reasoning_content' in candidate
      && (hasToolCalls || !(typeof candidate.reasoning_content === 'string' && candidate.reasoning_content.length > 0));
    const stripReasoning = 'reasoning' in candidate
      && (hasToolCalls || !(typeof candidate.reasoning === 'string' && candidate.reasoning.length > 0));
    if (!stripContent && !stripReasoning) return message;
    const cleaned = { ...candidate };
    if (stripContent) delete cleaned.reasoning_content;
    if (stripReasoning) delete cleaned.reasoning;
    return cleaned;
  })
}

/* El gateway de CommandCode hacia DeepSeek en modo thinking rechaza
 * historiales donde un turno assistant con tool_calls no devuelve
 * `reasoning_content` no vacío (400 "must be passed back"). Los clientes
 * reinyectan `reasoning_content: ''` cuando el turno previo lo generó otro
 * modelo (p. ej. continuar en DeepSeek una conversación de luna): un solo
 * turno así pasa, pero al acumularse —y en especial con tool_calls en
 * paralelo— el gateway rechaza todo el historial. Verificado por bisección
 * (089A-4): historial de 21 mensajes/8 turnos → 400; el mismo historial con
 * un marcador honesto en el turno paralelo → 200.
 * Se rellena SOLO reasoning ausente/vacío en turnos CON tool_calls, con un
 * marcador que declara su origen (nunca se inventa pensamiento ajeno como
 * real). Las trazas reales se conservan intactas. */
export const CROSS_MODEL_REASONING_MARKER =
  '[cross-model continuation: original thinking trace unavailable]';

export function fillMissingToolReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    const candidate = message as ChatMessage & {
      reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown;
    };
    if (candidate.role !== 'assistant') return message;
    if (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length === 0) return message;
    const rc = typeof candidate.reasoning_content === 'string' ? candidate.reasoning_content : '';
    const r = typeof candidate.reasoning === 'string' ? candidate.reasoning : '';
    if (rc.length > 0 || r.length > 0) {
      // Traza real en un solo campo: espejar al otro (aditivo, como normalizeChoices).
      if (rc.length === 0) return { ...candidate, reasoning_content: r };
      if (r.length === 0) return { ...candidate, reasoning: rc };
      return message;
    }
    return { ...candidate, reasoning_content: CROSS_MODEL_REASONING_MARKER };
  })
}

export function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string
      reasoning?: string
      content: unknown
    }

    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string; type?: string }>)
        .map(seg => (typeof seg === 'string' ? seg : (seg.text ?? '')))
        .join('')
    }

    // Mirror reasoning across field names. Some providers (Anthropic-style,
    // e.g. CommandCode) return `reasoning`; DeepSeek-style clients expect
    // `reasoning_content`. Additive: the original field is preserved.
    if (typeof msg.reasoning === 'string' && msg.reasoning_content === undefined) {
      msg.reasoning_content = msg.reasoning
    } else if (typeof msg.reasoning_content === 'string' && msg.reasoning === undefined) {
      msg.reasoning = msg.reasoning_content
    }

    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null)
      if (fold !== null) msg.content = fold
    }
  }
}
