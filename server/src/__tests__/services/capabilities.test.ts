import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import { getRegistrySnapshot } from '../../providers/registry/index.js';
import { updateModelSettings, updateProviderSettings } from '../../settings/registry.js';
import { createConfigurationProvider } from '../../services/configuration-v2-provider.js';
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

  it('keeps an actively configured archived platform active (no archived stand-in duplicate)', () => {
    // `nvidia` lives in ARCHIVED_PROVIDER_PLATFORMS but is re-activated via the
    // durable provider configuration. The registry snapshot must not append a
    // second `archived` entry for it: a duplicated archived stand-in wins the
    // capabilityByPlatform lookup and fail-closes streaming for every model.
    createConfigurationProvider({
      platform: 'nvidia',
      displayName: 'NVIDIA NIM',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      lifecycle: 'active',
      enabled: true,
      capabilities: { streaming: true, tools: true, reasoning: true, multimodal: false },
      actor: 'test',
      source: 'capabilities-test',
    });

    const nvidia = getRegistrySnapshot().providers.filter(p => p.platform === 'nvidia');
    expect(nvidia).toHaveLength(1);
    expect(nvidia[0].lifecycle).toBe('active');
    expect(nvidia[0].capabilities.streaming).toBe(true);
  });
});
