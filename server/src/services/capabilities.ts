import type { RouteResult } from './router.js';
import { getProviderSettingsSnapshot } from '../settings/registry.js';

export class CapabilityValidationError extends Error {
  readonly code = 'capability_not_supported';

  constructor(message: string) {
    super(message);
    this.name = 'CapabilityValidationError';
  }
}

export interface CapabilityRequest {
  stream?: boolean;
  tools?: unknown[];
  reasoningEffort?: string;
}

export function validateRouteCapabilities(
  route: Pick<RouteResult, 'platform' | 'modelId'>,
  request: CapabilityRequest,
): CapabilityValidationError | null {
  const provider = getProviderSettingsSnapshot().providers.find(entry => entry.platform === route.platform);
  // Archived adapters remain available only for isolated migration/contract tests;
  // they are not part of the production capability gate.
  if (!provider || provider.lifecycle !== 'active') return null;
  const model = provider.models.find(entry => entry.modelId === route.modelId);
  if (!model) return null;

  const capabilities = model.effective.capabilities;
  if (request.stream === true && !capabilities.streaming) {
    return new CapabilityValidationError(`${route.platform}/${route.modelId} does not support streaming`);
  }
  if (Array.isArray(request.tools) && request.tools.length > 0 && !capabilities.tools) {
    return new CapabilityValidationError(`${route.platform}/${route.modelId} does not support tools`);
  }
  if (request.reasoningEffort && !capabilities.reasoning) {
    return new CapabilityValidationError(`${route.platform}/${route.modelId} does not support reasoning`);
  }
  return null;
}
