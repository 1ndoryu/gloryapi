const assert = require('node:assert/strict');
const test = require('node:test');
const { RESPONSES_SCHEMA_VERSION, validateResponsesRequest } = require('../bridge/responses-schema');

test('versioned Responses schema accepts supported fields and ignores unknown extensions', () => {
  const result = validateResponsesRequest({
    model: 'deepseek-v4-flash',
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }],
    future_extension: { preserved: true },
  });
  assert.equal(result.schema, RESPONSES_SCHEMA_VERSION);
  assert.equal(result.ok, true);
});

test('versioned Responses schema accepts unnamed discovery tools', () => {
  const result = validateResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [
      { type: 'tool_search' },
      { type: 'web_search' },
    ],
  });
  assert.equal(result.ok, true);
});

test('versioned Responses schema accepts Codex collaboration and lifecycle items', () => {
  const result = validateResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'agent_message', content: [{ type: 'input_text', text: 'subagent task' }] },
      { type: 'additional_tools', tools: [] },
      { type: 'local_shell_call', call_id: 'shell-1' },
      { type: 'compaction' },
    ],
  });
  assert.equal(result.ok, true);
});

test('versioned Responses schema rejects malformed known fields with bounded paths', () => {
  const result = validateResponsesRequest({
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }],
    stream: 'true',
    tools: [{ type: 'function' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.path), ['$.stream', '$.input[0].type', '$.tools[0].name']);
});

test('versioned Responses schema accepts null content on echoed reasoning/tool-call items', () => {
  const result = validateResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola' }] },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'pensamiento' }], content: null },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'respuesta' }] },
      { type: 'message', role: 'assistant', content: null },
      { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: '{}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sigue' }] },
    ],
  });
  assert.equal(result.ok, true);
});

// `content: null` is the wire form Codex Desktop echoes for assistant tool-call
// turns and reasoning items (text lives in `arguments`/`summary`). The bridge
// must not reject it at the boundary; the translator treats it as an empty list.
test('versioned Responses schema normalizes a single content part object', () => {
  const input = [{ type: 'message', role: 'user', content: { type: 'input_text', text: 'hola' } }];
  const result = validateResponsesRequest({ model: 'deepseek-v4-flash', input });
  assert.equal(result.ok, true);
});

test('versioned Responses schema still rejects a bare object content without type', () => {
  const result = validateResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [{ type: 'message', role: 'user', content: { text: 'hola' } }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ['string_or_array_required']);
});

test('versioned Responses schema bounds item, tool and content counts', () => {
  const result = validateResponsesRequest({
    input: [{ type: 'message', role: 'user', content: Array.from({ length: 3 }, () => ({ type: 'input_text', text: 'x' })) }],
    tools: Array.from({ length: 3 }, (_, index) => ({ type: 'function', name: `tool_${index}` })),
  }, { maxContentParts: 2, maxTools: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'content_count_bounds'));
  assert.ok(result.errors.some((error) => error.code === 'tool_count_bounds'));
});
