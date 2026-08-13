const assert = require('node:assert/strict');
const test = require('node:test');
const { config: baseConfig } = require('../bridge/config');
const { createContextAdapter } = require('../bridge/context-adapter');
const { createUpstreamAdapter } = require('../bridge/upstream-adapter');
const { assertSafeLoopbackUpstream } = require('../bridge/endpoint-security');

function canaryConfig() {
  return {
    ...baseConfig,
    canary: { enabled: true, routingToken: 'test-canary-token' },
    upstream: { ...baseConfig.upstream, baseUrl: 'http://127.0.0.1:3101/v1' },
    recovery: { ...baseConfig.recovery, nudgeRetries: 1 },
  };
}

test('nudge retries preserve the provider directive on non-enumerable request metadata', async () => {
  const seen = [];
  const config = canaryConfig();
  const adapter = createContextAdapter({
    config,
    log: () => {},
    logRequest: () => {},
    formatRemoteFailure: () => {},
    responseByteLength: () => 0,
    normalizeReasoningText: value => value,
    visibleReasoning: value => value,
    fallbackReasoning: 'internal fallback',
    attachRequestId: (target, requestId) => {
      Object.defineProperty(target, '__gloryRequestId', { value: requestId, enumerable: false });
      return target;
    },
    assertSafeLoopbackUpstream,
    fetchUpstreamCompletion: async chat => {
      seen.push(chat);
      return { choices: [{ message: { content: 'ok' } }] };
    },
  });
  const chat = { messages: [{ role: 'user', content: 'continue' }] };
  Object.defineProperty(chat, '__canaryProvider', { value: 'opencode-go', enumerable: false });
  Object.defineProperty(chat, '__gloryRequestId', { value: 'req_test_correlation', enumerable: false });

  await adapter.nudgeForToolCalls(chat, 'Bearer test', 'I will continue');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].__canaryProvider, 'opencode-go');
  assert.equal(Object.prototype.propertyIsEnumerable.call(seen[0], '__canaryProvider'), false);
  assert.equal(seen[0].__gloryRequestId, 'req_test_correlation');
  assert.equal(Object.prototype.propertyIsEnumerable.call(seen[0], '__gloryRequestId'), false);
});

test('adaptive audit uses the real final user message instead of merged injected context', () => {
  const adapter = createContextAdapter({
    config: canaryConfig(),
    log: () => {},
    logRequest: () => {},
    formatRemoteFailure: () => {},
    normalizeReasoningText: value => value,
    visibleReasoning: value => value,
    fallbackReasoning: 'internal fallback',
    fetchUpstreamCompletion: async () => ({ choices: [{ message: { content: 'COMPLETE' } }] }),
  });
  const chat = {
    messages: [{ role: 'user', content: 'Contexto inyectado: corrige, ejecuta y revisa todo.\nhola, esto es un test' }],
    tools: [{ type: 'function', function: { name: 'shell_command' } }],
  };
  Object.defineProperty(chat, '__userTools', { value: true, enumerable: false });
  Object.defineProperty(chat, '__latestUserText', { value: 'hola, esto es un test', enumerable: false });
  assert.equal(adapter.shouldAuditCompletion(chat, 'Hola, ¿en qué puedo ayudarte?'), false);
});

test('upstream adapter emits authenticated canary routing headers', async t => {
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (_url, options) => {
    seen.push(options.headers);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
  t.after(() => { global.fetch = originalFetch; });

  const config = canaryConfig();
  const adapter = createUpstreamAdapter({
    config,
    log: () => {},
    logRequest: () => {},
    redactText: value => String(value),
    formatRemoteFailure: () => {},
    assertSafeLoopbackUpstream,
    attachRequestId: (chat, requestId) => chat,
    compactContext: async chat => chat,
    assistantMessageFrom: json => json.choices[0].message,
    assistantText: message => message.content || '',
    assistantToolCalls: () => [],
    hasVisibleAssistantAction: () => true,
    lookupToolCall: () => ({ web: false }),
    visibleReasoning: () => false,
    reasoningFor: () => null,
    fallbackReasoning: 'internal fallback',
  });
  const chat = { messages: [{ role: 'user', content: 'test' }] };
  Object.defineProperty(chat, '__canaryProvider', { value: 'opencode-zen', enumerable: false });

  await adapter.fetchUpstreamCompletion(chat, 'Bearer test');

  assert.equal(seen[0]['X-Glory-Canary-Provider'], 'opencode-zen');
  assert.equal(seen[0]['X-Glory-Canary-Token'], 'test-canary-token');
});
