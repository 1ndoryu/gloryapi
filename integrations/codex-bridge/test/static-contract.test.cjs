const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const bridgeSources = [
  'server.js',
  'config.js',
  'model-catalog.js',
  'reasoning-cache.js',
  'vision.js',
  'request-translator.js',
  'context-adapter.js',
  'responses-adapter.js',
  'tool-profile.js',
  'upstream-adapter.js',
  'response-handlers.js',
  'http-server.js',
].map((file) => read('bridge', file)).join('\n');
// Keep the historical variable name for the contract assertions: it now
// represents the canonical bridge source bundle, not one monolithic file.
const server = bridgeSources;
const endpointSecurity = read('bridge', 'endpoint-security.js');
const diagnostics = read('bridge', 'diagnostics.js');
const requestLog = read('bridge', 'request-log.js');
const canaryRunner = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'run-codex-canary.cjs'), 'utf8');
const appServerCanary = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'app-server-canary.cjs'), 'utf8');
const boundedServerClose = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'bounded-server-close.cjs'), 'utf8');
const canaryCleanup = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'canary-cleanup.cjs'), 'utf8');
const liveCanaryRunner = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'run-live-provider-audit.cjs'), 'utf8');
const canaryHttp = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'http-helpers.cjs'), 'utf8');
const pluginConfig = fs.readFileSync(path.resolve(root, '..', '..', 'scripts', 'canary', 'plugin-config.cjs'), 'utf8');
  const activationPreflight = read('mode', 'codex-activation-preflight.ps1');
  const upstreamAuth = fs.readFileSync(path.join(root, '..', '..', 'server', 'src', 'scripts', 'bridge-upstream-auth.ts'), 'utf8');
const responsesFixture = JSON.parse(read('fixtures', 'responses-contract-v1.json'));
const deterministicUpstream = read('test', 'deterministic-upstream.cjs');
const canaryScript = fs.readFileSync(path.join(root, '..', '..', 'scripts', 'canary', 'run-codex-canary.cjs'), 'utf8');
const trayScript = fs.readFileSync(path.join(root, '..', '..', 'integrations', 'glory-tray', 'GloryApiTray.ps1'), 'utf8');
const trayCore = fs.readFileSync(path.join(root, '..', '..', 'integrations', 'glory-tray', 'GloryApiTray.Core.psm1'), 'utf8');

test('the deterministic canary upstream is local-only and response-shaped', () => {
  assert.match(deterministicUpstream, /CANARY_OK/);
  assert.match(deterministicUpstream, /CANARY_TOOL_OK/);
  assert.match(deterministicUpstream, /CANARY_CODEX_TOOL_CASE/);
  assert.match(deterministicUpstream, /codexToolObserved/);
  assert.match(deterministicUpstream, /canary-andoryyu-fail/);
  assert.match(deterministicUpstream, /tool_calls/);
  assert.match(deterministicUpstream, /\/v1\/chat\/completions/);
  assert.match(deterministicUpstream, /data: \[DONE\]/);
  assert.match(deterministicUpstream, /Bearer \$\{candidate\}/);
  assert.doesNotMatch(deterministicUpstream, /https?:\/\/(?!127\.0\.0\.1)/);
});

test('the canonical bridge contains no credential literals', () => {
  assert.doesNotMatch(server, /(?:sk|freellmapi)-[A-Za-z0-9_-]{12,}/);
  assert.match(server, /GLORY_API_KEY/);
  assert.match(server, /env\.VISION_API_KEY/);
  assert.match(server, /env\.BRIDGE_CLIENT_TOKEN/);
  assert.match(server, /function clientAuthorized/);
  assert.match(server, /function upstreamAuthHeader/);
  assert.doesNotMatch(server, /Authorization:\s*authHeader\(req\)/);
});

test('the optional live audit is isolated and metadata-only', () => {
  assert.match(liveCanaryRunner, /GLORYAPI_LIVE_DB_PATH/);
  assert.match(liveCanaryRunner, /\.backup\(dbPath\)/);
  assert.match(liveCanaryRunner, /activeCodexConfigChanged: false/);
  assert.match(liveCanaryRunner, /fs\.rmSync\(runtimeDir/);
  assert.match(liveCanaryRunner, /createSafeChildEnv\(process\.env\)/);
  assert.match(liveCanaryRunner, /env: createSafeChildEnv\(process\.env, \{ GLORYAPI_DB_PATH: dbPath \}\)/);
  assert.match(liveCanaryRunner, /removeRuntimeDir/);
  assert.doesNotMatch(liveCanaryRunner, /config\.toml.*Write|Write.*config\.toml/i);
});

test('the local HTTP boundary is constrained', () => {
  assert.doesNotMatch(server, /Access-Control-Allow-Origin/);
  assert.match(server, /BRIDGE_MAX_BODY_BYTES/);
  assert.match(server, /BRIDGE_SEARCH_MAX_BYTES/);
  assert.match(server, /statusCode = 413/);
  assert.match(server, /maxActiveRequests: boundedEnvInt\('BRIDGE_MAX_ACTIVE_REQUESTS', 32/);
  assert.match(server, /code: 'bridge_busy'/);
  assert.match(server, /service: identity\.bridgeId/);
  assert.match(server, /req\.on\(['"]aborted['"], abortUpstream\)/);
  assert.match(server, /res\.on\(['"]close['"], abortUpstream\)/);
  assert.match(server, /response\.failed/);
  assert.match(server, /response\.completed/);
  assert.match(server, /function readinessChecks/);
  assert.match(server, /function getCapabilityMatrix/);
  assert.match(server, /codexDesktopE2E: \{ status: 'unverified'/);
  assert.match(server, /providerInference: \{ status: 'unverified'/);
  assert.match(server, /identity\.capabilitiesSchema/);
  assert.match(server, /identity\.lifecycleSchema/);
  assert.match(server, /function getLifecycle/);
  assert.doesNotMatch(server, /COMPACTION_ENABLED/);
  assert.match(server, /compaction: DISABLED \(native Codex owns context continuity\)/);
  assert.match(server, /bridge_lifecycle_not_ready/);
  assert.match(server, /requestShutdown/);
  assert.match(server, /url\.pathname === ['"]\/ready['"]/);
  assert.match(server, /url\.pathname === ['"]\/capabilities['"]/);
  assert.match(server, /models: modelList/);
  assert.match(canaryScript, /\/lifecycle/);
  assert.match(canaryScript, /glory-codex-lifecycle-v1/);
  assert.match(canaryScript, /glory-codex-capabilities-v2/);
  assert.match(server, /assertSafeVisionEndpoint/);
  assert.match(server, /assertSafeLoopbackUpstream/);
  assert.match(server, /redirect: 'error'/);
  assert.match(server, /function validateImageReference/);
  assert.match(server, /maxImageBytes: boundedEnvInt\('BRIDGE_MAX_IMAGE_BYTES', 8 \* 1024 \* 1024/);
  assert.match(server, /magic bytes do not match/);
  assert.match(endpointSecurity, /public HTTPS without embedded credentials/);
  assert.match(endpointSecurity, /explicit loopback HTTP/);
});

test('the tray validates local destinations before reading or forwarding its key', () => {
  assert.match(trayCore, /function Assert-LocalHttpUrl/);
  assert.match(trayCore, /127\.0\.0\.1/);
  assert.match(trayCore, /IPAddress\]::TryParse/);
  assert.match(trayCore, /-not \$isLoopbackLiteral/);
  assert.match(trayCore, /UserInfo/);
  assert.match(trayCore, /function Send-GloryJson/);
  assert.match(trayCore, /function Save-GloryControlOrder/);
  assert.match(trayScript, /Import-Module/);
  assert.match(trayScript, /\$BaseUrl = Assert-LocalHttpUrl/);
  assert.match(trayScript, /\$DashboardUrl = Assert-LocalHttpUrl/);
  assert.match(trayScript, /GLORYAPI_ADMIN_AUTH_TOKEN/);
  assert.doesNotMatch(trayScript, /GLORYAPI_CONTROL_KEY|GLORY_API_KEY|GLORYAPI_UNIFIED/);
});

test('the versioned Responses fixture covers lifecycle and tool invariants', () => {
  assert.equal(responsesFixture.fixtureSchema, 'glory-codex-responses-fixture-v1');
  assert.equal(responsesFixture.capabilitiesSchema, 'glory-codex-capabilities-v2');
  assert.equal(responsesFixture.requestSchema, 'glory-responses-request-v1');
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

test('the model selector is a versioned persisted catalog with an Auto-only fallback', () => {
  assert.match(server, /glory-bridge-model-catalog-v2/);
  assert.match(server, /BRIDGE_MODEL_CATALOG_JSON/);
  assert.match(server, /DEFAULT_MODEL_CATALOG/);
  assert.doesNotMatch(server, /deepseek-v4-pro/);
  assert.match(server, /nativeVision/);
  assert.match(server, /type: 'image_url', image_url: \{ url: image\.image_url \}/);
  assert.match(server, /resolveModelSelection\(MODEL_CATALOG, body\.model, DEFAULT_MODEL\)/);
  // La visión nativa solo se activa para modelos del catálogo marcados como
  // multimodales; los modelos de texto conservan la adaptación a texto.
  assert.match(server, /input_modalities: entry\.nativeVision === true \? \['text', 'image'\] : \['text'\]/);
});

test('web search does not fetch arbitrary model-provided URLs', () => {
  assert.match(server, /descarga directa de URL está deshabilitada/);
  assert.match(server, /Contenido web no confiable/);
  assert.doesNotMatch(server, /fetchWithTimeout\(q,/);
  assert.doesNotMatch(server, /type:\s*['"]function_call_output/);
  assert.match(server, /role:\s*['"]tool['"]/);
});

test('injected tools are conditional and deduped so upstream never sees duplicate names', () => {
  // Regression 2026-08-10: Codex Desktop's browser now exposes mcp__node_repl__js
  // directly in body.tools (namespace mcp__node_repl with children js, js_reset,
  // js_add_node_module_dir). The bridge injected it unconditionally too -> the
  // upstream rejected the whole request with 400 "Tool names must be unique" ->
  // Codex Desktop showed "Provider rejected the request".
  assert.match(server, /if \(!tools\.some\(\(t\) => t\.function && t\.function\.name === NODE_REPL_JS_TOOL\.function\.name\)\)/);
  assert.match(server, /if \(!tools\.some\(\(t\) => t\.function && t\.function\.name === AUTOMATION_UPDATE_TOOL\.function\.name\)\)/);
  assert.match(server, /Dedupe by wire name as a final safety net/);
  assert.match(server, /const seen = new Set\(\);/);
  assert.match(server, /if \(name && seen\.has\(name\)\) continue;/);
  assert.match(server, /return \{ tools: deduped, toolMap, customTools \};/);
  assert.doesNotMatch(server, /tools\.push\(NODE_REPL_JS_TOOL\);\n  toolMap\.set\('mcp__node_repl__js'/);
  assert.doesNotMatch(server, /tools\.push\(AUTOMATION_UPDATE_TOOL\);\n  toolMap\.set\('codex_app__automation_update'/);
});

test('diagnostic logs stay metadata-only for prompt-bearing paths', () => {
  assert.match(server, /api\[_-\]\?key/);
  assert.match(server, /queryChars=\$\{q\.length\}/);
  assert.doesNotMatch(server, /diagnosticFingerprint/);
  assert.doesNotMatch(server, /web search OK source=\$\{label\} query="\$\{q\}"/);
  assert.match(server, /formatRemoteFailure/);
  assert.match(server, /safe\.errorBytes/);
  assert.match(server, /if \(!config\.logging\.full\) delete safe\.error/);
  assert.doesNotMatch(server, /summarize failed HTTP.*await res\.text/s);
  assert.match(diagnostics, /Prompt-bearing remote failures/);
  assert.match(diagnostics, /formatRemoteFailure/);
  assert.match(requestLog, /function rotateIfNeeded/);
  assert.match(requestLog, /function createRequestLogger/);
  assert.match(requestLog, /queueCapacity/);
  assert.match(requestLog, /droppedLogEntries/);
  assert.match(requestLog, /logger\.flush/);
  assert.match(requestLog, /fs\.promises\.appendFile/);
  assert.match(server, /BRIDGE_REQUEST_LOG_MAX_BYTES/);
  assert.match(server, /BRIDGE_REQUEST_LOG_RETENTION/);
  assert.match(server, /BRIDGE_REQUEST_LOG_QUEUE_CAPACITY/);
  assert.match(server, /compact summary generated tokens=/);
  assert.doesNotMatch(server, /COMPACT SUMMARY.*\$\{summaryText\}/s);
  assert.doesNotMatch(server, /DEBUG\)\s+log\('chat request:',\s*JSON\.stringify\(chat\)/);
  assert.match(server, /if \(!config\.logging\.full\) delete safe\.body/);
});

test('the isolated home prepares a bridge model catalog for the Desktop picker', () => {
  const prepare = read('mode', 'prepare-isolated-home.ps1');
  const builder = read('mode', 'build-model-catalog.cjs');
  assert.match(prepare, /build-model-catalog\.cjs/);
  assert.match(prepare, /models_cache\.json/);
  assert.match(prepare, /Get-Command node/);
  assert.match(prepare, /No se pudo generar el catálogo de modelos del bridge/);
  // El picker de Desktop consume model_catalog_json (models.json), no /v1/models.
  assert.match(builder, /model_catalog_json/);
  assert.match(builder, /meta\/muse-spark-1\.2-contributor/);
  assert.doesNotMatch(builder, /deepseek\/deepseek-v4-pro/);
  assert.match(builder, /input_modalities/);
  assert.match(builder, /supports_image_detail_original/);
  assert.match(builder, /models_cache\.json-destino/);
  assert.match(builder, /fetched_at/);
  assert.match(builder, /pickerId/);
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
  assert.match(controller, /\[switch\]\$Preview/);
  assert.match(controller, /Invoke-ActivationPreflight/);
  assert.match(controller, /SkipHealth/);
  assert.match(controller, /controllerLink/);
  assert.match(controller, /modeSource/);
  assert.match(start, /BRIDGE_CLIENT_TOKEN/);
  assert.match(start, /\$authOutput = @\(/);
  assert.match(start, /GLORY_API_KEY/);
  assert.match(start, /\$upstreamOutput = @\(/);
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

test('canary exercises real Responses SSE and provider switching', () => {
  assert.match(canaryHttp, /async function requestResponsesStream/);
  assert.match(canaryRunner, /requestResponsesStream/);
  assert.match(canaryRunner, /stream: true/);
  assert.match(canaryRunner, /response\.output_text\.delta/);
  assert.match(canaryRunner, /response\.completed/);
  assert.match(canaryRunner, /\['andoryyu', 'opencode-zen', 'opencode-go'\]/);
  assert.match(canaryRunner, /CANARY_CONTINUITY_START/);
  assert.match(canaryRunner, /CANARY_PLUGIN_CASE/);
  assert.match(canaryRunner, /preparePluginCanaryConfig/);
  assert.match(canaryRunner, /features\.plugins=true/);
  assert.match(canaryRunner, /pluginSkillForwarding/);
  assert.match(canaryRunner, /runCodexAppServerCanary/);
  assert.match(canaryRunner, /appServerCompaction/);
  assert.match(canaryRunner, /closeServerBounded/);
  assert.match(boundedServerClose, /closeAllConnections/);
  assert.match(boundedServerClose, /closeIdleConnections/);
  assert.match(boundedServerClose, /did not close within/);
  assert.match(canaryCleanup, /cleanupCanaryResources/);
  assert.match(canaryCleanup, /remove runtime/);
  assert.match(canaryRunner, /process\.stdout\.write\(JSON\.stringify\(result\)/);
  assert.match(appServerCanary, /MAX_MESSAGE_HISTORY_BYTES/);
  assert.match(appServerCanary, /app-server/);
  assert.match(appServerCanary, /thread\/compact\/start/);
  assert.match(appServerCanary, /turn\/completed/);
  assert.match(appServerCanary, /createSafeChildEnv\(process\.env/);
  assert.match(appServerCanary, /CODEX_HOME/);
  assert.match(appServerCanary, /MAX_MESSAGE_HISTORY_BYTES/);
  assert.match(appServerCanary, /MAX_MESSAGE_HISTORY/);
  assert.match(appServerCanary, /totalOutputBytes/);
  assert.match(appServerCanary, /stdout exceeded the bounded canary limit/);
  assert.match(pluginConfig, /EXPECTED_PLUGIN/);
  assert.match(pluginConfig, /SENSITIVE_FIELD/);
  assert.match(pluginConfig, /bearer/);
});

test('activation preflight is read-only and detects the real Codex consumer contract', () => {
  assert.match(activationPreflight, /glory-codex-activation-preflight-v1/);
  assert.match(activationPreflight, /expectedAuthHelper/);
  assert.match(activationPreflight, /expectedUpstreamAuthHelper/);
  assert.match(activationPreflight, /unified key available through local GloryAPI vault/);
  assert.match(activationPreflight, /bridge-auth-helper/);
  assert.match(activationPreflight, /gloryapi-upstream-credential/);
  assert.match(activationPreflight, /GLORY_API_KEY/);
  assert.match(activationPreflight, /FREEL_API_KEY/);
  assert.match(activationPreflight, /codex-bridge-link/);
  assert.match(activationPreflight, /switch-chatgpt-link/);
  assert.match(activationPreflight, /switch-deepseek-link/);
  assert.match(activationPreflight, /experimental_bearer_token/);
  assert.match(activationPreflight, /providerDeclaration/);
  assert.match(activationPreflight, /providerSection/);
  assert.match(activationPreflight, /authSection/);
  assert.match(activationPreflight, /providerBody/);
  assert.match(activationPreflight, /authBody/);
  assert.match(activationPreflight, /modelContract/);
  assert.match(activationPreflight, /expectedAuthScript/);
  assert.match(activationPreflight, /-File/);
  assert.match(activationPreflight, /authPath/);
  assert.match(activationPreflight, /normalizedTarget/);
  assert.match(activationPreflight, /normalizedExpected/);
  assert.match(activationPreflight, /model_providers/);
  assert.match(activationPreflight, /\\\.auth/);
  assert.match(activationPreflight, /powershell\\\.exe/);
  assert.match(activationPreflight, /get-codex-auth\\\.ps1/);
  assert.match(activationPreflight, /127\.0\.0\.1:4100\/health/);
  assert.match(activationPreflight, /SkipHealth/);
  assert.match(activationPreflight, /healthChecked/);
  assert.match(activationPreflight, /gloryapi-codex-bridge/);
  assert.match(activationPreflight, /modelContract/);
  assert.doesNotMatch(activationPreflight, /Move-Item|Set-Content|Remove-Item|New-Item|Start-Process|Stop-Process/);
  assert.match(upstreamAuth, /readonly: true/);
  assert.match(upstreamAuth, /unified_api_key/);
  assert.match(upstreamAuth, /--print/);
  assert.match(upstreamAuth, /bridge-upstream-auth failed/);
});

test('the stop script verifies process identity before terminating', () => {
  const start = read('bridge', 'start-bridge.ps1');
  const stop = read('bridge', 'stop-bridge.ps1');
  const startRuntime = read('bridge', 'start-gloryapi.ps1');
  assert.match(startRuntime, /127\.0\.0\.1:3101\/api\/ping/);
  assert.match(startRuntime, /Get-NetTCPConnection -LocalPort 3101/);
  assert.match(startRuntime, /server\\dist\\index\.js/);
  assert.match(startRuntime, /\[string\]\$DatabasePath/);
  assert.match(startRuntime, /GLORYAPI_DB_PATH/);
  assert.match(startRuntime, /freellmapi/);
  assert.match(startRuntime, /\.gloryapi/);
  assert.match(startRuntime, /WindowStyle Hidden/);
  assert.match(start, /start-gloryapi\.ps1/);
  assert.match(start, /RuntimeHealth = ['"]http:\/\/127\.0\.0\.1:3101\/api\/ping['"]/);
  assert.match(start, /function Test-ExpectedRuntime/);
  assert.match(start, /function Ensure-GloryApiRuntime/);
  assert.match(start, /Ensure-GloryApiRuntime/);
  assert.match(start, /bridgeLink/);
  assert.match(start, /Resolve-Path/);
  assert.match(start, /BRIDGE_RUNTIME_DIR/);
  assert.match(start, /bridge-runtime/);
  assert.match(start, /\[string\]\$RuntimeDataDir/);
  assert.match(start, /\[string\]\$DatabasePath/);
  assert.match(start, /-DatabasePath \$DatabasePath/);
  assert.match(start, /freellmapi/);
  assert.match(start, /\[int\]\$Port = 4100/);
  assert.match(start, /GetFullPath\(\$RuntimeDataDir\)/);
  assert.match(stop, /Get-CimInstance Win32_Process/);
  assert.match(stop, /bridgeLink/);
  assert.match(stop, /bridge-runtime/);
  assert.match(stop, /\[string\]\$RuntimeDataDir/);
  assert.match(stop, /\[int\]\$Port = 4100/);
  assert.match(stop, /function Test-PortOwnedBy/);
  assert.match(stop, /no está verificado como listener del puerto \$Port/);
  assert.doesNotMatch(stop, /El puerto 4100 está ocupado/);
  assert.match(stop, /IndexOf\(\$ServerFile/);
  assert.match(stop, /se rechaza detenerlo/);
});

test('restart delegates to start-bridge -Restart and waits for port release', () => {
  const start = read('bridge', 'start-bridge.ps1');
  const stop = read('bridge', 'stop-bridge.ps1');
  const restart = read('bridge', 'restart-bridge.ps1');
  assert.match(restart, /start-bridge\.ps1.*-Restart/s);
  assert.match(restart, /\[switch\]\$Force/);
  assert.match(restart, /\[switch\]\$Runtime/);
  assert.match(restart, /gloryapi\.pid/);
  assert.match(restart, /server\\dist\\index\.js/);
  assert.match(restart, /\.gloryapi/);
  assert.match(start, /\[switch\]\$Restart/);
  assert.match(start, /\[switch\]\$Force/);
  assert.match(restart, /\[string\]\$RuntimeDataDir/);
  assert.match(restart, /\[string\]\$DatabasePath/);
  assert.match(restart, /\[int\]\$Port = 4100/);
  assert.match(restart, /-RuntimeDataDir \$RuntimeDataDir/);
  assert.match(restart, /-DatabasePath \$DatabasePath/);
  assert.match(start, /Reinicio solicitado/);
  assert.match(start, /usa -Restart para sustituirlo/);
  assert.match(stop, /\[switch\]\$Force/);
  assert.match(stop, /WaitReleaseSeconds/);
  assert.match(stop, /Puerto \$Port liberado/);
});
