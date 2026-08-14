import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  ConfigurationRevisionConflictError,
  createConfigurationModel,
  getConfigurationSnapshot,
  updateConfigurationModel,
  updateConfigurationRoute,
} from '../../services/configuration-v2.js';

describe('configuration-v2', () => {
  beforeEach(() => {
    initDb(':memory:', { catalogMode: 'operational' });
  });

  it('projects one coherent Auto route and never reintroduces DeepSeek Pro', () => {
    const snapshot = getConfigurationSnapshot();
    const auto = snapshot.routes.find(route => route.routeId === 'route:auto');
    expect(auto?.members).toHaveLength(4);
    expect(snapshot.bridge.entries.some(entry => entry.id.includes('deepseek-v4-pro'))).toBe(false);
    expect(snapshot.bridge.entries.find(entry => entry.id === 'auto')?.wireModel).toBe('auto');
    expect(snapshot.bridge.entries.find(entry => entry.id === 'deepseek-v4-flash')?.routeId).toBe('route:auto');
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
});
