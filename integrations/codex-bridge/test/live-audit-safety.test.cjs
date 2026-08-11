const assert = require('node:assert/strict');
const test = require('node:test');
const { SAFE_PARENT_ENV, createSafeChildEnv } = require('../../../scripts/canary/isolate-env.cjs');

test('live audit child environment is an allowlist, not a credential denylist', () => {
  const child = createSafeChildEnv({
    Path: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\Owner',
    OPENAI_API_KEY: 'must-not-pass',
    GLORY_API_KEY: 'must-not-pass',
    PROVIDER_SECRET: 'must-not-pass',
    NODE_OPTIONS: '--require=malicious',
  });
  assert.ok(SAFE_PARENT_ENV.includes('Path'));
  assert.equal(child.Path, 'C:\\Windows');
  assert.equal(child.TEMP, 'C:\\Temp');
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.GLORY_API_KEY, undefined);
  assert.equal(child.PROVIDER_SECRET, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
});

test('live audit overrides are explicit and do not reintroduce the parent environment', () => {
  const child = createSafeChildEnv({ OPENAI_API_KEY: 'secret' }, {
    GLORYAPI_DB_PATH: 'temporary.db',
    BRIDGE_CLIENT_TOKEN: 'temporary-client-token',
  });
  assert.deepEqual(child, {
    GLORYAPI_DB_PATH: 'temporary.db',
    BRIDGE_CLIENT_TOKEN: 'temporary-client-token',
  });
});
