import { getDb } from '../db/index.js';
import { SETTINGS_SCHEMA_VERSION } from '@gloryapi/shared/types.js';
import type {
  ModelSettingsOverrides,
  ProviderSettingsOverrides,
  ProviderSettingsSnapshot,
  SettingDefinition,
  SettingPrimitive,
  SettingsSnapshot,
  SettingValue,
} from '@gloryapi/shared/types.js';
import { KNOWN_PROVIDER_PLATFORMS } from '../providers/registry.js';
import {
  assertKnownProviderPlatform,
  buildProviderSettingsSnapshot,
  MODEL_OVERRIDE_PREFIX,
  PROVIDER_OVERRIDE_PREFIX,
} from './overrides.js';

export { SETTINGS_SCHEMA_VERSION };
/* [por que] La API publica de overrides se re-expone con delegacion local (no
 * con `export ... from`) para no mezclar barrel y logica (mixed-barrel-logic). */
import { SettingsValidationError, validateModelSettingsOverrides as validateModelOverrides, validateProviderSettingsOverrides as validateProviderOverrides } from './overrides.js';
export { SettingsValidationError, validateModelSettingsOverrides, validateProviderSettingsOverrides };

function validateProviderSettingsOverrides(value: unknown): ProviderSettingsOverrides {
  return validateProviderOverrides(value);
}

function validateModelSettingsOverrides(value: unknown): ModelSettingsOverrides {
  return validateModelOverrides(value);
}
import { commitRawValues, getRevision } from './persistence.js';

import { getDefinition, SETTING_DEFINITIONS } from './definitions.js';
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

  commitRawValues(validated.map(([key, value]) => [key, JSON.stringify(value)]), expectedRevision);
  return getSettingsSnapshot();
}

export function getProviderSettingsSnapshot(): ProviderSettingsSnapshot {
  const { providers } = buildProviderSettingsSnapshot();
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
  assertKnownProviderPlatform(platform);
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
  assertKnownProviderPlatform(platform);
  if (!modelId || modelId.length > 200 || modelId.includes('\u0000')) throw new SettingsValidationError('Invalid model id');
  const validated = validateModelSettingsOverrides(overrides);
  commitRawValues([[`${MODEL_OVERRIDE_PREFIX}${platform}:${modelId}`, JSON.stringify(validated)]], expectedRevision);
  return getProviderSettingsSnapshot();
}
