import crypto from 'node:crypto';
import { assertSafeUpstreamUrl } from '../../services/endpoint-security.js';

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    reasoning: boolean;
    multimodal: boolean;
    maxContextWindow: number | null;
  };
  capabilityEvidence: {
    streaming: 'observed' | 'unknown';
    tools: 'observed' | 'unknown';
    reasoning: 'observed' | 'unknown';
    multimodal: 'observed' | 'unknown';
  };
}

const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_CACHE_TTL_MS = 30_000;
const DISCOVERY_STALE_MAX_MS = 10 * 60_000;

type DiscoveryCacheEntry = { models: DiscoveredModel[]; fetchedAt: number; expiresAt: number };
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

export type CachedDiscoveryResult = {
  models: DiscoveredModel[];
  stale: boolean;
  fetchedAt: string;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readBoolean(metadata: Record<string, unknown>, keys: string[]): { value: boolean; evidence: 'observed' | 'unknown' } {
  for (const key of keys) {
    if (typeof metadata[key] === 'boolean') return { value: metadata[key] as boolean, evidence: 'observed' };
  }
  // Absence of metadata is not evidence of support. Keep the capability disabled
  // until a model-specific probe or approved fixture promotes it.
  return { value: false, evidence: 'unknown' };
}

function normalizeModel(value: unknown): DiscoveredModel | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const modelId = typeof row.id === 'string' ? row.id.trim() : '';
  if (!modelId || modelId.length > 200) return null;
  const contextWindow = numberOrNull(row.context_window ?? row.contextWindow ?? row.max_context_window);
  const metadata = row.capabilities && typeof row.capabilities === 'object'
    ? row.capabilities as Record<string, unknown>
    : {};
  const streaming = readBoolean(metadata, ['streaming']);
  const tools = readBoolean(metadata, ['tools', 'function_calling']);
  const reasoning = readBoolean(metadata, ['reasoning']);
  const multimodal = readBoolean(metadata, ['multimodal', 'vision']);
  const capabilities = {
    streaming: streaming.value,
    tools: tools.value,
    reasoning: reasoning.value,
    multimodal: multimodal.value,
    maxContextWindow: contextWindow,
  };
  return {
    modelId,
    displayName: (typeof row.name === 'string' && row.name.trim()) || modelId,
    contextWindow,
    capabilities,
    capabilityEvidence: {
      streaming: streaming.evidence,
      tools: tools.evidence,
      reasoning: reasoning.evidence,
      multimodal: multimodal.evidence,
    },
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_DISCOVERY_BYTES) throw new Error('Model discovery response exceeds limit');
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_DISCOVERY_BYTES) {
      await reader.cancel();
      throw new Error('Model discovery response exceeds limit');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

function discoveryCacheKey(endpoint: string, apiKey: string): string {
  return crypto.createHash('sha256').update(`${endpoint}\u0000${apiKey}`).digest('hex');
}

async function discoverProviderModelsUncached(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  const base = await assertSafeUpstreamUrl(endpoint);
  const path = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${path || ''}/models`, base.origin);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
    const payload = await readBoundedJson(response) as { data?: unknown; models?: unknown };
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return rows.map(normalizeModel).filter((model): model is DiscoveredModel => Boolean(model)).slice(0, 256);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function discoverProviderModels(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  return discoverProviderModelsUncached(endpoint, apiKey, signal);
}

/**
 * Discovery is diagnostic only. A short positive TTL prevents repeated probes;
 * an expired result may be returned as explicitly stale during a transient
 * provider failure, but this result is never written to the active catalog.
 */
export async function discoverProviderModelsCached(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<CachedDiscoveryResult> {
  const key = discoveryCacheKey(endpoint, apiKey);
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { models: cached.models, stale: false, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }
  try {
    const models = await discoverProviderModelsUncached(endpoint, apiKey, signal);
    const entry = { models, fetchedAt: Date.now(), expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS };
    discoveryCache.set(key, entry);
    return { models, stale: false, fetchedAt: new Date(entry.fetchedAt).toISOString() };
  } catch (error) {
    if (cached && now - cached.fetchedAt <= DISCOVERY_STALE_MAX_MS) {
      return { models: cached.models, stale: true, fetchedAt: new Date(cached.fetchedAt).toISOString() };
    }
    throw error;
  }
}

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}
