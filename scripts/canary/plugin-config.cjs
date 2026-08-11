'use strict';

const path = require('node:path');

const EXPECTED_MARKETPLACE = 'marketplaces.openai-bundled';
const EXPECTED_PLUGIN = 'plugins."browser@openai-bundled"';
const SENSITIVE_FIELD = /api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|client[_-]?secret|secret|password|credential|authorization|cookie|mcp[_-]?servers?|notify|codex_home|\btoken\b/i;

function tomlString(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return null;
}

function normalizedWindowsPath(value) {
  return path.win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
}

function sectionKind(section) {
  if (section === EXPECTED_MARKETPLACE) return 'marketplace';
  if (section === EXPECTED_PLUGIN) return 'plugin';
  if (section === 'features') return 'features';
  return null;
}

function allowedKey(kind, key) {
  if (kind === 'marketplace') return new Set(['last_updated', 'source_type', 'source']).has(key);
  if (kind === 'plugin') return key === 'enabled';
  if (kind === 'features') return key === 'js_repl';
  return false;
}

function validateValue(kind, key, value, line) {
  if (SENSITIVE_FIELD.test(`${key} ${value}`)) {
    throw new Error(`plugin canary rejected sensitive field: ${key}`);
  }
  if (!value || value.length > 512 || /[\r\n]/.test(value)) {
    throw new Error(`plugin canary rejected invalid value for ${key}`);
  }
  if ((kind === 'plugin' || kind === 'features') && !/^(?:true|false)$/.test(value)) {
    throw new Error(`plugin canary only accepts boolean ${key}: ${line}`);
  }
}

function sanitizePluginConfig(source, { expectedMarketplaceSource } = {}) {
  if (!expectedMarketplaceSource) throw new Error('plugin canary requires an explicit trusted marketplace source');
  const blocks = [];
  let active = null;
  const flush = () => {
    if (active) blocks.push(active);
    active = null;
  };

  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      flush();
      const kind = sectionKind(header[1]);
      if (kind) active = { header: line, kind, lines: [] };
      continue;
    }
    if (!active || line === '' || line.startsWith('#')) continue;
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(\S(?:.*\S)?)$/);
    if (!assignment) throw new Error(`plugin canary rejected unsupported TOML line: ${line}`);
    const [, key, value] = assignment;
    if (!allowedKey(active.kind, key)) {
      throw new Error(`plugin canary rejected config key: ${key}`);
    }
    validateValue(active.kind, key, value, line);
    active.lines.push(`${key} = ${value}`);
  }
  flush();

  const marketplace = blocks.find(block => block.header === `[${EXPECTED_MARKETPLACE}]`);
  const plugin = blocks.find(block => block.header === `[${EXPECTED_PLUGIN}]`);
  const features = blocks.find(block => block.header === '[features]');
  if (!marketplace || !plugin || !features) {
    throw new Error('plugin canary requires the bundled marketplace, Browser plugin, and features sections');
  }
  const marketplaceSourceType = marketplace.lines.find(line => line.startsWith('source_type = '));
  const marketplaceSourceLine = marketplace.lines.find(line => line.startsWith('source = '));
  const marketplaceSource = marketplaceSourceLine ? tomlString(marketplaceSourceLine.slice('source = '.length)) : null;
  if (marketplaceSourceType !== 'source_type = "local"' || !marketplaceSource) {
    throw new Error('plugin canary requires a local marketplace source');
  }
  if (normalizedWindowsPath(marketplaceSource) !== normalizedWindowsPath(expectedMarketplaceSource)) {
    throw new Error('plugin canary rejected an unexpected marketplace source path');
  }
  if (!plugin.lines.includes('enabled = true')) {
    throw new Error('plugin canary requires browser@openai-bundled to be enabled');
  }
  const canonicalMarketplace = {
    ...marketplace,
    lines: marketplace.lines.map(line => line.startsWith('source = ')
      ? `source = '${expectedMarketplaceSource.replace(/'/g, "''")}'`
      : line),
  };
  return [canonicalMarketplace, plugin, features]
    .map(block => [block.header, ...block.lines].join('\n'))
    .join('\n\n') + '\n';
}

module.exports = {
  EXPECTED_MARKETPLACE,
  EXPECTED_PLUGIN,
  sanitizePluginConfig,
};
