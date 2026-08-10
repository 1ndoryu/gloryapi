import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import { updateModelSettings, updateProviderSettings } from '../../settings/registry.js';
import { validateRouteCapabilities } from '../../services/capabilities.js';

describe('Routing capabilities', () => {
  const route = { platform: 'andoryyu' as const, modelId: 'deepseek-v4-flash' };

  beforeEach(() => {
    initDb(':memory:', { catalogMode: 'operational' });
  });

  it('accepts requests supported by the effective default capabilities', () => {
    expect(validateRouteCapabilities(route, {
      stream: true,
      tools: [{ type: 'function' }],
      reasoningEffort: 'high',
    })).toBeNull();
  });

  it('rejects capability overrides before consuming an upstream attempt', () => {
    updateProviderSettings('andoryyu', { capabilities: { tools: false } });
    const providerRejected = validateRouteCapabilities(route, { tools: [{ type: 'function' }] });
    expect(providerRejected).toMatchObject({ code: 'capability_not_supported' });

    updateModelSettings('andoryyu', 'deepseek-v4-flash', { capabilities: { reasoning: false } });
    const modelRejected = validateRouteCapabilities(route, { reasoningEffort: 'high' });
    expect(modelRejected?.message).toContain('does not support reasoning');
  });
});
