import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  ConfigurationRevisionConflictError,
  createConfigurationModel,
  exportConfigurationDocument,
  getConfigurationSnapshot,
  getRouteModelIds,
  materializeConfigurationModels,
  rollbackConfiguration,
  updateConfigurationProvider,
  updateConfigurationModel,
  updateConfigurationRoute,
} from '../../services/configuration-v2.js';
import { getProvider } from '../../providers/index.js';

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

  it('rejects stale writes instead of silently overwriting the current configuration', () => {
    const snapshot = getConfigurationSnapshot();
    const model = snapshot.models[0];
    expect(() => updateConfigurationModel(model.modelDbId, { expectedRevision: 99, enabled: false })).toThrow(ConfigurationRevisionConflictError);
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

  it('materializes provider model selections once and publishes a pinned route', () => {
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
    expect(repeated.models.some(model => model.platform === 'example-provider' && model.modelId === selection.modelId)).toBe(true);
    const entry = repeated.bridge.entries.find(candidate => candidate.id === 'example-provider/example/selected');
    expect(entry).toBeTruthy();
    expect(getRouteModelIds(entry!.routeId)).toHaveLength(1);
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
