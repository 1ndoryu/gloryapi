import { isIP } from 'node:net';
import { getDb } from '../db/index.js';
import { DEFAULT_CAPABILITIES, getConfiguredProviderFromDb, type ProviderFailurePolicy, type ProviderTransportOptions } from './provider-configuration.js';
import { ConfigurationRevisionConflictError, ConfigurationValidationError, type ConfigurationProvider, type ConfigurationSnapshot } from './configuration-v2-contract.js';
import { abandonIdempotency, claimIdempotency, completeIdempotency, normalizeIdempotencyKey } from './configuration-v2-idempotency.js';
import { getConfigurationSnapshot } from './configuration-v2-catalog.js';
import { getRevision, writeRevision } from './configuration-v2-storage.js';
function validateProviderPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(normalized)) throw new ConfigurationValidationError('platform must be a stable lowercase slug');
  return normalized;
}

export function validateProviderEndpoint(endpoint: string): string {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new ConfigurationValidationError('endpoint must be a valid URL'); }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' || !hostname || hostname === 'localhost' || hostname.endsWith('.local') || isIP(hostname) !== 0) {
    throw new ConfigurationValidationError('endpoint must use HTTPS and a public hostname');
  }
  return parsed.toString().replace(/\/$/, '');
}

function validateTransportOptions(input: Partial<ProviderTransportOptions>): ProviderTransportOptions {
  const allowedProfiles = new Set(['none', 'null-assistant', 'deepseek-thinking']);
  const efforts = new Set(['low', 'medium', 'high', 'max']);
  if (input.messageProfile !== undefined && !allowedProfiles.has(input.messageProfile)) throw new ConfigurationValidationError('Unsupported messageProfile');
  if (input.maxReasoningEffort !== undefined && !efforts.has(input.maxReasoningEffort)) throw new ConfigurationValidationError('Unsupported maxReasoningEffort');
  if (input.includeStreamUsage !== undefined && typeof input.includeStreamUsage !== 'boolean') throw new ConfigurationValidationError('includeStreamUsage must be boolean');
  if (input.bufferUntilContent !== undefined && typeof input.bufferUntilContent !== 'boolean') throw new ConfigurationValidationError('bufferUntilContent must be boolean');
  if (input.bufferUntilDone !== undefined && typeof input.bufferUntilDone !== 'boolean') throw new ConfigurationValidationError('bufferUntilDone must be boolean');
  const aliases = input.modelAliases ?? {};
  const limits = input.modelReasoningLimits ?? {};
  if (typeof aliases !== 'object' || Array.isArray(aliases) || Object.keys(aliases).length > 128) throw new ConfigurationValidationError('modelAliases must be a bounded object');
  if (typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).length > 128) throw new ConfigurationValidationError('modelReasoningLimits must be a bounded object');
  for (const [key, value] of Object.entries(aliases)) if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(key) || typeof value !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value)) throw new ConfigurationValidationError('modelAliases contains an invalid key or value');
  for (const [key, value] of Object.entries(limits)) if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(key) || !efforts.has(value)) throw new ConfigurationValidationError('modelReasoningLimits contains an invalid entry');
  return {
    messageProfile: input.messageProfile ?? 'none',
    includeStreamUsage: input.includeStreamUsage ?? false,
    bufferUntilContent: input.bufferUntilContent ?? false,
    bufferUntilDone: input.bufferUntilDone ?? false,
    maxReasoningEffort: input.maxReasoningEffort ?? 'high',
    modelAliases: aliases,
    modelReasoningLimits: limits,
    extraHeadersProfile: input.extraHeadersProfile === 'openrouter' ? 'openrouter' : 'none',
  };
}

function validateFailurePolicy(input: Partial<ProviderFailurePolicy>): ProviderFailurePolicy {
  const bounded = (value: unknown, name: string, max: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new ConfigurationValidationError(`${name} must be an integer between 0 and ${max}`);
    return value;
  };
  const cooldownMs = bounded(input.cooldownMs, 'cooldownMs', 86400000) ?? 300000;
  const rateLimitCooldownMs = bounded(input.rateLimitCooldownMs, 'rateLimitCooldownMs', 604800000);
  return {
    cooldownMs,
    ...(rateLimitCooldownMs === undefined ? {} : { rateLimitCooldownMs }),
    recordPenalty: input.recordPenalty ?? false,
    recordProviderFailure: input.recordProviderFailure ?? true,
  };
}

export function updateConfigurationProvider(
  platform: string,
  input: {
    expectedRevision?: number;
    displayName?: string;
    lifecycle?: 'active' | 'archived' | 'draft';
    enabled?: boolean;
    endpoint?: string;
    timeoutMs?: number;
    capabilities?: Partial<ConfigurationProvider['capabilities']>;
    transport?: Partial<ProviderTransportOptions>;
    failurePolicy?: Partial<ProviderFailurePolicy>;
    idempotencyKey?: string;
    actor?: string;
    source?: string;
  },
): ConfigurationSnapshot {
  const db = getDb();
  const normalizedPlatform = validateProviderPlatform(platform);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'provider-update', platform: normalizedPlatform, input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const current = getConfiguredProviderFromDb(db, normalizedPlatform);
    if (!current) throw new ConfigurationValidationError(`Provider '${normalizedPlatform}' does not exist`);
    const nextEndpoint = input.endpoint === undefined ? current.endpoint : validateProviderEndpoint(input.endpoint);
    const nextTimeout = input.timeoutMs === undefined ? current.timeoutMs : input.timeoutMs;
    if (!Number.isInteger(nextTimeout) || nextTimeout < 1000 || nextTimeout > 300000) throw new ConfigurationValidationError('timeoutMs must be between 1000 and 300000');
    const nextCapabilities = { ...current.capabilities, ...(input.capabilities ?? {}) };
    const nextTransport = validateTransportOptions({ ...current.transport, ...(input.transport ?? {}) });
    const nextPolicy = validateFailurePolicy({ ...current.failurePolicy, ...(input.failurePolicy ?? {}) });
    const next = {
      displayName: input.displayName?.trim() || current.displayName,
      lifecycle: input.lifecycle ?? current.lifecycle,
      enabled: input.enabled === undefined ? current.enabled : input.enabled,
      endpoint: nextEndpoint,
      timeoutMs: nextTimeout,
      capabilities: nextCapabilities,
      transport: nextTransport,
      failurePolicy: nextPolicy,
    };
    if (!next.displayName) throw new ConfigurationValidationError('displayName cannot be empty');
    db.prepare(`
      UPDATE configuration_providers SET display_name = ?, lifecycle = ?, enabled = ?, endpoint = ?,
        timeout_ms = ?, capabilities_json = ?, transport_json = ?, failure_policy_json = ?, updated_at = datetime('now')
      WHERE platform = ?
    `).run(next.displayName, next.lifecycle, next.enabled ? 1 : 0, next.endpoint, next.timeoutMs, JSON.stringify(next.capabilities), JSON.stringify(next.transport), JSON.stringify(next.failurePolicy), normalizedPlatform);
    if (next.enabled !== current.enabled || next.lifecycle !== current.lifecycle) {
      const available = next.enabled && next.lifecycle === 'active' ? 1 : 0;
      db.prepare(`
        UPDATE fallback_config SET enabled = CASE WHEN ? = 1 THEN (
          SELECT m.enabled FROM models m WHERE m.id = fallback_config.model_db_id
        ) ELSE 0 END
        WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)
      `).run(available, normalizedPlatform);
      db.prepare(`
        UPDATE routing_route_members SET enabled = CASE WHEN ? = 1 THEN (
          SELECT m.enabled FROM models m WHERE m.id = routing_route_members.model_db_id
        ) ELSE 0 END
        WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)
      `).run(available, normalizedPlatform);
    }
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Actualización del proveedor ${normalizedPlatform}`, { type: 'provider', platform: normalizedPlatform, before: current, after: next });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
}

export function createConfigurationProvider(input: {
  platform: string;
  displayName: string;
  endpoint: string;
  adapter?: 'openai-compatible';
  authScheme?: 'bearer';
  timeoutMs?: number;
  capabilities?: Partial<ConfigurationProvider['capabilities']>;
  transport?: Partial<ProviderTransportOptions>;
  failurePolicy?: Partial<ProviderFailurePolicy>;
  enabled?: boolean;
  lifecycle?: 'active' | 'draft';
  actor?: string;
  source?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}): ConfigurationSnapshot {
  const platform = validateProviderPlatform(input.platform);
  const displayName = input.displayName.trim();
  if (!displayName) throw new ConfigurationValidationError('displayName cannot be empty');
  if (input.adapter && input.adapter !== 'openai-compatible') throw new ConfigurationValidationError('Only openai-compatible providers can be configured dynamically');
  const endpoint = validateProviderEndpoint(input.endpoint);
  const timeoutMs = input.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new ConfigurationValidationError('timeoutMs must be between 1000 and 300000');
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(input.capabilities ?? {}) };
  const transport = validateTransportOptions(input.transport ?? {});
  const failurePolicy = validateFailurePolicy(input.failurePolicy ?? {});
  const db = getDb();
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = claimIdempotency(db, idempotencyKey, { operation: 'provider-create', input: { ...input, idempotencyKey: undefined } });
  if (replay) return replay;
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevision = getRevision(db);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new ConfigurationRevisionConflictError(currentRevision);
    const duplicate = db.prepare('SELECT platform FROM configuration_providers WHERE platform = ?').get(platform);
    if (duplicate) throw new ConfigurationValidationError(`Provider '${platform}' already exists`);
    db.prepare(`
      INSERT INTO configuration_providers (platform, display_name, lifecycle, adapter, endpoint, auth_scheme, enabled, timeout_ms, capabilities_json, transport_json, failure_policy_json)
      VALUES (?, ?, ?, 'openai-compatible', ?, 'bearer', ?, ?, ?, ?, ?)
    `).run(platform, displayName, input.lifecycle ?? 'draft', endpoint, input.enabled === true ? 1 : 0, timeoutMs, JSON.stringify(capabilities), JSON.stringify(transport), JSON.stringify(failurePolicy));
    writeRevision(db, currentRevision, input.actor ?? 'configuration-api', input.source ?? 'configuration', `Alta del proveedor ${platform}`, { type: 'provider-create', platform, displayName });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    abandonIdempotency(db, idempotencyKey);
    throw error;
  }
  const snapshot = getConfigurationSnapshot();
  completeIdempotency(db, idempotencyKey, snapshot);
  return snapshot;
}
