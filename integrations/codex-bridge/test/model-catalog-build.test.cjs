'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const builder = path.join(root, 'mode', 'build-model-catalog.cjs');

function runBuilder(sourcePath, outputPath, cachePath, metadataSourcePath, catalogPath) {
  const args = [builder, sourcePath, outputPath];
  if (cachePath) args.push(cachePath);
  if (metadataSourcePath) args.push(metadataSourcePath);
  if (catalogPath) args.push(catalogPath);
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
  });
}

test('build-model-catalog clones the real template and exposes the CommandCode picker entries', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-catalog-'));
  try {
    const sourcePath = path.join(temporaryRoot, 'source-models.json');
    const outputPath = path.join(temporaryRoot, 'bridge-models.json');
    const cachePath = path.join(temporaryRoot, 'models_cache.json');
    const metadataSourcePath = path.join(temporaryRoot, 'source-cache.json');
    const catalogPath = path.join(temporaryRoot, 'catalog.json');
    const template = {
      slug: 'deepseek-v4-flash',
      input_modalities: ['text'],
      context_window: 150000,
      base_instructions: 'Codex system prompt',
      model_messages: { instructions_template: 'template', instructions_variables: {} },
      priority: 1,
    };
    fs.writeFileSync(sourcePath, JSON.stringify({ models: [template] }), 'utf8');
    fs.writeFileSync(metadataSourcePath, JSON.stringify({
      fetched_at: '2026-01-01T00:00:00.000Z',
      etag: 'old-etag',
      client_version: '0.147.0-test',
      models: [{ slug: 'official-model' }],
    }), 'utf8');
    fs.writeFileSync(catalogPath, JSON.stringify({ entries: [
      { id: 'deepseek/deepseek-v4-flash', pickerId: 'gpt-5.6-sol', provider: 'commandcode', displayName: 'DeepSeek V4 Flash', supportsReasoning: true },
      { id: 'deepseek-v4-flash:free', pickerId: 'gpt-5.5', provider: 'tokenharbor', displayName: 'DeepSeek Flash Free', supportsReasoning: false },
      { id: 'meta/muse-spark-1.2-contributor', pickerId: 'gpt-5.6-terra', provider: 'commandcode', displayName: 'Muse Spark', nativeVision: true, supportsReasoning: true },
    ] }), 'utf8');

    const result = runBuilder(sourcePath, outputPath, cachePath, metadataSourcePath, catalogPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const catalog = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache.models.length, catalog.models.length);
    assert.equal(cache.etag, null);
    assert.equal(cache.client_version, '0.147.0-test');
    assert.match(cache.fetched_at, /^20\d\d-/);
    assert.deepEqual(catalog.models.map((entry) => entry.slug), [
      'codex-auto-review',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
    ]);
    assert.equal(catalog.models[0].display_name, 'Auto (router de GloryAPI)');
    const muse = catalog.models.find((entry) => entry.slug === 'gpt-5.6-terra');
    assert.deepEqual(muse.input_modalities, ['text', 'image']);
    assert.equal(muse.supports_image_detail_original, true);
    assert.equal(muse.base_instructions, 'Codex system prompt');
    const flash = catalog.models.find((entry) => entry.slug === 'gpt-5.6-sol');
    assert.deepEqual(flash.input_modalities, ['text']);
    assert.equal(flash.base_instructions, 'Codex system prompt');
    assert.equal(muse.supports_reasoning, true);
    assert.deepEqual(muse.supported_reasoning_levels.map((level) => level.effort), ['low', 'high', 'max']);
    const tokenHarbor = catalog.models.find((entry) => entry.slug === 'gpt-5.5');
    assert.equal(tokenHarbor.supports_reasoning, false);
    assert.deepEqual(tokenHarbor.supported_reasoning_levels, []);
    assert.ok(catalog.models.every((entry) => entry.context_window === 150000));
    assert.ok(catalog.models.every((entry) => entry.max_context_window === 150000));
    assert.ok(catalog.models.every((entry) => entry.auto_compact_token_limit === 150000));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('build-model-catalog falls back to a minimal catalog without a source template', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-catalog-min-'));
  try {
    const outputPath = path.join(temporaryRoot, 'bridge-models.json');
    const result = runBuilder('-', outputPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const catalog = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].slug, 'codex-auto-review');
    assert.equal(catalog.models[0].visibility, 'list');
    assert.equal(catalog.models[0].supported_in_api, true);
    assert.equal(catalog.models[0].supports_reasoning, true);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('build-model-catalog creates a first-launch cache with Codex metadata', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryapi-catalog-empty-'));
  try {
    const outputPath = path.join(temporaryRoot, 'bridge-models.json');
    const cachePath = path.join(temporaryRoot, 'models_cache.json');
    const metadataSourcePath = path.join(temporaryRoot, 'source-cache.json');
    fs.writeFileSync(metadataSourcePath, JSON.stringify({ client_version: '0.147.0-empty-test' }), 'utf8');
    const result = runBuilder('-', outputPath, cachePath, metadataSourcePath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache.client_version, '0.147.0-empty-test');
    assert.equal(cache.etag, null);
    assert.equal(cache.models.length, 1);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
