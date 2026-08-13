const assert = require('node:assert/strict');
const test = require('node:test');
const { config } = require('../bridge/config');
const { createRequestTranslator } = require('../bridge/request-translator');
const { createResponsesAdapter } = require('../bridge/responses-adapter');

function makeTranslator(profile) {
  return createRequestTranslator({
    config: { ...config, tools: { profile } },
    describeImage: async () => null,
    extractFocusHint: () => '',
    boundSystemContent: value => String(value),
    log: () => {},
    reasoningFor: () => null,
  });
}

async function translate(profile, tools = []) {
  return makeTranslator(profile).translateRequest({
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
    tools,
  });
}

test('codex-desktop profile adds deferred tools and collaboration aliases', async () => {
  const result = await translate('codex-desktop');
  const names = (result.chat.tools || []).map(tool => tool.function.name);
  assert.ok(names.includes('mcp__node_repl__js'));
  assert.ok(names.includes('codex_app__automation_update'));
  assert.equal(result.toolMap.get('collaborationspawn_agent').namespace, 'collaboration');

  const adapter = createResponsesAdapter({
    logRequest: () => {},
    visibleReasoning: value => value,
    normalizeReasoningText: value => value,
    fallbackReasoning: 'internal fallback',
    withSpawnForkFix: (_name, args) => args,
    toolProfile: 'codex-desktop',
  });
  const rendered = adapter.responseItemsForToolCalls([
    { id: 'call-agent', function: { name: 'collaborationspawn_agent', arguments: '{}' } },
  ], result.toolMap, result.customTools);
  assert.equal(rendered.error, null);
  assert.deepEqual(rendered.items[0], {
    type: 'function_call',
    call_id: 'call-agent',
    name: 'spawn_agent',
    arguments: '{}',
    namespace: 'collaboration',
    encrypted_function_args: [],
  });
});

test('generic profile forwards only client-advertised tools', async () => {
  const result = await translate('generic');
  const names = (result.chat.tools || []).map(tool => tool.function.name);
  assert.equal(names.includes('mcp__node_repl__js'), false);
  assert.equal(names.includes('codex_app__automation_update'), false);
  assert.equal(result.toolMap.has('collaborationspawn_agent'), false);
});

test('translator preserves the last real user message separately from injected context', async () => {
  const translator = makeTranslator('codex-desktop');
  const result = await translator.translateRequest({
    model: 'gpt-5.6-sol',
    stream: false,
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Contexto: corrige, ejecuta y revisa todo.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola, esto es un test' }] },
    ],
  });
  assert.equal(result.chat.__latestUserText, 'hola, esto es un test');
  assert.equal(Object.prototype.propertyIsEnumerable.call(result.chat, '__latestUserText'), false);
});

test('codex-desktop preserves a multi-agent call, agent message, and tool result in order', async () => {
  const translator = makeTranslator('codex-desktop');
  const result = await translator.translateRequest({
    stream: false,
    tools: [{
      type: 'namespace',
      name: 'collaboration',
      tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
    }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'delegate this task' }] },
      {
        type: 'function_call',
        call_id: 'call-agent-v1',
        namespace: 'collaboration',
        name: 'spawn_agent',
        arguments: '{"agent_type":"worker","fork_turns":"none","message":"inspect the fixture"}',
      },
      {
        type: 'agent_message',
        content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload: inspect the fixture' }],
      },
      {
        type: 'function_call_output',
        call_id: 'call-agent-v1',
        output: '{"status":"accepted"}',
      },
    ],
  });

  const messages = result.chat.messages;
  const assistantIndex = messages.findIndex(message => message.role === 'assistant' && message.tool_calls?.length);
  const agentMessageIndex = messages.findIndex(message => message.role === 'user'
    && JSON.stringify(message.content).includes('Message Type: NEW_TASK'));
  const toolIndex = messages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'call-agent-v1');
  assert.ok(assistantIndex >= 0);
  assert.ok(agentMessageIndex >= 0);
  assert.ok(agentMessageIndex < assistantIndex);
  assert.equal(toolIndex, assistantIndex + 1);
  assert.equal(messages[assistantIndex].tool_calls[0].id, 'call-agent-v1');
  assert.equal(messages[assistantIndex].tool_calls[0].function.name, 'collaborationspawn_agent');
  assert.equal(messages[toolIndex].content, '{"status":"accepted"}');
  assert.equal(messages[toolIndex - 1].role, 'assistant');
});
