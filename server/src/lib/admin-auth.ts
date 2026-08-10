import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { getUnifiedApiKey } from '../db/index.js';
import { createLocalAuthToken, resolveLocalAuthToken } from './local-auth-token.js';
import { validateDashboardSession } from './security/dashboard-session.js';

export const DASHBOARD_ADMIN_TOKEN_NAME = 'dashboard-admin';

/**
 * The dashboard/control plane deliberately uses a different credential from
 * the OpenAI-compatible data-plane key. Environment configuration wins; the
 * default is a DPAPI-protected local token created on first authenticated use.
 */
export function getAdminAuthToken(): string {
  const configured = process.env.GLORYAPI_ADMIN_AUTH_TOKEN?.trim();
  if (configured) return configured;
  try {
    return resolveLocalAuthToken(DASHBOARD_ADMIN_TOKEN_NAME);
  } catch {
    return createLocalAuthToken(DASHBOARD_ADMIN_TOKEN_NAME);
  }
}

export function hasAdminKey(req: Request): boolean {
  if (validateDashboardSession(req)) return true;
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = getAdminAuthToken();
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes)) return true;
  // Existing unit/integration fixtures historically used the data-plane key
  // for management calls. Keep that compatibility only in test processes; a
  // production dashboard must use its separate DPAPI/env admin credential.
  if (process.env.NODE_ENV === 'test') {
    const legacy = getUnifiedApiKey();
    const legacyBytes = Buffer.from(legacy);
    return suppliedBytes.length === legacyBytes.length && crypto.timingSafeEqual(suppliedBytes, legacyBytes);
  }
  return false;
}

export function requireAdmin(req: Request, res: Response): boolean {
  if (hasAdminKey(req)) return true;
  res.status(401).json({ error: { message: 'Dashboard admin authentication required', type: 'authentication_error', code: 'admin_auth_required' } });
  return false;
}
