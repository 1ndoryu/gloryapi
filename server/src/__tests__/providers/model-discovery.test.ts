import { describe, expect, it, vi, afterEach } from 'vitest';
import { clearDiscoveryCache, discoverProviderModels, discoverProviderModelsCached } from '../../providers/catalog/model-discovery.js';

describe('provider model discovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); clearDiscoveryCache(); });

  it('normalizes OpenAI data and never writes operational models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'fixture-a', name: 'Fixture A', context_window: 32768, capabilities: { tools: true } },
        { id: 'fixture-b', contextWindow: 8192, capabilities: { reasoning: true, multimodal: true } },
        { name: 'invalid-without-id' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const models = await discoverProviderModels('https://provider.example/v1', 'secret');
    expect(fetchMock).toHaveBeenCalledWith(new URL('https://provider.example/v1/models'), expect.objectContaining({
      method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }));
    expect(models).toEqual([
      expect.objectContaining({
        modelId: 'fixture-a',
        contextWindow: 32768,
        capabilities: expect.objectContaining({ streaming: false, tools: true }),
        capabilityEvidence: expect.objectContaining({ streaming: 'unknown', tools: 'observed' }),
      }),
      expect.objectContaining({
        modelId: 'fixture-b',
        contextWindow: 8192,
        capabilities: expect.objectContaining({ streaming: false, multimodal: true }),
      }),
    ]);
  });

  it('treats missing capability metadata as unknown and disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'no-capability-evidence' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const [model] = await discoverProviderModels('https://provider.example/v1', 'secret');
    expect(model.capabilities).toEqual({
      streaming: false,
      tools: false,
      reasoning: false,
      multimodal: false,
      maxContextWindow: null,
    });
    expect(model.capabilityEvidence).toEqual({
      streaming: 'unknown',
      tools: 'unknown',
      reasoning: 'unknown',
      multimodal: 'unknown',
    });
  });

  it('rejects unsafe endpoints before fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(discoverProviderModels('http://127.0.0.1:8080/v1', 'secret')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds oversized responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', {
      status: 200, headers: { 'content-length': String(3 * 1024 * 1024) },
    }));
    await expect(discoverProviderModels('https://provider.example/v1', 'secret')).rejects.toThrow(/exceeds limit/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('caches successful probes and marks an expired result stale after a transient failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'cached-model' }] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const first = await discoverProviderModelsCached('https://provider.example/v1', 'secret');
    vi.advanceTimersByTime(31_000);
    const second = await discoverProviderModelsCached('https://provider.example/v1', 'secret');
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(true);
    expect(second.models[0].modelId).toBe('cached-model');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

