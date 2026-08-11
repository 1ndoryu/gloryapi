const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizePluginConfig } = require('../../../scripts/canary/plugin-config.cjs');
const TRUSTED_SOURCE = 'C:\\Users\\Test\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled';

const safeConfig = `
[marketplaces.openai-bundled]
last_updated = "2026-08-11T00:00:00Z"
source_type = "local"
source = '${TRUSTED_SOURCE}'

[plugins."browser@openai-bundled"]
enabled = true

[plugins."other@openai-bundled"]
enabled = true

[features]
js_repl = true
`;

test('sanitizes only the enabled bundled Browser plugin contract', () => {
  const result = sanitizePluginConfig(safeConfig, { expectedMarketplaceSource: TRUSTED_SOURCE });
  assert.match(result, /^\[marketplaces\.openai-bundled\]/m);
  assert.match(result, /^\[plugins\."browser@openai-bundled"\]/m);
  assert.match(result, /^enabled = true$/m);
  assert.match(result, /^\[features\]/m);
  assert.match(result, new RegExp(`^source = '${TRUSTED_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`, 'm'));
  assert.doesNotMatch(result, /other@openai-bundled/);
});

test('rewrites an equivalent extended Windows path to the canonical trusted path', () => {
  const extendedSource = TRUSTED_SOURCE.replace(/^C:/, '\\\\?\\C:');
  const input = safeConfig.replace(TRUSTED_SOURCE, extendedSource);
  const result = sanitizePluginConfig(input, { expectedMarketplaceSource: TRUSTED_SOURCE });
  assert.match(result, new RegExp(`^source = '${TRUSTED_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`, 'm'));
  assert.doesNotMatch(result, /\\\\\?\\C:/);
});

test('rejects a Browser plugin that is absent or disabled', () => {
  const options = { expectedMarketplaceSource: TRUSTED_SOURCE };
  assert.throws(() => sanitizePluginConfig(safeConfig.replace(/\[plugins\."browser@openai-bundled"\][\s\S]*?enabled = true/, '[plugins."visualize@openai-bundled"]\nenabled = true'), options), /requires the bundled marketplace/);
  assert.throws(() => sanitizePluginConfig(safeConfig.replace('enabled = true', 'enabled = false'), options), /requires browser@openai-bundled to be enabled/);
});

for (const sensitive of ['bearer', 'bearer_token', 'access_token', 'api_key', 'client_secret', 'authorization', 'mcp_servers', 'notify']) {
  test(`rejects sensitive config variant: ${sensitive}`, () => {
    const source = safeConfig.replace(`source = '${TRUSTED_SOURCE}'`, `source = 'https://example.invalid/${sensitive}'`);
    assert.throws(() => sanitizePluginConfig(source, { expectedMarketplaceSource: TRUSTED_SOURCE }), /sensitive field|unexpected marketplace source/);
  });
}

test('rejects unknown keys instead of copying arbitrary TOML', () => {
  assert.throws(() => sanitizePluginConfig(safeConfig.replace('enabled = true', 'command = "run-plugin"'), { expectedMarketplaceSource: TRUSTED_SOURCE }), /rejected config key/);
});

test('rejects remote, non-local, and unexpected marketplace sources', () => {
  const options = { expectedMarketplaceSource: TRUSTED_SOURCE };
  assert.throws(() => sanitizePluginConfig(safeConfig.replace('source_type = "local"', 'source_type = "remote"'), options), /local marketplace source/);
  assert.throws(() => sanitizePluginConfig(safeConfig.replace(TRUSTED_SOURCE, 'C:\\Users\\Test\\other-marketplace'), options), /unexpected marketplace source path/);
  assert.throws(() => sanitizePluginConfig(safeConfig.replace(TRUSTED_SOURCE, 'https://example.invalid/openai-bundled'), options), /unexpected marketplace source path/);
});
