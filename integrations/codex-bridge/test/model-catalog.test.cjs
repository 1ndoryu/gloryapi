'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL_CATALOG_SCHEMA,
  DEFAULT_MODEL_CATALOG,
  BRIDGE_CONTEXT_WINDOW,
  parseModelCatalog,
  resolveModelSelection,
  hasNativeVision,
} = require('../bridge/model-catalog');

test('the default catalog is versioned, keeps auto first and exposes the three CommandCode models', () => {
  assert.equal(MODEL_CATALOG_SCHEMA, 'glory-bridge-model-catalog-v1');
  assert.equal(DEFAULT_MODEL_CATALOG[0].id, 'auto');
  const ids = DEFAULT_MODEL_CATALOG.map((entry) => entry.id);
  assert.ok(ids.includes('deepseek/deepseek-v4-flash'));
  assert.ok(ids.includes('meta/muse-spark-1.2-contributor'));
  assert.ok(ids.includes('deepseek/deepseek-v4-pro'));
  // Solo Muse declara visión nativa.
  const muse = DEFAULT_MODEL_CATALOG.find((entry) => entry.id === 'meta/muse-spark-1.2-contributor');
  assert.equal(muse.nativeVision, true);
  assert.equal(muse.supportsReasoning, true);
  assert.equal(DEFAULT_MODEL_CATALOG.find((entry) => entry.id === 'deepseek/deepseek-v4-flash').nativeVision, false);
  assert.equal(DEFAULT_MODEL_CATALOG.find((entry) => entry.id === 'deepseek-v4-flash:free').supportsReasoning, false);
  assert.equal(DEFAULT_MODEL_CATALOG.find((entry) => entry.id === 'deepseek/deepseek-v4-pro').nativeVision, false);
  assert.ok(DEFAULT_MODEL_CATALOG.every((entry) => entry.contextWindow === BRIDGE_CONTEXT_WINDOW));
});

test('resolveModelSelection maps missing and auto to the configured default', () => {
  const defaultModel = 'deepseek-v4-flash';
  assert.deepEqual(resolveModelSelection(DEFAULT_MODEL_CATALOG, undefined, defaultModel), {
    id: defaultModel,
    provider: 'auto',
    nativeVision: false,
    supportsReasoning: true,
    explicit: false,
  });
  assert.deepEqual(resolveModelSelection(DEFAULT_MODEL_CATALOG, 'auto', defaultModel), {
    id: defaultModel,
    provider: 'auto',
    nativeVision: false,
    supportsReasoning: true,
    explicit: false,
  });
});

test('resolveModelSelection pins CommandCode models to their exact id and vision flag', () => {
  const flash = resolveModelSelection(DEFAULT_MODEL_CATALOG, 'deepseek/deepseek-v4-flash', 'deepseek-v4-flash');
  assert.deepEqual(flash, {
    id: 'deepseek/deepseek-v4-flash',
    provider: 'commandcode',
    nativeVision: false,
    supportsReasoning: true,
    explicit: true,
  });
  const muse = resolveModelSelection(DEFAULT_MODEL_CATALOG, 'meta/muse-spark-1.2-contributor', 'deepseek-v4-flash');
  assert.deepEqual(muse, {
    id: 'meta/muse-spark-1.2-contributor',
    provider: 'commandcode',
    nativeVision: true,
    supportsReasoning: true,
    explicit: true,
  });
});

test('resolveModelSelection maps Desktop-safe picker ids back to real provider ids', () => {
  const selection = resolveModelSelection(DEFAULT_MODEL_CATALOG, 'gpt-5.6-terra', 'deepseek-v4-flash');
  assert.deepEqual(selection, {
    id: 'meta/muse-spark-1.2-contributor',
    provider: 'commandcode',
    nativeVision: true,
    supportsReasoning: true,
    explicit: true,
  });
});

test('an unknown model passes through fail-closed (no native vision, GloryAPI returns the error)', () => {
  const selection = resolveModelSelection(DEFAULT_MODEL_CATALOG, 'some/unknown-model', 'deepseek-v4-flash');
  assert.deepEqual(selection, {
    id: 'some/unknown-model',
    provider: 'unknown',
    nativeVision: false,
    supportsReasoning: false,
    explicit: true,
  });
  assert.equal(hasNativeVision(DEFAULT_MODEL_CATALOG, 'some/unknown-model'), false);
});

test('BRIDGE_MODEL_CATALOG_JSON overrides entries but always keeps auto', () => {
  const override = JSON.stringify([
    { id: 'custom/vision-model', provider: 'custom', displayName: 'Custom Vision', nativeVision: true, contextWindow: 1000 },
  ]);
  const catalog = parseModelCatalog(override);
  assert.equal(catalog[0].id, 'auto');
  assert.ok(catalog.some((entry) => entry.id === 'custom/vision-model' && entry.nativeVision === true));
  assert.equal(hasNativeVision(catalog, 'custom/vision-model'), true);
});

test('malformed override JSON falls back to the default catalog', () => {
  assert.equal(parseModelCatalog('{not json').length, DEFAULT_MODEL_CATALOG.length);
  assert.equal(parseModelCatalog('["not-an-object"]')[0].id, 'auto');
});
