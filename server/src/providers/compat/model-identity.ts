import type { ChatCompletionResponse, ChatCompletionChunk } from '@gloryapi/shared/types.js';

export type ModelIdentityError = Error & {
  modelDowngrade: true;
  requestedModel: string;
  effectiveModel: string;
  foreignToolset: boolean;
  retryable: true;
};

function normalizeModel(value: string): string {
  return value.trim().toLowerCase();
}

export function extractEffectiveModel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['model', 'effective_model', 'effectiveModel']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  const error = record.error;
  if (error && typeof error === 'object') return extractEffectiveModel(error);
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') return extractEffectiveModel(metadata);
  return null;
}

export function createModelIdentityError(
  requestedModel: string,
  effectiveModel: string | null,
  hasTools: boolean,
): ModelIdentityError {
  const actual = effectiveModel?.trim() ?? '';
  const error = new Error('Provider returned a model different from the requested model') as ModelIdentityError;
  error.modelDowngrade = true;
  error.requestedModel = requestedModel;
  error.effectiveModel = actual;
  error.foreignToolset = hasTools;
  error.retryable = true;
  return error;
}

export function assertEffectiveModel(
  payload: ChatCompletionResponse | ChatCompletionChunk,
  requestedUpstreamModel: string,
  hasTools: boolean,
): void {
  const effectiveModel = extractEffectiveModel(payload);
  if (!effectiveModel || normalizeModel(effectiveModel) !== normalizeModel(requestedUpstreamModel)) {
    throw createModelIdentityError(requestedUpstreamModel, effectiveModel, hasTools);
  }
}
