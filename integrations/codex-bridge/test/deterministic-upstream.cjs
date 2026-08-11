const http = require('node:http');

const DEFAULT_TOKEN = 'canary-upstream-only';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function authorized(request, token) {
  const tokens = Array.isArray(token) ? token : [token];
  return tokens.some(candidate => request.headers.authorization === `Bearer ${candidate}`);
}

function serializedMessages(requestBody) {
  return JSON.stringify(requestBody.messages || []);
}

function completionBody(requestBody) {
  const serialized = serializedMessages(requestBody);
  const hasToolResult = Array.isArray(requestBody.messages)
    && requestBody.messages.some(message => message && message.role === 'tool');
  const requestsInternalTool = serialized.includes('deterministic canary tool')
    && Array.isArray(requestBody.tools)
    && requestBody.tools.some(tool => tool?.function?.name === 'web_search');
  const requestsCodexTool = serialized.includes('CANARY_CODEX_TOOL_CASE')
    && Array.isArray(requestBody.tools)
    && requestBody.tools.some(tool => tool?.function?.name === 'shell_command');
  const message = requestsInternalTool && !hasToolResult
    ? {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'canary-tool-call-v1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"http://127.0.0.1/private"}' },
        }],
      }
    : requestsCodexTool && !hasToolResult
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'canary-codex-tool-call-v1',
            type: 'function',
            function: { name: 'shell_command', arguments: '{"command":"Write-Output CANARY_TOOL_EXECUTED"}' },
          }],
        }
      : {
          role: 'assistant',
          content: hasToolResult && serialized.includes('CANARY_CODEX_TOOL_CASE')
            ? 'CANARY_CODEX_TOOL_OK'
            : hasToolResult
              ? 'CANARY_TOOL_OK'
              : 'CANARY_OK',
        };
  return {
    id: 'canary-chat-completion-v1',
    object: 'chat.completion',
    created: 1,
    model: requestBody.model || 'deepseek-v4-flash',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
  };
}

function writeFragmented(response, value) {
  const bytes = Buffer.from(value, 'utf8');
  for (let offset = 0; offset < bytes.length; offset += 7) {
    response.write(bytes.subarray(offset, Math.min(offset + 7, bytes.length)));
  }
}

function sseFrame(base, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function streamCompletion(response, requestBody, state, authorization) {
  const serialized = serializedMessages(requestBody);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (serialized.includes('CANARY_CANCEL_CASE')) {
    response.on('close', () => { state.cancelObserved = true; });
    return;
  }

  const base = {
    id: 'canary-chat-stream-v1',
    object: 'chat.completion.chunk',
    created: 1,
    model: requestBody.model || 'deepseek-v4-flash',
  };
  const unicode = serialized.includes('CANARY_UNICODE_CASE');
  const truncated = serialized.includes('CANARY_TRUNCATION_CASE')
    && authorization === 'Bearer canary-andoryyu-fail';
  const contentDeltas = unicode ? ['CANARY_', '🌍', '_OK'] : ['CANARY_', 'OK'];
  for (const content of contentDeltas) writeFragmented(response, sseFrame(base, { content }));
  if (truncated) {
    state.truncatedObserved = true;
    response.end();
    return;
  }
  writeFragmented(response, sseFrame(base, {}, 'stop'));
  response.end('data: [DONE]\n\n');
}

function createDeterministicUpstream({ token = DEFAULT_TOKEN, port = 0 } = {}) {
  const state = { cancelObserved: false, truncatedObserved: false, codexToolObserved: false };
  const server = http.createServer((request, response) => {
    if (!authorized(request, token)) {
      json(response, 401, { error: { message: 'invalid canary credential' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      json(response, 200, {
        object: 'list',
        data: [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'canary' }],
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      json(response, 404, { error: { message: 'not found' } });
      return;
    }

    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(response, 400, { error: { message: 'invalid JSON' } });
        return;
      }
      const serialized = serializedMessages(body);
      if (serialized.includes('CANARY_CODEX_TOOL_CASE')
        && Array.isArray(body.messages)
        && body.messages.some(message => message && message.role === 'tool')) {
        state.codexToolObserved = true;
      }
      if (request.headers.authorization === 'Bearer canary-andoryyu-fail'
        && serialized.includes('CANARY_FOREIGN_TOOLSET_CASE')) {
        json(response, 429, {
          model: 'ling-3.0-tiny:free',
          error: {
            message: 'free-models-per-day-high-balance',
            model: 'ling-3.0-tiny:free',
          },
        });
        return;
      }
      if (request.headers.authorization === 'Bearer canary-andoryyu-fail'
        && serialized.includes('CANARY_FALLBACK_CASE')
        && !serialized.includes('CANARY_TRUNCATION_CASE')) {
        json(response, 503, { error: { message: 'deterministic canary provider failure' } });
        return;
      }
      if (body.stream === true) streamCompletion(response, body, state, request.headers.authorization);
      else json(response, 200, completionBody(body));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('canary upstream did not expose a TCP address'));
        return;
      }
      resolve({ server, port: address.port, token, state });
    });
  });
}

module.exports = { createDeterministicUpstream };
