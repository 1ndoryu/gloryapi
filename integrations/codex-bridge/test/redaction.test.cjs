const assert = require('node:assert/strict');
const test = require('node:test');
const { redactHeaders, redactSseData, redactString, redactValue } = require('../bridge/redaction');

test('redacts bearer, provider token formats and key-value secrets', () => {
  const value = redactString('Authorization: Bearer abc.def; api_key=sk-live-secret-value; ghp_1234567890abcdef');
  assert.doesNotMatch(value, /abc\.def|sk-live|ghp_123/);
  assert.match(value, /REDACTED/);
});

test('redacts nested headers and tool arguments without redacting safe metadata', () => {
  const value = redactValue({
    headers: { authorization: 'Bearer secret', 'x-request-id': 'req_1' },
    tool: { name: 'shell_command', arguments: { command: 'Get-Date', apiKey: 'secret' } },
  });
  assert.equal(value.headers.authorization, '[REDACTED]');
  assert.equal(value.headers['x-request-id'], 'req_1');
  assert.equal(value.tool.arguments.command, 'Get-Date');
  assert.equal(value.tool.arguments.apiKey, '[REDACTED]');
  assert.equal(redactHeaders({ Authorization: 'Bearer secret', 'X-Glory-Request-Id': 'req_1' }).Authorization, '[REDACTED]');
});

test('redacts JSON SSE payloads and preserves DONE marker', () => {
  const safe = redactSseData(JSON.stringify({ type: 'response.failed', error: { token: 'secret', code: 'timeout' } }));
  assert.doesNotMatch(safe, /secret/);
  assert.match(safe, /timeout/);
  assert.equal(redactSseData('[DONE]'), '[DONE]');
});
