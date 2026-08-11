import { isIP } from 'node:net';
import { getDb } from '../db/index.js';
import { SETTINGS_SCHEMA_VERSION } from '@gloryapi/shared/types.js';
import type {
  CapabilityProfile,
  EffectiveModelSettings,
  EffectiveProviderSettings,
  ModelSettingsOverrides,
  ProviderSettingsOverrides,
  ProviderSettingsSnapshot,
  SettingDefinition,
  SettingPrimitive,
  SettingsSnapshot,
  SettingValue,
} from '@gloryapi/shared/types.js';
import { getRegistrySnapshot, KNOWN_PROVIDER_PLATFORMS } from '../providers/registry.js';

export { SETTINGS_SCHEMA_VERSION };
import { commitRawValues, getRevision } from './persistence.js';

import { getDefinition, SETTING_DEFINITIONS } from './definitions.js';
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}
type NumericSettingDefinition = SettingDefinition & {
  type: 'integer' | 'number' | 'duration-ms';
  defaultValue: number;
  min: number;
  max: number;
};

function validateValue(definition: SettingDefinition, value: unknown): SettingPrimitive {
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') throw new SettingsValidationError(`${definition.key} must be a boolean`);
    return value;
  }

  if (definition.type === 'string') {
    if (typeof value !== 'string' || value.length > 4_000) {
      throw new SettingsValidationError(`${definition.key} must be a string with at most 4000 characters`);
    }
    return value;
  }

  const numericDefinition = definition as NumericSettingDefinition;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettingsValidationError(`${definition.key} must be a finite number`);
  }
  if (definition.type === 'integer' && !Number.isInteger(value)) {
    throw new SettingsValidationError(`${definition.key} must be an integer`);
  }
  if (value < numericDefinition.min || value > numericDefinition.max) {
    throw new SettingsValidationError(
      `${definition.key} must be between ${numericDefinition.min} and ${numericDefinition.max}`,
    );
  }
  return value;
}

function readValue(definition: SettingDefinition): SettingPrimitive {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(definition.key) as { value: string } | undefined;
  if (!row) return definition.defaultValue;

  try {
    return validateValue(definition, JSON.parse(row.value));
  } catch {
    // Invalid persisted values never escape the typed contract; the default is safe and deterministic.
    return definition.defaultValue;
  }
}

export function getSetting(key: string): SettingPrimitive {
  const definition = getDefinition(key);
  if (!definition) throw new SettingsValidationError(`Unknown setting: ${key}`);
  return readValue(definition);
}

export function getSettingNumber(key: string): number {
  const value = getSetting(key);
  if (typeof value !== 'number') throw new SettingsValidationError(`${key} is not numeric`);
  return value;
}

export function getSettingsSnapshot(): SettingsSnapshot {
  const settings: SettingValue[] = SETTING_DEFINITIONS.map(definition => ({
    ...definition,
    value: readValue(definition),
  }));
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: getRevision(),
    settings,
  };
}

export function updateSettings(
  values: Record<string, unknown>,
  expectedRevision?: number,
): SettingsSnapshot {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new SettingsValidationError('At least one setting is required');

  const validated = entries.map(([key, value]) => {
    const definition = getDefinition(key);
    if (!definition) throw new SettingsValidationError(`Unknown setting: ${key}`);
    return [key, validateValue(definition, value)] as const;
  });

  commitRawValues(validated.map(([key, value]) => [key, JSON.stringify(value)]), expectedRevision);  return getSettingsSnapshot();
}


const PROVIDER_OVERRIDE_PREFIX = 'provider_override:';
const MODEL_OVERRIDE_PREFIX = 'model_override:';
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
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
  if (!(KNOWN_PROVIDER_PLATFORMS as readonly string[]).includes(platform)) {
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

export function getProviderSettingsSnapshot(): ProviderSettingsSnapshot {
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
          capabilities: mergeCapabilities(providerEffective.capabilities, overrides.capabilities),
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
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, revision: getRevision(), providers };
}

export function getEffectiveProviderModelSettings(platform: string, modelId?: string): {
  baseUrl: string;
  timeoutMs: number;
  authScheme: 'bearer' | 'account-and-token';
  modelAlias: string | null;
} | null {
  const provider = getProviderSettingsSnapshot().providers.find(entry => entry.platform === platform);
  if (!provider || provider.lifecycle !== 'active') return null;
  const model = modelId ? provider.models.find(entry => entry.modelId === modelId) : undefined;
  return {
    baseUrl: provider.effective.baseUrl,
    timeoutMs: model?.effective.timeoutMs ?? provider.effective.timeoutMs,
    authScheme: provider.effective.authScheme,
    modelAlias: model?.effective.alias ?? null,
  };
}

export function updateProviderSettings(
  platform: string,
  overrides: unknown,
  expectedRevision?: number,
): ProviderSettingsSnapshot {
  assertKnownPlatform(platform);
  const validated = validateProviderSettingsOverrides(overrides);
  if (validated.authScheme === 'account-and-token' && KNOWN_PROVIDER_PLATFORMS.includes(platform as typeof KNOWN_PROVIDER_PLATFORMS[number])) {
    throw new SettingsValidationError('The registered OpenAI-compatible adapters require bearer authentication');
  }
  commitRawValues([[`${PROVIDER_OVERRIDE_PREFIX}${platform}`, JSON.stringify(validated)]], expectedRevision);
  return getProviderSettingsSnapshot();
}

export function updateModelSettings(
  platform: string,
  modelId: string,
  overrides: unknown,
  expectedRevision?: number,
): ProviderSettingsSnapshot {
  assertKnownPlatform(platform);
  if (!modelId || modelId.length > 200 || modelId.includes('\u0000')) throw new SettingsValidationError('Invalid model id');
  const validated = validateModelSettingsOverrides(overrides);
  commitRawValues([[`${MODEL_OVERRIDE_PREFIX}${platform}:${modelId}`, JSON.stringify(validated)]], expectedRevision);
  return getProviderSettingsSnapshot();
}
