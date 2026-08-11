import { timingSafeStringEqual } from '../proxy-routing.js';

export type CanaryRoutingValidation =
  | { provider: string | undefined }
  | { error: { code: 'canary_route_forbidden'; message: string } };

/**
 * Validate the private provider-routing directive independently of Express so
 * normal production requests cannot accidentally inherit canary semantics.
 */
export function validateCanaryRoutingDirective(
  providerHeader: string | undefined,
  tokenHeader: string | undefined,
  runtime: { mode?: string; token?: string } = {
    mode: process.env.GLORYAPI_CANARY_MODE,
    token: process.env.GLORYAPI_CANARY_ROUTING_TOKEN?.trim(),
  },
): CanaryRoutingValidation {
  if (!providerHeader && !tokenHeader) return { provider: undefined };

  const expectedToken = runtime.token?.trim() || '';
  if (
    runtime.mode !== '1'
    || !expectedToken
    || !providerHeader
    || !/^[a-z0-9][a-z0-9-]{1,31}$/i.test(providerHeader)
    || !tokenHeader
    || !timingSafeStringEqual(tokenHeader, expectedToken)
  ) {
    return {
      error: {
        code: 'canary_route_forbidden',
        message: 'Invalid canary routing directive',
      },
    };
  }
  return { provider: providerHeader.toLowerCase() };
}
