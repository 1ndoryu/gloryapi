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

test('versioned Responses schema bounds item, tool and content counts', () => {
  const result = validateResponsesRequest({
    input: [{ type: 'message', role: 'user', content: Array.from({ length: 3 }, () => ({ type: 'input_text', text: 'x' })) }],
    tools: Array.from({ length: 3 }, (_, index) => ({ type: 'function', name: `tool_${index}` })),
  }, { maxContentParts: 2, maxTools: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'content_count_bounds'));
  assert.ok(result.errors.some((error) => error.code === 'tool_count_bounds'));
});
