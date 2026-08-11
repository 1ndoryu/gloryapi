const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeterministicUpstream } = require('./deterministic-upstream.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function post(base, token, marker, signal) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: marker }],
    }),
    signal,
  });
}

test('deterministic upstream covers fragmented Unicode, truncation, and cancellation', async t => {
  const upstream = await createDeterministicUpstream({
    token: ['canary-andoryyu-fail', 'canary-zen'],
    port: 0,
  });
  t.after(() => new Promise(resolve => upstream.server.close(resolve)));
  const base = `http://127.0.0.1:${upstream.port}`;

  const unicode = await post(base, 'canary-zen', 'CANARY_UNICODE_CASE');
  const unicodeBody = await unicode.text();
  assert.equal(unicode.status, 200);
  assert.match(unicodeBody, /🌍/);
  assert.match(unicodeBody, /\[DONE\]/);

  const foreignToolset = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer canary-andoryyu-fail', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      tools: [{ type: 'function', function: { name: 'foreign_tool' } }],
      messages: [{ role: 'user', content: 'CANARY_FOREIGN_TOOLSET_CASE' }],
    }),
  });
  const foreignBody = await foreignToolset.json();
  assert.equal(foreignToolset.status, 429);
  assert.equal(foreignBody.model, 'ling-3.0-tiny:free');

  const truncated = await post(base, 'canary-andoryyu-fail', 'CANARY_TRUNCATION_CASE');
  const truncatedBody = await truncated.text();
  assert.equal(truncated.status, 200);
  assert.doesNotMatch(truncatedBody, /\[DONE\]/);
  assert.equal(upstream.state.truncatedObserved, true);

  const controller = new AbortController();
  const cancelled = post(base, 'canary-andoryyu-fail', 'CANARY_CANCEL_CASE', controller.signal).catch(() => undefined);
  await sleep(50);
  controller.abort();
  await cancelled;
  for (let attempt = 0; attempt < 20 && !upstream.state.cancelObserved; attempt += 1) await sleep(25);
  assert.equal(upstream.state.cancelObserved, true);
});

test('deterministic upstream records only the expected Codex tool result', async t => {
  const upstream = await createDeterministicUpstream({ token: 'canary-tool', port: 0 });
  t.after(() => new Promise(resolve => upstream.server.close(resolve)));
  const base = `http://127.0.0.1:${upstream.port}`;
  const request = (messages) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer canary-tool', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      tools: [{ type: 'function', function: { name: 'shell_command' } }],
      messages,
    }),
  });

  const initial = await request([{ role: 'user', content: 'CANARY_CODEX_TOOL_CASE' }]);
  const initialBody = await initial.json();
  assert.equal(initial.status, 200);
  assert.equal(initialBody.choices[0].message.tool_calls[0].function.name, 'shell_command');

  const wrongResult = await request([
    { role: 'user', content: 'CANARY_CODEX_TOOL_CASE' },
    { role: 'tool', tool_call_id: 'other-call', content: 'CANARY_TOOL_EXECUTED' },
  ]);
  assert.equal(wrongResult.status, 200);
  await wrongResult.arrayBuffer();
  assert.equal(upstream.state.codexToolObserved, false);

  const expectedResult = await request([
    { role: 'user', content: 'CANARY_CODEX_TOOL_CASE' },
    { role: 'tool', tool_call_id: 'canary-codex-tool-call-v1', content: 'CANARY_TOOL_EXECUTED' },
  ]);
  const expectedBody = await expectedResult.json();
  assert.equal(expectedBody.choices[0].message.content, 'CANARY_CODEX_TOOL_OK');
  assert.equal(upstream.state.codexToolObserved, true);
});

test('deterministic upstream preserves a tool call when the provider changes', async t => {
  const upstream = await createDeterministicUpstream({
    token: ['canary-andoryyu-fail', 'canary-go'],
    port: 0,
  });
  t.after(() => new Promise(resolve => upstream.server.close(resolve)));
  const base = `http://127.0.0.1:${upstream.port}`;
  const tools = [{ type: 'function', function: { name: 'switch_tool' } }];
  const request = (token, messages) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', tools, messages }),
  });

  const initial = await request('canary-andoryyu-fail', [
    { role: 'user', content: 'CANARY_SWITCH_TOOL_CASE' },
  ]);
  const initialBody = await initial.json();
  assert.equal(initial.status, 200);
  assert.equal(initialBody.choices[0].message.tool_calls[0].id, 'canary-switch-tool-call-v1');
  assert.deepEqual(upstream.state.toolSwitchProviders, ['andoryyu']);

  const assistantCall = {
    role: 'assistant',
    tool_calls: [{
      id: 'canary-switch-tool-call-v1',
      type: 'function',
      function: { name: 'switch_tool', arguments: '{"value":"CANARY_SWITCH_TOOL_ARGUMENT"}' },
    }],
  };
  const toolResult = { role: 'tool', tool_call_id: 'canary-switch-tool-call-v1', content: 'CANARY_SWITCH_TOOL_RESULT' };
  const missingCall = await request('canary-go', [
    { role: 'user', content: 'CANARY_SWITCH_TOOL_CASE' },
    toolResult,
  ]);
  assert.equal(missingCall.status, 422);
  await missingCall.arrayBuffer();
  const reordered = await request('canary-go', [
    { role: 'user', content: 'CANARY_SWITCH_TOOL_CASE' },
    toolResult,
    assistantCall,
  ]);
  assert.equal(reordered.status, 422);
  await reordered.arrayBuffer();

  const continued = await request('canary-go', [
    { role: 'user', content: 'CANARY_SWITCH_TOOL_CASE' },
    assistantCall,
    toolResult,
  ]);
  const continuedBody = await continued.json();
  assert.equal(continued.status, 200);
  assert.equal(continuedBody.choices[0].message.content, 'CANARY_SWITCH_TOOL_OK');
  assert.deepEqual(upstream.state.toolSwitchProviders, ['andoryyu', 'opencode-go']);
});

test('deterministic upstream validates the Codex plugin and MCP toolset', async t => {
  const upstream = await createDeterministicUpstream({ token: 'canary-plugin', port: 0 });
  t.after(() => new Promise(resolve => upstream.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${upstream.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer canary-plugin', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      tools: [
        { type: 'function', function: { name: 'mcp__node_repl__js' } },
        { type: 'function', function: { name: 'tool_search' } },
        { type: 'function', function: { name: 'codex_app__automation_update' } },
        { type: 'function', function: { name: 'collaboration__spawn_agent' } },
      ],
      messages: [{ role: 'user', content: 'CANARY_PLUGIN_CASE' }],
    }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(upstream.state.pluginToolsetObserved, true);
});

test('deterministic upstream rejects incomplete or reordered continuity history', async t => {
  const upstream = await createDeterministicUpstream({ token: 'canary-continuity', port: 0 });
  t.after(() => new Promise(resolve => upstream.server.close(resolve)));
  const post = input => fetch(`http://127.0.0.1:${upstream.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer canary-continuity', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: input }),
  });
  const incomplete = await post([
    { role: 'user', content: 'CANARY_CONTINUITY_START' },
    { role: 'user', content: 'CANARY_CONTINUITY_NEXT' },
  ]);
  assert.equal(incomplete.status, 422);
  await incomplete.arrayBuffer();
  const reordered = await post([
    { role: 'user', content: 'CANARY_CONTINUITY_NEXT' },
    { role: 'assistant', content: 'CANARY_CONTEXT_PRESERVED' },
    { role: 'user', content: 'CANARY_CONTINUITY_START' },
  ]);
  assert.equal(reordered.status, 422);
  await reordered.arrayBuffer();
});
