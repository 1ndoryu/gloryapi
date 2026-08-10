const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const server = read('bridge', 'server.js');
const responsesFixture = JSON.parse(read('fixtures', 'responses-contract-v1.json'));
const deterministicUpstream = read('test', 'deterministic-upstream.cjs');
const canaryScript = fs.readFileSync(path.join(root, '..', '..', 'scripts', 'canary', 'run-codex-canary.cjs'), 'utf8');

test('the deterministic canary upstream is local-only and response-shaped', () => {
  assert.match(deterministicUpstream, /CANARY_OK/);
  assert.match(deterministicUpstream, /CANARY_TOOL_OK/);
  assert.match(deterministicUpstream, /canary-andoryyu-fail/);
  assert.match(deterministicUpstream, /tool_calls/);
  assert.match(deterministicUpstream, /\/v1\/chat\/completions/);
  assert.match(deterministicUpstream, /data: \[DONE\]/);
  assert.match(deterministicUpstream, /Bearer \$\{candidate\}/);
  assert.doesNotMatch(deterministicUpstream, /https?:\/\/(?!127\.0\.0\.1)/);
});

test('the canonical bridge contains no credential literals', () => {
  assert.doesNotMatch(server, /(?:sk|freellmapi)-[A-Za-z0-9_-]{12,}/);
  assert.match(server, /process\.env\.GLORY_API_KEY/);
  assert.match(server, /process\.env\.VISION_API_KEY/);
  assert.match(server, /process\.env\.BRIDGE_CLIENT_TOKEN/);
  assert.match(server, /function clientAuthorized/);
  assert.match(server, /function upstreamAuthHeader/);
  assert.doesNotMatch(server, /Authorization:\s*authHeader\(req\)/);
});

test('the local HTTP boundary is constrained', () => {
  assert.doesNotMatch(server, /Access-Control-Allow-Origin/);
  assert.match(server, /BRIDGE_MAX_BODY_BYTES/);
  assert.match(server, /BRIDGE_SEARCH_MAX_BYTES/);
  assert.match(server, /statusCode = 413/);
  assert.match(server, /service: BRIDGE_ID/);
  assert.match(server, /req\.on\(['"]aborted['"], abortUpstream\)/);
  assert.match(server, /res\.on\(['"]close['"], abortUpstream\)/);
  assert.match(server, /response\.failed/);
  assert.match(server, /response\.completed/);
  assert.match(server, /function readinessChecks/);
  assert.match(server, /function getCapabilityMatrix/);
  assert.match(server, /codexDesktopE2E: \{ status: 'unverified'/);
  assert.match(server, /providerInference: \{ status: 'unverified'/);
  assert.match(server, /CAPABILITIES_SCHEMA/);
  assert.match(server, /LIFECYCLE_SCHEMA/);
  assert.match(server, /function getLifecycle/);
  assert.match(server, /bridge_lifecycle_not_ready/);
  assert.match(server, /requestShutdown/);
  assert.match(server, /url\.pathname === ['"]\/ready['"]/);
  assert.match(server, /url\.pathname === ['"]\/capabilities['"]/);
  assert.match(server, /models: modelList/);
  assert.match(canaryScript, /\/lifecycle/);
  assert.match(canaryScript, /glory-codex-lifecycle-v1/);
  assert.match(canaryScript, /glory-codex-capabilities-v2/);
});

test('the versioned Responses fixture covers lifecycle and tool invariants', () => {
  assert.equal(responsesFixture.fixtureSchema, 'glory-codex-responses-fixture-v1');
  assert.equal(responsesFixture.capabilitiesSchema, 'glory-codex-capabilities-v2');
  assert.equal(responsesFixture.lifecycleSchema, 'glory-codex-lifecycle-v1');
  assert.deepEqual(responsesFixture.lifecycle.states, ['starting', 'ready', 'blocked', 'draining', 'stopped']);
  assert.deepEqual(responsesFixture.lifecycle.readyRequires, ['clientAuthConfigured', 'upstreamAuthConfigured', 'contractCompatible']);
  assert.deepEqual(responsesFixture.lifecycle.drainGuarantees, ['reject_new_requests', 'allow_active_request_to_finish', 'force_close_after_bounded_timeout']);
  assert.equal(responsesFixture.lifecycle.recovery, 'restart_sidecar');
  assert.equal(responsesFixture.adapterVersion, 'gloryapi-codex-bridge-v1');
  assert.equal(responsesFixture.gloryApiContract, 'chat-completions-v1');
  assert.deepEqual(
    responsesFixture.cases.map((entry) => entry.id),
    [
      'text-stream',
      'reasoning-and-tool-call',
      'upstream-error',
      'client-cancel',
      'custom-tool',
      'namespaced-tool',
      'vision-lossy-adaptation',
    ],
  );

  for (const entry of responsesFixture.cases) {
    assert.equal(entry.request.model, 'deepseek-v4-flash');
    assert.ok(Array.isArray(entry.request.input));
    assert.ok(entry.expected.terminal);
    const requestSerialized = JSON.stringify(entry.request);
    assert.doesNotMatch(requestSerialized, /Authorization|apiKey|secret/i);
  }

  const toolCase = responsesFixture.cases.find((entry) => entry.id === 'reasoning-and-tool-call');
  assert.ok(toolCase.expected.invariants.includes('reasoning_item_precedes_reasoning_delta'));
  assert.ok(toolCase.expected.mustNotContain.includes('function_call_output'));
  const cancelCase = responsesFixture.cases.find((entry) => entry.id === 'client-cancel');
  assert.equal(cancelCase.expected.upstreamAbort, true);
  assert.deepEqual(cancelCase.expected.mustNotEmit, ['response.completed']);

  const customCase = responsesFixture.cases.find((entry) => entry.id === 'custom-tool');
  assert.equal(customCase.request.tools[0].type, 'custom');
  assert.equal(customCase.expected.outputItemType, 'custom_tool_call');
  assert.match(server, /type === 'custom'/);
  assert.match(server, /type: 'custom_tool_call'/);

  const namespaceCase = responsesFixture.cases.find((entry) => entry.id === 'namespaced-tool');
  assert.equal(namespaceCase.request.tools[0].type, 'namespace');
  assert.equal(namespaceCase.expected.outputNamespace, 'mcp');
  assert.match(server, /type === 'namespace'/);
  assert.match(server, /namespace: 'mcp__node_repl'/);

  const visionCase = responsesFixture.cases.find((entry) => entry.id === 'vision-lossy-adaptation');
  assert.equal(visionCase.expected.visionMode, 'lossy-text-adaptation');
  assert.equal(visionCase.expected.mustNotForwardInputImage, true);
  assert.match(server, /type === 'input_image'/);
  assert.match(server, /VISION_DISABLE/);
});

test('web search does not fetch arbitrary model-provided URLs', () => {
  assert.match(server, /descarga directa de URL está deshabilitada/);
  assert.match(server, /Contenido web no confiable/);
  assert.doesNotMatch(server, /fetchWithTimeout\(q,/);
  assert.doesNotMatch(server, /type:\s*['"]function_call_output/);
  assert.match(server, /role:\s*['"]tool['"]/);
});

test('mode switch scripts delegate to the fail-closed controller', () => {
  const chatgpt = read('mode', 'switch-chatgpt.ps1');
  const deepseek = read('mode', 'switch-deepseek.ps1');
  const controller = read('mode', 'codex-mode.ps1');
  const start = read('bridge', 'start-bridge.ps1');
  const authCommand = read('mode', 'get-codex-auth.ps1');
  const canary = read('mode', 'prepare-canary-profile.ps1');
  assert.match(chatgpt, /codex-mode\.ps1.*-Mode chatgpt/s);
  assert.match(deepseek, /codex-mode\.ps1.*-Mode deepseek/s);
  assert.match(controller, /Join-Path \$env:USERPROFILE ['"]\.codex['"]/);
  assert.match(start, /BRIDGE_CLIENT_TOKEN/);
  assert.match(start, /GLORY_API_KEY/);
  assert.match(start, /bridge-auth\.js.*--print/s);
  assert.match(authCommand, /bridge-auth\.js/);
  assert.match(authCommand, /--print/);
  assert.match(canary, /gloryapi-canary/);
  assert.match(canary, /BridgePort/);
  assert.match(canary, /model_provider/);
  assert.match(canary, /wire_api = [\"']responses[\"']/);
  assert.match(canary, /supports_websockets = false/);
  assert.match(canary, /requires_openai_auth = false/);
  assert.match(canary, /\.auth/);
  assert.match(canary, /get-codex-auth\.ps1/);
  assert.doesNotMatch(canary, /experimental_bearer_token/);
  assert.doesNotMatch(canary, /config\.toml.*Move-Item/);
});

test('the stop script verifies process identity before terminating', () => {
  const stop = read('bridge', 'stop-bridge.ps1');
  assert.match(stop, /Get-CimInstance Win32_Process/);
  assert.match(stop, /IndexOf\(\$ServerFile/);
  assert.match(stop, /se rechaza detenerlo/);
});
