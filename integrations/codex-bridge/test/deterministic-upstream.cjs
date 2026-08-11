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

function providerForAuthorization(authorization) {
  return {
    'Bearer canary-andoryyu-fail': 'andoryyu',
    'Bearer canary-zen': 'opencode-zen',
    'Bearer canary-go': 'opencode-go',
  }[authorization] || 'unknown';
}

function serializedMessages(requestBody) {
  return JSON.stringify(requestBody.messages || []);
}

function completionBody(requestBody) {
  const serialized = serializedMessages(requestBody);
  const hasToolResult = Array.isArray(requestBody.messages)
    && requestBody.messages.some(message => message && message.role === 'tool');
  const requestsProviderSwitchTool = serialized.includes('CANARY_SWITCH_TOOL_CASE')
    && Array.isArray(requestBody.tools)
    && requestBody.tools.some(tool => tool?.function?.name === 'switch_tool');
  const requestsInternalTool = serialized.includes('deterministic canary tool')
    && Array.isArray(requestBody.tools)
    && requestBody.tools.some(tool => tool?.function?.name === 'web_search');
  const requestsCodexTool = serialized.includes('CANARY_CODEX_TOOL_CASE')
    && Array.isArray(requestBody.tools)
    && requestBody.tools.some(tool => tool?.function?.name === 'shell_command');
  const requestsCodexPlugin = serialized.includes('CANARY_CODEX_PLUGIN_CASE');
  const message = requestsProviderSwitchTool && !hasToolResult
    ? {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'canary-switch-tool-call-v1',
          type: 'function',
          function: { name: 'switch_tool', arguments: '{"value":"CANARY_SWITCH_TOOL_ARGUMENT"}' },
        }],
      }
    : requestsInternalTool && !hasToolResult
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
    : requestsCodexPlugin
      ? {
          role: 'assistant',
          content: 'CANARY_CODEX_PLUGIN_OK',
        }
      : {
          role: 'assistant',
          content: hasToolResult && serialized.includes('CANARY_CODEX_TOOL_CASE')
            ? 'CANARY_CODEX_TOOL_OK'
            : hasToolResult && serialized.includes('CANARY_SWITCH_TOOL_CASE')
              ? 'CANARY_SWITCH_TOOL_OK'
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
  const state = {
    cancelObserved: false,
    truncatedObserved: false,
    codexToolObserved: false,
    pluginToolsetObserved: false,
    pluginToolNames: [],
    codexPluginObserved: false,
    codexPluginToolNames: [],
    codexPluginMarkers: { pluginUri: false, browserSkill: false, setupRuntime: false, browserClient: false },
    continuityPlatforms: [],
    toolSwitchProviders: [],
  };
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
      const hasToolResult = Array.isArray(body.messages)
        && body.messages.some(message => message && message.role === 'tool');
      if (serialized.includes('CANARY_CODEX_PLUGIN_CASE')) {
        state.codexPluginToolNames = (body.tools || []).map(tool => tool?.function?.name).filter(Boolean);
        const pluginInstructions = (body.messages || [])
          .filter(message => message?.role === 'system' || message?.role === 'developer')
          .map(message => JSON.stringify(message.content || ''))
          .join('\n');
        const hasBrowserTool = (body.tools || []).some(tool => tool?.function?.name === 'mcp__node_repl__js');
        const hasPluginInstruction = pluginInstructions.includes('control-in-app-browser') && hasBrowserTool;
        state.codexPluginMarkers = {
          pluginUri: pluginInstructions.includes('plugin://browser@openai-bundled'),
          browserSkill: pluginInstructions.includes('control-in-app-browser'),
          setupRuntime: pluginInstructions.includes('setupBrowserRuntime'),
          browserClient: pluginInstructions.includes('browser-client.mjs'),
        };
        if (!hasPluginInstruction) {
          json(response, 422, { error: { message: 'plugin skill instructions were not forwarded' } });
          return;
        }
        state.codexPluginObserved = true;
      }
      if (serialized.includes('CANARY_CONTINUITY_NEXT')) {
        const markers = ['CANARY_CONTINUITY_START', 'CANARY_CONTEXT_PRESERVED', 'CANARY_CONTINUITY_NEXT'];
        const positions = markers.map(marker => serialized.indexOf(marker));
        const complete = positions.every(position => position >= 0)
          && positions.every((position, index) => index === 0 || position > positions[index - 1]);
        if (!complete) {
          json(response, 422, { error: { message: 'canary continuity history was incomplete or out of order' } });
          return;
        }
        state.continuityPlatforms.push(providerForAuthorization(request.headers.authorization));
      }
      if (serialized.includes('CANARY_SWITCH_TOOL_CASE')) {
        const provider = providerForAuthorization(request.headers.authorization);
        if (!hasToolResult) {
          state.toolSwitchProviders.push(provider);
        } else {
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const assistantIndex = messages.findIndex(message => message?.role === 'assistant'
            && Array.isArray(message.tool_calls)
            && message.tool_calls.some(call => call?.id === 'canary-switch-tool-call-v1'));
          const toolIndex = messages.findIndex(message => message?.role === 'tool'
            && message.tool_call_id === 'canary-switch-tool-call-v1');
          const assistantCall = assistantIndex >= 0
            ? messages[assistantIndex].tool_calls.find(call => call?.id === 'canary-switch-tool-call-v1')
            : null;
          const toolResult = toolIndex >= 0 ? messages[toolIndex] : null;
          const validOrder = assistantIndex >= 0 && toolIndex > assistantIndex;
          const validCall = assistantCall?.type === 'function'
            && assistantCall.function?.name === 'switch_tool'
            && assistantCall.function?.arguments === '{"value":"CANARY_SWITCH_TOOL_ARGUMENT"}';
          const validResult = toolResult
            && JSON.stringify(toolResult.content || '').includes('CANARY_SWITCH_TOOL_RESULT');
          if (!validOrder || !validCall || !validResult) {
            json(response, 422, { error: { message: 'provider switch tool history was missing or out of order' } });
            return;
          }
          state.toolSwitchProviders.push(provider);
        }
      }
      if (serialized.includes('CANARY_PLUGIN_CASE')) {
        const toolNames = new Set((body.tools || []).map(tool => tool?.function?.name).filter(Boolean));
        state.pluginToolNames = [...toolNames];
        const required = [
          'mcp__node_repl__js',
          'tool_search',
          'codex_app__automation_update',
          'collaboration__spawn_agent',
        ];
        if (!required.every(name => toolNames.has(name))) {
          json(response, 422, { error: { message: 'canary plugin toolset was not preserved' } });
          return;
        }
        state.pluginToolsetObserved = true;
      }
      if (serialized.includes('CANARY_CODEX_TOOL_CASE')
        && Array.isArray(body.messages)
        && body.messages.some(message => message
          && message.role === 'tool'
          && message.tool_call_id === 'canary-codex-tool-call-v1'
          && JSON.stringify(message.content || '').includes('CANARY_TOOL_EXECUTED'))) {
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
