import { isIP } from 'node:net';
import { getDb } from '../db/index.js';
import type {
  CapabilityProfile,
  EffectiveModelSettings,
  EffectiveProviderSettings,
  ModelSettingsOverrides,
  ProviderLifecycle,
  ProviderSettingsOverrides,
} from '@gloryapi/shared/types.js';
import { getRegistrySnapshot, KNOWN_PROVIDER_PLATFORMS } from '../providers/registry.js';
import { getConfiguredProviderFromDb } from '../services/provider-configuration.js';

/* [por que] Vive aqui (no en registry.ts) para evitar el ciclo de imports
 * registry -> overrides -> registry; registry.ts re-exporta esta clase. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export const PROVIDER_OVERRIDE_PREFIX = 'provider_override:';
export const MODEL_OVERRIDE_PREFIX = 'model_override:';
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_WINDOW = 2_000_000;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateCapabilityOverrides(value: unknown, path: string): NonNullable<ProviderSettingsOverrides['capabilities']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsValidationError(`${path} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['streaming', 'tools', 'reasoning', 'multimodal', 'maxContextWindow']);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new SettingsValidationError(`${path}.${key} is not supported`);
  }
  const result: NonNullable<ProviderSettingsOverrides['capabilities']> = {};
  for (const key of ['streaming', 'tools', 'reasoning', 'multimodal'] as const) {
    if (hasOwn(candidate, key)) {
      if (typeof candidate[key] !== 'boolean') throw new SettingsValidationError(`${path}.${key} must be a boolean`);
      result[key] = candidate[key] as boolean;
    }
  }
  if (hasOwn(candidate, 'maxContextWindow')) {
    const context = candidate.maxContextWindow;
    if (context !== null && (typeof context !== 'number' || !Number.isInteger(context) || context < 1 || context > MAX_CONTEXT_WINDOW)) {
      throw new SettingsValidationError(`${path}.maxContextWindow must be null or an integer between 1 and ${MAX_CONTEXT_WINDOW}`);
    }
    result.maxContextWindow = context as number | null;
  }
  return result;
}

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new SettingsValidationError('baseUrl must be a URL with at most 2048 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SettingsValidationError('baseUrl must be a valid URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipHost = hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || !hostname || hostname === 'localhost' || hostname.endsWith('.local') || isIP(ipHost) !== 0) {
    throw new SettingsValidationError('baseUrl must use HTTPS and a public hostname');
  }
  return parsed.toString().replace(/\/$/, '');
}

function validateTimeout(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new SettingsValidationError(`${path} must be an integer between 1000 and 120000`);
  }
  return value;
}

function readOverride<T>(key: string): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return {} as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return {} as T;
  }
}

function assertKnownPlatform(platform: string): void {
  const configured = getConfiguredProviderFromDb(getDb(), platform);
  if (!(KNOWN_PROVIDER_PLATFORMS as readonly string[]).includes(platform) && !configured) {
    throw new SettingsValidationError(`Unknown provider: ${platform}`);
  }
}

export function validateProviderSettingsOverrides(value: unknown): ProviderSettingsOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsValidationError('Provider overrides must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['baseUrl', 'timeoutMs', 'authScheme', 'capabilities']);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new SettingsValidationError(`provider.${key} is not supported`);
  }
  const result: ProviderSettingsOverrides = {};
  if (hasOwn(candidate, 'baseUrl')) result.baseUrl = validateBaseUrl(candidate.baseUrl);
  if (hasOwn(candidate, 'timeoutMs')) result.timeoutMs = validateTimeout(candidate.timeoutMs, 'provider.timeoutMs');
  if (hasOwn(candidate, 'authScheme')) {
    if (candidate.authScheme !== 'bearer' && candidate.authScheme !== 'account-and-token') {
      throw new SettingsValidationError('provider.authScheme is invalid');
    }
    result.authScheme = candidate.authScheme;
  }
  if (hasOwn(candidate, 'capabilities')) result.capabilities = validateCapabilityOverrides(candidate.capabilities, 'provider.capabilities');
  return result;
}

export function validateModelSettingsOverrides(value: unknown): ModelSettingsOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsValidationError('Model overrides must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['alias', 'timeoutMs', 'capabilities']);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new SettingsValidationError(`model.${key} is not supported`);
  }
  const result: ModelSettingsOverrides = {};
  if (hasOwn(candidate, 'alias')) {
    if (typeof candidate.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(candidate.alias)) {
      throw new SettingsValidationError('model.alias must contain only letters, numbers, dots, colons, slashes, underscores, or hyphens');
    }
    result.alias = candidate.alias;
  }
  if (hasOwn(candidate, 'timeoutMs')) result.timeoutMs = validateTimeout(candidate.timeoutMs, 'model.timeoutMs');
  if (hasOwn(candidate, 'capabilities')) result.capabilities = validateCapabilityOverrides(candidate.capabilities, 'model.capabilities');
  return result;
}

function mergeCapabilities(base: CapabilityProfile, override: ProviderSettingsOverrides['capabilities']): CapabilityProfile {
  return { ...base, ...(override ?? {}) };
}

function mergeModelCapabilities(
  model: CapabilityProfile,
  provider: CapabilityProfile,
  override: ModelSettingsOverrides['capabilities'],
): CapabilityProfile {
  const requested = mergeCapabilities(model, override);
  return {
    ...requested,
    // A model-level false is fail-closed and cannot be raised by a provider or
    // settings override. Verified model metadata must be changed explicitly.
    streaming: model.streaming && provider.streaming && requested.streaming,
    tools: model.tools && provider.tools && requested.tools,
    reasoning: model.reasoning && provider.reasoning && requested.reasoning,
    multimodal: model.multimodal && provider.multimodal && requested.multimodal,
    maxContextWindow: model.maxContextWindow === null
      ? null
      : (typeof requested.maxContextWindow === 'number'
        ? Math.min(model.maxContextWindow, requested.maxContextWindow)
        : model.maxContextWindow),
  };
}

export interface ProviderSettingsSnapshotBuild {
  providers: Array<{
    platform: string;
    lifecycle: ProviderLifecycle;
    providerOverrides: ProviderSettingsOverrides;
    effective: EffectiveProviderSettings;
    models: Array<{
      modelId: string;
      displayName: string;
      overrides: ModelSettingsOverrides;
      effective: EffectiveModelSettings;
    }>;
  }>;
}

/* Construye el snapshot efectivo de proveedores/modelos aplicando los overrides
 * persistidos sobre el registro canonico. */
export function buildProviderSettingsSnapshot(): ProviderSettingsSnapshotBuild {
  const registry = getRegistrySnapshot();
  const providers = registry.providers.map(provider => {
    const providerOverrides = readOverride<ProviderSettingsOverrides>(`${PROVIDER_OVERRIDE_PREFIX}${provider.platform}`);
    const providerEffective: EffectiveProviderSettings = {
      baseUrl: providerOverrides.baseUrl ?? provider.endpoint,
      timeoutMs: providerOverrides.timeoutMs ?? provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      authScheme: providerOverrides.authScheme ?? provider.authScheme,
      capabilities: mergeCapabilities(provider.capabilities, providerOverrides.capabilities),
      sources: {
        baseUrl: providerOverrides.baseUrl ? 'provider' : 'default',
        timeoutMs: providerOverrides.timeoutMs ? 'provider' : 'default',
        authScheme: providerOverrides.authScheme ? 'provider' : 'default',
        capabilities: providerOverrides.capabilities ? 'provider' : 'default',
      },
    };
    const models = registry.models
      .filter(model => model.platform === provider.platform)
      .map(model => {
        const overrides = readOverride<ModelSettingsOverrides>(`${MODEL_OVERRIDE_PREFIX}${provider.platform}:${model.modelId}`);
        const effective: EffectiveModelSettings = {
          alias: overrides.alias ?? null,
          timeoutMs: overrides.timeoutMs ?? providerEffective.timeoutMs,
          capabilities: mergeModelCapabilities(model.capabilities, providerEffective.capabilities, overrides.capabilities),
          sources: {
            alias: overrides.alias ? 'model' : 'default',
            timeoutMs: overrides.timeoutMs ? 'model' : providerOverrides.timeoutMs ? 'provider' : 'default',
            capabilities: overrides.capabilities ? 'model' : providerOverrides.capabilities ? 'provider' : 'default',
          },
        };
        return { modelId: model.modelId, displayName: model.displayName, overrides, effective };
      });
    return { platform: provider.platform, lifecycle: provider.lifecycle, providerOverrides, effective: providerEffective, models };
  });
  return { providers };
}

export function assertKnownProviderPlatform(platform: string): void {
  assertKnownPlatform(platform);
}
