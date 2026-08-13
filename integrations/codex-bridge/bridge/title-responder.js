const crypto = require('node:crypto');
const { structuredTitleSchema } = require('./request-classifier');

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function latestUserText(body) {
  const items = Array.isArray(body && body.input) ? body.input : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item.type === 'message' && item.role === 'user') {
      const text = textFromContent(item.content).replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return 'Nueva conversación';
}

function localTitle(body, maxLength = 80) {
  const source = latestUserText(body)
    .replace(/^.*\bUser prompt:\s*/is, '')
    .replace(/^Message Type:\s*NEW_TASK\b[\s\S]*?Payload:\s*/i, '')
    .replace(/[`*_#]/g, '')
    .trim();
  if (!source) return 'Nueva conversación';
  if (source.length <= maxLength) return source;
  const shortened = source.slice(0, maxLength - 1).replace(/\s+\S*$/, '').trim();
  return `${shortened || source.slice(0, maxLength - 1)}…`;
}

function titleMaxLength(body) {
  const configured = structuredTitleSchema(body)?.properties?.title?.maxLength;
  return Number.isSafeInteger(configured) ? Math.min(80, Math.max(1, configured)) : 80;
}

function localTitleOutput(body, title) {
  if (!structuredTitleSchema(body)) return title;
  return JSON.stringify({ title, description: title });
}

function responseIdFor(fingerprint) {
  const suffix = crypto.createHash('sha256').update(String(fingerprint || Date.now())).digest('hex').slice(0, 20);
  return `resp_local_title_${suffix}`;
}

function sseEvent(res, name, payload) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function titleOutput(responseId, title) {
  return [{
    type: 'message',
    id: `${responseId}_message`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: title }],
  }];
}

function writeLocalTitleResponse(res, body, requestId, fingerprint) {
  const responseId = responseIdFor(fingerprint || requestId);
  const title = localTitle(body, titleMaxLength(body));
  const outputText = localTitleOutput(body, title);
  const output = titleOutput(responseId, outputText);
  if (body && body.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: responseId,
      object: 'response',
      status: 'completed',
      model: body.model || 'local-title',
      output,
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sseEvent(res, 'response.created', {
    type: 'response.created',
    response: { id: responseId, status: 'in_progress', model: body?.model || 'local-title' },
  });
  sseEvent(res, 'response.output_item.added', {
    type: 'response.output_item.added',
    item: { ...output[0], content: [{ type: 'output_text', text: '' }] },
  });
  sseEvent(res, 'response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: output[0].id,
    output_index: 0,
    content_index: 0,
    delta: outputText,
  });
  sseEvent(res, 'response.output_text.done', {
    type: 'response.output_text.done',
    item_id: output[0].id,
    output_index: 0,
    content_index: 0,
    text: outputText,
  });
  sseEvent(res, 'response.output_item.done', { type: 'response.output_item.done', item: output[0] });
  sseEvent(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      model: body?.model || 'local-title',
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
      end_turn: true,
    },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = { latestUserText, localTitle, localTitleOutput, titleMaxLength, writeLocalTitleResponse };
