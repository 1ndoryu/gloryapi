function crearAcumulador(ctx) {
  const { sseEvent, createReasoningForwarder, rand, res, msgId, reasoningId, estado } = ctx;

  const toolCalls = new Map(); // index -> { id, name, args }
  const getMessageOutputIndex = () => {
    if (estado.messageOutputIndex === null) estado.messageOutputIndex = reasoningForwarder.hasEmitted() ? 1 : 0;
    return estado.messageOutputIndex;
  };
  const getReasoningOutputIndex = () => estado.messageOutputIndex === null ? 0 : 1;
  const reasoningForwarder = createReasoningForwarder(res, reasoningId, getReasoningOutputIndex);
  const emitMessageDelta = (contentDelta) => {
    if (!contentDelta) return;
    // Keep the message item after the reasoning item. When CommandCode sends
    // content before its reasoning stream, the delta is held until the
    // reasoning item has been opened; otherwise the desktop client ignores the
    // later reasoning summary as an out-of-order output item.
    if (!estado.msgAdded) {
      estado.msgAdded = true;
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: getMessageOutputIndex(),
        item: {
          type: 'message',
          role: 'assistant',
          id: msgId,
          content: [{ type: 'output_text', text: '' }],
        },
      });
    }
    sseEvent(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: getMessageOutputIndex(),
      content_index: 0,
      delta: contentDelta,
    });
  };
  const flushBufferedMessage = () => {
    if (estado.bufferedMessageText) {
      emitMessageDelta(estado.bufferedMessageText);
      estado.bufferedMessageText = '';
    }
  };


  const handleChunk = (raw) => {
    const lines = raw.split(/\r?\n/);
    const dataLines = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    if (payload.trim() === '[DONE]') {
      if (estado.sawDone) throw new Error('upstream sent duplicate [DONE]');
      estado.sawDone = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error('upstream returned invalid SSE JSON');
    }

    const choice = (json.choices && json.choices[0]) || {};
    const delta = choice.delta || {};

    const reasoningDelta = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
    if (reasoningDelta) {
      estado.reasoningText += reasoningDelta;
      reasoningForwarder.add(reasoningDelta);
    }
    const message = choice.message || {};
    const messageReasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : '';
    if (!reasoningDelta && messageReasoning) {
      estado.reasoningText += messageReasoning;
      reasoningForwarder.add(messageReasoning);
    }
    if (typeof delta.content === 'string' && delta.content) {
      estado.text += delta.content;
      estado.bufferedMessageText += delta.content;
    }
    const incomingToolCalls = Array.isArray(delta.tool_calls)
      ? delta.tool_calls
      : Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
    for (const tc of incomingToolCalls) {
      let key = Number.isInteger(tc.index) ? tc.index : null;
      let acc = key == null ? null : toolCalls.get(key);
      if (!acc && tc.id) {
        for (const candidate of toolCalls.values()) {
          if (candidate.id === tc.id) {
            key = candidate.key;
            acc = candidate;
            break;
          }
        }
      }
      if (!acc) {
        key = key == null ? `call_${estado.nextToolIndex++}` : key;
        acc = { key, id: tc.id || rand('call'), name: '', args: '' };
        toolCalls.set(key, acc);
      }
      if (tc.function && tc.function.name) acc.name = tc.function.name;
      if (tc.function && tc.function.arguments) acc.args += tc.function.arguments;
    }
    if (json.usage) estado.usage = json.usage;
  };

  return { handleChunk, flushBufferedMessage, getMessageOutputIndex, reasoningForwarder, toolCalls };
}

module.exports = { crearAcumulador };
