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
