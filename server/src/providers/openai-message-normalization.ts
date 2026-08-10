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

    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null)
      if (fold !== null) msg.content = fold
    }
  }
}
