import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  DESKTOP_PICKER_ALIAS_VALUES,
  createConfigurationModel,
  ensureConfigurationV2,
  exportConfigurationDocument,
  getConfigurationSnapshot,
  getRouteModelIds,
  materializeConfigurationModels,
  rollbackConfiguration,
  updateBridgeVisionModels,
  updateConfigurationProvider,
  updateConfigurationModel,
  updateConfigurationRoute,
} from '../../services/configuration-v2.js';
import { getProvider } from '../../providers/index.js';
import { getProviderSettingsSnapshot } from '../../settings/registry.js';

describe('configuration-v2', () => {
  beforeEach(() => {
    initDb(':memory:', { catalogMode: 'operational' });
  });

  it('projects one coherent Auto route and never reintroduces DeepSeek Pro', () => {
    const snapshot = getConfigurationSnapshot();
    const auto = snapshot.routes.find(route => route.routeId === 'route:auto');
    expect(auto?.members).toHaveLength(4);
    expect(snapshot.bridge.entries.some(entry => entry.id.includes('deepseek-v4-pro'))).toBe(false);
    expect(snapshot.models.some(model => model.modelId.includes('deepseek-v4-pro') || model.displayName.toLowerCase().includes('deepseek v4 pro'))).toBe(false);
    expect(snapshot.bridge.entries.find(entry => entry.id === 'auto')?.wireModel).toBe('auto');
    expect(snapshot.bridge.entries.find(entry => entry.id === 'deepseek-v4-flash')).toBeUndefined();
    expect(snapshot.bridge.entries.filter(entry => entry.id !== 'auto').every(entry => entry.routeId !== 'route:auto')).toBe(true);
    const pickerIds = snapshot.bridge.entries.filter(entry => entry.id !== 'auto').map(entry => entry.pickerId);
    expect(pickerIds).toHaveLength(6);
    expect(new Set(pickerIds).size).toBe(6);
    expect(pickerIds.every(pickerId => pickerId !== null && DESKTOP_PICKER_ALIAS_VALUES.includes(pickerId))).toBe(true);
    expect(pickerIds.some(pickerId => pickerId?.startsWith('gpt-bridge-'))).toBe(false);
    expect(pickerIds).toContain('gpt-5.4-mini');
    expect(pickerIds).not.toContain('gpt-5.6-sol-wm');
    expect(pickerIds).toContain('gpt-5.6-auto');
    expect(pickerIds).not.toContain('gpt-5.6-sol');
  });

  it('projects verified model reasoning and vision independently from provider capabilities', () => {
    const snapshot = getConfigurationSnapshot();
    for (const model of [
      ['andoryyu', 'deepseek-v4-flash'],
      ['opencode-zen', 'deepseek-v4-flash-free'],
      ['opencode-go', 'deepseek-v4-flash'],
      ['commandcode', 'deepseek/deepseek-v4-flash'],
    ]) {
      const entry = snapshot.models.find(candidate => candidate.platform === model[0] && candidate.modelId === model[1]);
      expect(entry?.supportsReasoning).toBe(true);
      expect(snapshot.bridge.entries.find(candidate => candidate.provider === model[0] && candidate.id !== 'auto')?.supportsReasoning).toBe(true);
    }
    const flash = snapshot.models.find(model => model.platform === 'commandcode' && model.modelId.endsWith('deepseek-v4-flash'))!;
    const muse = snapshot.models.find(model => model.platform === 'commandcode' && model.modelId.includes('muse-spark'))!;
    expect(flash.supportsReasoning).toBe(true);
    expect(flash.nativeVision).toBe(false);
    expect(muse.supportsReasoning).toBe(true);
    expect(muse.nativeVision).toBe(true);
    expect(snapshot.bridge.entries.find(entry => entry.id === flash.modelId)?.supportsReasoning).toBe(true);
    expect(snapshot.bridge.entries.find(entry => entry.id === muse.modelId)?.supportsReasoning).toBe(true);
    expect(snapshot.bridge.entries.find(entry => entry.id === muse.modelId)?.nativeVision).toBe(true);

    const commandCode = getProviderSettingsSnapshot().providers.find(provider => provider.platform === 'commandcode')!;
    expect(commandCode.effective.capabilities.reasoning).toBe(true);
    expect(commandCode.models.find(model => model.modelId === flash.modelId)?.effective.capabilities.reasoning).toBe(true);
    expect(commandCode.models.find(model => model.modelId === muse.modelId)?.effective.capabilities.reasoning).toBe(true);
    expect(commandCode.models.find(model => model.modelId === muse.modelId)?.effective.capabilities.multimodal).toBe(true);
  });

  it('updates model capabilities through one revisioned service', () => {
    const before = getConfigurationSnapshot();
    const model = before.models.find(candidate => candidate.platform === 'commandcode' && candidate.modelId.includes('muse'))!;
    const after = updateConfigurationModel(model.modelDbId, {
      expectedRevision: before.revision,
      nativeVision: true,
      supportsReasoning: true,
      actor: 'test',
      source: 'test',
    });
    const updated = after.models.find(candidate => candidate.modelDbId === model.modelDbId)!;
    expect(updated.nativeVision).toBe(true);
    expect(after.revision).toBe(before.revision + 1);
  });

  it('does not advertise model reasoning when the provider contract disables it', () => {
    const snapshot = getConfigurationSnapshot();
    const tokenHarbor = snapshot.models.find(model => model.platform === 'tokenharbor')!;
    expect(tokenHarbor.supportsReasoning).toBe(false);
    expect(() => updateConfigurationModel(tokenHarbor.modelDbId, {
      expectedRevision: snapshot.revision,
      supportsReasoning: true,
      actor: 'test',
      source: 'test',
    })).toThrow(/no declara control de razonamiento/);
  });

  it('persists a separate bridge vision chain with priority, enablement and revision', () => {
    const before = getConfigurationSnapshot();
    const vision = before.bridge.visionModels;
    expect(vision).toHaveLength(2);
    expect(vision.map(route => route.priority)).toEqual([1, 2]);
    expect(vision.every(route => route.enabled)).toBe(true);
    expect(vision[0].authPlatform).toBe('opencode-zen');
    expect(vision[1].authPlatform).toBe('opencode-go');

    const reversed = [...vision].reverse().map((route, index) => ({ routeId: route.routeId, priority: index + 1, enabled: route.enabled }));
    const after = updateBridgeVisionModels({ expectedRevision: before.revision, routes: reversed, actor: 'test', source: 'test' });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.bridge.visionModels.map(route => route.routeId)).toEqual(reversed.map(route => route.routeId));

    const disabled = updateBridgeVisionModels({
      expectedRevision: after.revision,
      routes: after.bridge.visionModels.map((route, index) => ({ routeId: route.routeId, priority: index + 1, enabled: index === 1 })),
      actor: 'test',
      source: 'test',
    });
    expect(disabled.bridge.visionModels.filter(route => route.enabled)).toHaveLength(1);
    // El estado deshabilitado conserva la prioridad posicional; el launcher
    // filtra enabled y ordena por priority al resolver el primary/fallbacks.
    expect(disabled.bridge.visionModels.find(route => route.enabled)?.priority).toBe(2);
  });

  it('rejects stale, incomplete or duplicate bridge vision chain writes', () => {
    const before = getConfigurationSnapshot();
    const vision = before.bridge.visionModels;
    const payload = vision.map((route, index) => ({ routeId: route.routeId, priority: index + 1, enabled: true }));
    expect(() => updateBridgeVisionModels({ expectedRevision: 99, routes: payload })).toThrow(ConfigurationRevisionConflictError);
    expect(() => updateBridgeVisionModels({ routes: payload.slice(0, -1) })).toThrow(ConfigurationValidationError);
    expect(() => updateBridgeVisionModels({ routes: [...payload, { ...payload[0], priority: payload.length + 1 }] })).toThrow(ConfigurationValidationError);
    expect(() => updateBridgeVisionModels({ routes: payload.map(route => ({ ...route, priority: 7 })) })).toThrow(ConfigurationValidationError);
  });

  it('rejects stale writes instead of silently overwriting the current configuration', () => {
    const snapshot = getConfigurationSnapshot();
    const model = snapshot.models[0];
    expect(() => updateConfigurationModel(model.modelDbId, { expectedRevision: 99, enabled: false })).toThrow(ConfigurationRevisionConflictError);
  });

  it('migrates legacy hashed picker ids once and keeps the repaired catalog stable', () => {
    const db = getDb();
    const rows = db.prepare("SELECT model_db_id FROM client_catalog_entries WHERE integration = 'codex-bridge' AND model_db_id IS NOT NULL ORDER BY sort_order, model_db_id").all() as Array<{ model_db_id: number }>;
    const update = db.prepare("UPDATE client_catalog_entries SET picker_id = ? WHERE integration = 'codex-bridge' AND model_db_id = ?");
    rows.forEach((row, index) => update.run(`gpt-bridge-legacy-${index}`, row.model_db_id));
    const beforeRevision = getConfigurationSnapshot().revision;

    ensureConfigurationV2(db);
    const repaired = getConfigurationSnapshot();
    const repairedIds = repaired.bridge.entries.filter(entry => entry.id !== 'auto').map(entry => entry.pickerId);
    expect(repairedIds).toEqual(DESKTOP_PICKER_ALIAS_VALUES);
    expect(repaired.revision).toBe(beforeRevision + 1);

    ensureConfigurationV2(db);
    expect(getConfigurationSnapshot().revision).toBe(repaired.revision);
  });

  it('exposes picker aliases in the model schema and rejects alias collisions', () => {
    const snapshot = getConfigurationSnapshot();
    const pickerField = snapshot.schema.fields.find(field => field.scope === 'model' && field.key === 'pickerId');
    expect(pickerField?.options?.map(option => option.value)).toEqual(DESKTOP_PICKER_ALIAS_VALUES);
    const [first, second] = snapshot.models;
    expect(() => updateConfigurationModel(second.modelDbId, {
      expectedRevision: snapshot.revision,
      pickerId: first.pickerId,
      actor: 'test',
      source: 'test',
    })).toThrow(/already assigned/);
  });

  it('replays an idempotent mutation without creating a second revision', () => {
    const before = getConfigurationSnapshot();
    const model = before.models[0];
    const input = {
      expectedRevision: before.revision,
      displayName: `${model.displayName} stable`,
      idempotencyKey: 'configuration-test-model-update',
      actor: 'test',
      source: 'test',
    };
    const first = updateConfigurationModel(model.modelDbId, input);
    const replay = updateConfigurationModel(model.modelDbId, input);
    expect(replay.revision).toBe(first.revision);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM configuration_revisions WHERE revision = ?").get(first.revision)).toMatchObject({ count: 1 });
  });

  it('adds a model through the same catalog and route source used by the bridge', () => {
    const before = getConfigurationSnapshot();
    const after = createConfigurationModel({
      platform: 'example-provider',
      modelId: 'example/model',
      displayName: 'Example model',
      contextWindow: 150000,
      supportsReasoning: true,
      addToAuto: true,
      actor: 'test',
      source: 'test',
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.models.some(model => model.platform === 'example-provider' && model.modelId === 'example/model')).toBe(true);
    expect(getDb().prepare("SELECT 1 FROM client_catalog_entries WHERE external_slug = 'example-provider/example/model'").get()).toBeTruthy();
    expect(after.routes.find(route => route.routeId === 'route:auto')?.members.length).toBe(5);
  });

  it('invalidates the routing snapshot after provider changes and never bypasses disabled state', () => {
    const before = getConfigurationSnapshot();
    const disabled = updateConfigurationProvider('commandcode', {
      expectedRevision: before.revision,
      enabled: false,
      actor: 'test',
      source: 'test',
    });
    const commandCodeIds = (getDb().prepare("SELECT id FROM models WHERE platform = 'commandcode'").all() as Array<{ id: number }>).map(row => row.id);
    expect(getRouteModelIds('route:auto').some(id => commandCodeIds.includes(id))).toBe(false);
    expect(getProvider('commandcode')).toBeUndefined();

    updateConfigurationProvider('commandcode', {
      expectedRevision: disabled.revision,
      enabled: true,
      actor: 'test',
      source: 'test',
    });
    expect(getRouteModelIds('route:auto')).toHaveLength(4);
  });

  it('materializes provider model selections once and keeps a pinned route when picker slots are exhausted', () => {
    const before = getConfigurationSnapshot();
    const selection = {
      modelId: 'example/selected',
      displayName: 'Example selected',
      contextWindow: 150000,
      nativeVision: false,
      supportsReasoning: true,
    };
    const after = materializeConfigurationModels('example-provider', [selection], { actor: 'test', source: 'test' });
    const repeated = materializeConfigurationModels('example-provider', [selection], { actor: 'test', source: 'test' });
    expect(after.revision).toBe(before.revision + 1);
    expect(repeated.revision).toBe(after.revision);
    const model = repeated.models.find(candidate => candidate.platform === 'example-provider' && candidate.modelId === selection.modelId)!;
    expect(model).toBeTruthy();
    expect(model.bridgeVisible).toBe(false);
    expect(model.pickerId).toBeNull();
    const pinnedRoute = model.routeIds.find(routeId => routeId !== 'route:auto');
    expect(pinnedRoute).toBeTruthy();
    expect(getRouteModelIds(pinnedRoute!)).toEqual([model.modelDbId]);
    expect(repeated.bridge.entries.find(candidate => candidate.id === 'example-provider/example/selected')).toBeUndefined();
  });

  it('exports and rolls back a complete revision without resurrecting post-snapshot models', () => {
    const initial = exportConfigurationDocument();
    const model = getConfigurationSnapshot().models[0];
    const changed = updateConfigurationModel(model.modelDbId, { enabled: false, actor: 'test', source: 'test' });
    const added = createConfigurationModel({
      platform: 'temporary-provider',
      modelId: 'temporary/model',
      displayName: 'Temporary model',
      addToAuto: false,
      actor: 'test',
      source: 'test',
    });
    const restored = rollbackConfiguration(initial.revision, added.revision);
    expect(restored.revision).toBe(added.revision + 1);
    expect(restored.models.find(candidate => candidate.modelDbId === model.modelDbId)?.enabled).toBe(true);
    expect(restored.models.find(candidate => candidate.platform === 'temporary-provider')?.enabled).toBe(false);
    expect(restored.bridge.entries.some(entry => entry.id === 'temporary-provider/temporary/model')).toBe(false);
    expect(changed.revision).toBe(initial.revision + 1);
  });
});
