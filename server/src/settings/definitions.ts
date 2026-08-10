import type { SettingDefinition } from '@gloryapi/shared/types.js';

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'routing.maxAttempts', type: 'integer', defaultValue: 6, min: 1, max: 12,
    description: 'Maximum provider attempts allowed for one inference request.', scope: 'routing', sensitive: false, requiresRestart: false,
  },
  {
    key: 'routing.maxDurationMs', type: 'duration-ms', defaultValue: 120_000, min: 1_000, max: 10 * 60 * 1_000,
    description: 'Maximum total routing time before the request fails closed.', scope: 'routing', sensitive: false, requiresRestart: false,
  },
  {
    key: 'routing.nearLimitThreshold', type: 'number', defaultValue: 0.8, min: 0.5, max: 0.99,
    description: 'Usage ratio at which a model is deprioritized before its hard limit.', scope: 'routing', sensitive: false, requiresRestart: false,
  },
  {
    key: 'routing.stickyTtlMs', type: 'duration-ms', defaultValue: 30 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000,
    description: 'How long an inactive conversation keeps its preferred model.', scope: 'routing', sensitive: false, requiresRestart: false,
  },
  {
    key: 'routing.stickyRotationMs', type: 'duration-ms', defaultValue: 30 * 60 * 1000, min: 60 * 1000, max: 24 * 60 * 60 * 1000,
    description: 'Maximum age of a sticky model assignment before it can rotate.', scope: 'routing', sensitive: false, requiresRestart: false,
  },
  {
    key: 'health.checkIntervalMs', type: 'duration-ms', defaultValue: 5 * 60 * 1000, min: 60 * 1000, max: 60 * 60 * 1000,
    description: 'Interval between opt-in background provider health checks.', scope: 'health', sensitive: false, requiresRestart: true,
  },
  {
    key: 'health.providerFailureThreshold', type: 'integer', defaultValue: 3, min: 1, max: 10,
    description: 'Consecutive provider failures required before cooldown.', scope: 'health', sensitive: false, requiresRestart: false,
  },
  {
    // 5 min: los proveedores gratuitos se reintentan con esa cadencia sin
    // martillar pools agotados. opencode-go (pago) no se ve afectado porque su
    // política desactiva recordProviderFailure y nunca entra en este cooldown.
    key: 'health.providerCooldownMs', type: 'duration-ms', defaultValue: 5 * 60 * 1000, min: 1 * 1000, max: 60 * 60 * 1000,
    description: 'Provider cooldown after the failure threshold is reached.', scope: 'health', sensitive: false, requiresRestart: false,
  },
] as const;

const definitionsByKey = new Map(SETTING_DEFINITIONS.map(definition => [definition.key, definition]));

export function getDefinition(key: string): SettingDefinition | undefined {
  return definitionsByKey.get(key);
}
