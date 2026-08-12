const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('generic bridge aliases configure the upstream without provider-specific names', () => {
  const env = {
    ...process.env,
    BRIDGE_UPSTREAM_BASE_URL: 'http://127.0.0.1:9999/v1',
    GLORY_API_BASE_URL: 'http://127.0.0.1:3101/v1',
    BRIDGE_UPSTREAM_COMPLETIONS_PATH: '/responses/chat',
    BRIDGE_UPSTREAM_API_KEY: 'generic-token',
    GLORY_API_KEY: 'legacy-token',
    BRIDGE_UPSTREAM_AUTH_SCHEME: 'Token',
    BRIDGE_MODEL: 'provider-model',
    GLORY_MODEL: 'legacy-model',
    BRIDGE_PROVIDER_NAME: 'provider-x',
    BRIDGE_UPSTREAM_CONTRACT: 'chat-completions-v2',
  };
  const result = spawnSync(
    process.execPath,
    ['-e', "const { config } = require('./bridge/config'); process.stdout.write(JSON.stringify({ upstream: config.upstream, auth: config.auth, identity: config.identity, contract: config.contract }));"],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.upstream.baseUrl, 'http://127.0.0.1:9999/v1');
  assert.equal(output.upstream.completionsPath, '/responses/chat');
  assert.equal(output.upstream.model, 'provider-model');
  assert.equal(output.upstream.authScheme, 'Token');
  assert.equal(output.auth.upstreamToken, 'generic-token');
  assert.equal(output.identity.providerName, 'provider-x');
  assert.equal(output.contract.actual, 'chat-completions-v2');
});

test('context compaction delegates summaries to the bounded upstream transport', () => {
  const env = {
    ...process.env,
    BRIDGE_COMPACTION_DISABLED: '0',
    CONTEXT_LIMIT_TOKENS: '1000',
    COMPACT_KEEP_TOKENS: '100',
    COMPACT_MAX_TOKENS: '256',
    BRIDGE_COMPACTION_MODEL: 'summary-model',
    BRIDGE_UPSTREAM_BASE_URL: 'http://127.0.0.1:9999/v1',
    BRIDGE_UPSTREAM_COMPLETIONS_PATH: '/responses/chat',
    BRIDGE_UPSTREAM_TIMEOUT_MS: '1000',
  };
  const script = [
    "const { config } = require('./bridge/config');",
    "const { createContextAdapter } = require('./bridge/context-adapter');",
    'const calls = [];',
    "const adapter = createContextAdapter({ config, log: () => {}, logRequest: () => {}, formatRemoteFailure: () => {}, normalizeReasoningText: (value) => value, visibleReasoning: (value) => value, fallbackReasoning: '', fetchUpstreamCompletion: async (chat, authorization, timeoutMs) => { calls.push({ chat, authorization, timeoutMs }); return { choices: [{ message: { content: 'RESUMEN DE LA CONVERSACIÓN: ' + 'detalle fiel. '.repeat(30) } }] }; } });",
    "const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) }));",
    "adapter.compactContext({ messages }, 'Token test').then(() => process.stdout.write(JSON.stringify(calls)));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(result.stdout);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat.model, 'summary-model');
  assert.equal(calls[0].chat.stream, false);
  assert.equal(calls[0].chat.max_tokens, 256);
  assert.equal(calls[0].authorization, 'Token test');
  assert.equal(calls[0].timeoutMs, 1000);
});

test('context budget includes serialized tool definitions', () => {
  const env = {
    ...process.env,
    BRIDGE_COMPACTION_DISABLED: '0',
    CALIB_RATIO: '1',
    CONTEXT_LIMIT_TOKENS: '1000',
    COMPACT_KEEP_TOKENS: '100',
    COMPACT_MAX_TOKENS: '256',
  };
  const script = [
    "const { config } = require('./bridge/config');",
    "const { createContextAdapter } = require('./bridge/context-adapter');",
    "let summaryCalls = 0;",
    "const adapter = createContextAdapter({ config, log: () => {}, logRequest: () => {}, formatRemoteFailure: () => {}, normalizeReasoningText: (value) => value, visibleReasoning: (value) => value, fallbackReasoning: '', fetchUpstreamCompletion: async () => { summaryCalls += 1; return { choices: [{ message: { content: 'RESUMEN DE LA CONVERSACIÓN: ' + 'detalle fiel. '.repeat(30) } }] }; } });",
    "const chat = { messages: [{ role: 'user', content: 'historial antiguo '.repeat(80) }, { role: 'user', content: 'último turno' }], tools: [{ type: 'function', function: { name: 'plugin_tool', description: 'x'.repeat(8000), parameters: { type: 'object', properties: {} } } }] };",
    "adapter.compactContext(chat, 'Token test').then(() => process.stdout.write(JSON.stringify({ summaryCalls, messages: chat.messages.length, tools: chat.tools.length })));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summaryCalls, 1);
  assert.equal(output.tools, 1);
});

test('bridge host configuration fails closed outside loopback', () => {
  const env = { ...process.env, BRIDGE_HOST: '0.0.0.0' };
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./bridge/config')"],
    { cwd: root, env, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BRIDGE_HOST must be loopback/);
});

test('tool compatibility is selected by profile instead of being hardcoded', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "const { config } = require('./bridge/config'); const { resolveToolProfile } = require('./bridge/tool-profile'); process.stdout.write(JSON.stringify({ configured: config.tools.profile, generic: resolveToolProfile('generic'), desktop: resolveToolProfile('codex-desktop') }));"],
    { cwd: root, env: { ...process.env, BRIDGE_TOOL_PROFILE: 'generic' }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configured, 'generic');
  assert.equal(output.generic.injectNodeRepl, false);
  assert.equal(output.generic.injectAutomation, false);
  assert.equal(output.desktop.injectNodeRepl, true);
  assert.equal(output.desktop.collaborationAliases, true);
});

test('unknown tool profiles fail closed instead of enabling Codex shims', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "const { resolveToolProfile } = require('./bridge/tool-profile'); resolveToolProfile('typo-or-unsupported-client');"],
    { cwd: root, env: process.env, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown BRIDGE_TOOL_PROFILE/);
});

test('capability combinations are data-driven but statuses remain code-owned', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "const { config } = require('./bridge/config'); process.stdout.write(JSON.stringify(config.capabilities.matrix));"],
    {
      cwd: root,
      env: {
        ...process.env,
        BRIDGE_CAPABILITY_MATRIX_JSON: JSON.stringify([
          { client: 'desktop', adapter: 'native-relay-v1', provider: 'provider-a', model: 'model-a', status: 'supported' },
          { client: 'generic', adapter: 'translation-v1', provider: 'provider-b', model: 'model-b' },
        ]),
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { client: 'desktop', adapter: 'native-relay-v1', provider: 'provider-a', model: 'model-a' },
    { client: 'generic', adapter: 'translation-v1', provider: 'provider-b', model: 'model-b' },
  ]);
});
