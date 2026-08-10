export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getProviderErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;

  const error = payload.error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    const firstMessage = errors.find(isRecord)?.message;
    if (typeof firstMessage === 'string') return firstMessage;
  }

  return fallback;
}
