'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL_CATALOG_SCHEMA,
  DEFAULT_MODEL_CATALOG,
  BRIDGE_CONTEXT_WINDOW,
  parseModelCatalog,
  parseModelCatalogDetailed,
  resolveModelSelection,
  resolvePresentationModel,
  hasNativeVision,
} = require('../bridge/model-catalog');

const PERSISTED_CATALOG = parseModelCatalog(JSON.stringify([
  { id: 'deepseek/deepseek-v4-flash', pickerId: 'gpt-5.6-auto', provider: 'commandcode', displayName: 'DeepSeek V4 Flash', supportsReasoning: true },
  { id: 'meta/muse-spark-1.2-contributor', pickerId: 'gpt-5.6-terra', provider: 'commandcode', displayName: 'Muse Spark', nativeVision: true, supportsReasoning: true },
]));

test('the compiled fallback is versioned and Auto-only; persisted rows are separate', () => {
  assert.equal(MODEL_CATALOG_SCHEMA, 'glory-bridge-model-catalog-v2');
  assert.deepEqual(DEFAULT_MODEL_CATALOG.map((entry) => entry.id), ['auto']);
  assert.equal(PERSISTED_CATALOG.find((entry) => entry.id === 'meta/muse-spark-1.2-contributor').nativeVision, true);
  assert.equal(PERSISTED_CATALOG.some((entry) => entry.id === 'deepseek-v4-pro'), false);
  assert.ok(DEFAULT_MODEL_CATALOG.every((entry) => entry.acceptsImageInput === true));
  assert.ok(PERSISTED_CATALOG.every((entry) => entry.acceptsImageInput === true));
  assert.ok(DEFAULT_MODEL_CATALOG.every((entry) => entry.contextWindow === BRIDGE_CONTEXT_WINDOW));
});

test('resolveModelSelection maps missing and auto to the canonical Auto route', () => {
  const defaultModel = 'deepseek-v4-flash';
  for (const requested of [undefined, 'auto', 'gpt-5.6-sol', 'codex-auto-review']) {
    assert.deepEqual(resolveModelSelection(DEFAULT_MODEL_CATALOG, requested, defaultModel), {
      id: 'auto', provider: 'auto', nativeVision: false, supportsReasoning: true, explicit: false,
    });
  }
});

test('resolveModelSelection pins persisted provider models to their exact id and capability flags', () => {
  assert.deepEqual(resolveModelSelection(PERSISTED_CATALOG, 'deepseek/deepseek-v4-flash', 'auto'), {
    id: 'deepseek/deepseek-v4-flash', provider: 'commandcode', nativeVision: false, supportsReasoning: true, explicit: true,
  });
  assert.deepEqual(resolveModelSelection(PERSISTED_CATALOG, 'meta/muse-spark-1.2-contributor', 'auto'), {
    id: 'meta/muse-spark-1.2-contributor', provider: 'commandcode', nativeVision: true, supportsReasoning: true, explicit: true,
  });
});

test('resolveModelSelection maps persisted Desktop-safe picker ids back to provider ids', () => {
  assert.deepEqual(resolveModelSelection(PERSISTED_CATALOG, 'gpt-5.6-sol', 'auto'), {
    id: 'auto', provider: 'auto', nativeVision: false, supportsReasoning: true, explicit: false,
  });
  assert.deepEqual(resolveModelSelection(PERSISTED_CATALOG, 'gpt-5.6-auto', 'auto'), {
    id: 'deepseek/deepseek-v4-flash', provider: 'commandcode', nativeVision: false, supportsReasoning: true, explicit: true,
  });
  assert.deepEqual(resolveModelSelection(PERSISTED_CATALOG, 'gpt-5.6-terra', 'auto'), {
    id: 'meta/muse-spark-1.2-contributor', provider: 'commandcode', nativeVision: true, supportsReasoning: true, explicit: true,
  });
});

test('resolvePresentationModel always returns a Desktop catalog id', () => {
  assert.equal(resolvePresentationModel(DEFAULT_MODEL_CATALOG, undefined), 'gpt-5.6-sol');
  assert.equal(resolvePresentationModel(PERSISTED_CATALOG, undefined), 'gpt-5.6-sol');
  assert.equal(resolvePresentationModel(PERSISTED_CATALOG, 'gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(resolvePresentationModel(PERSISTED_CATALOG, 'meta/muse-spark-1.2-contributor'), 'gpt-5.6-terra');
  assert.equal(resolvePresentationModel(PERSISTED_CATALOG, 'legacy/deepseek-v4-flash'), 'gpt-5.6-sol');
});

test('legacy Auto picker aliases normalize to the visible bridge-owned id', () => {
  const catalog = parseModelCatalog(JSON.stringify([
    { id: 'auto', pickerId: 'codex-auto-review', provider: 'auto', displayName: 'Auto' },
  ]));
  assert.equal(catalog[0].pickerId, 'gpt-5.6-sol');
});

test('an unknown model passes through fail-closed', () => {
  const selection = resolveModelSelection(DEFAULT_MODEL_CATALOG, 'some/unknown-model', 'auto');
  assert.deepEqual(selection, { id: 'some/unknown-model', provider: 'unknown', nativeVision: false, supportsReasoning: false, explicit: true });
  assert.equal(hasNativeVision(DEFAULT_MODEL_CATALOG, 'some/unknown-model'), false);
});

test('BRIDGE_MODEL_CATALOG_JSON overrides entries but always keeps auto', () => {
  const catalog = parseModelCatalog(JSON.stringify([{ id: 'custom/vision-model', provider: 'custom', displayName: 'Custom Vision', nativeVision: true, contextWindow: 1000 }]));
  assert.equal(catalog[0].id, 'auto');
  assert.ok(catalog.some((entry) => entry.id === 'custom/vision-model' && entry.nativeVision === true));
  assert.equal(hasNativeVision(catalog, 'custom/vision-model'), true);
  assert.equal(catalog.find((entry) => entry.id === 'custom/vision-model').acceptsImageInput, true);
});

test('the synchronized revision envelope is accepted and exposes its publication state', () => {
  const raw = { schemaVersion: 'glory-bridge-model-catalog-v2', revision: 7, entries: [{ id: 'command/model', provider: 'commandcode', displayName: 'Command model' }] };
  const catalog = parseModelCatalog(JSON.stringify(raw));
  const detailed = parseModelCatalogDetailed(JSON.stringify({ ...raw, state: 'published', hash: 'abc' }));
  assert.equal(catalog[0].id, 'auto');
  assert.ok(catalog.some(entry => entry.id === 'command/model'));
  assert.equal(detailed.state, 'published');
  assert.equal(detailed.revision, 7);
});

test('malformed override JSON falls back to the Auto-only catalog', () => {
  assert.equal(parseModelCatalog('{not json').length, DEFAULT_MODEL_CATALOG.length);
  assert.equal(parseModelCatalog('["not-an-object"]')[0].id, 'auto');
});
