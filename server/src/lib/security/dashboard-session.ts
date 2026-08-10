import crypto from 'node:crypto';
import type { Request } from 'express';

const SESSION_TTL_MS = 5 * 60 * 1000;
const SESSION_BYTES = 32;

type DashboardSession = {
  token: string;
  csrfToken: string;
  origin: string;
  expiresAt: number;
};

const sessions = new Map<string, DashboardSession>();

function loopbackAddress(value: string | undefined): boolean {
  const normalized = (value ?? '').replace(/^::ffff:/i, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function allowedOrigins(): Set<string> {
  return new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://[::1]:5173',
    ...(process.env.DASHBOARD_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  ]);
}

export function isDashboardOriginAllowed(origin: string | undefined, req: Request): boolean {
  if (!origin) return process.env.NODE_ENV === 'test';
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || !loopbackAddress(parsed.hostname)) return false;
    const exact = `${parsed.protocol}//${parsed.host}`;
    if (allowedOrigins().has(exact)) return true;
    const requestHost = req.get('host');
    return Boolean(requestHost && exact === `${req.protocol}://${requestHost}`);
  } catch {
    return false;
  }
}

export function issueDashboardSession(origin: string): { token: string; csrfToken: string; expiresAt: string } {
  const token = crypto.randomBytes(SESSION_BYTES).toString('base64url');
  const csrfToken = crypto.randomBytes(SESSION_BYTES).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { token, csrfToken, origin, expiresAt });
  pruneExpiredSessions();
  return { token, csrfToken, expiresAt: new Date(expiresAt).toISOString() };
}

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  if (sessions.size > 64) {
    const oldest = [...sessions.values()].sort((left, right) => left.expiresAt - right.expiresAt)[0];
    if (oldest) sessions.delete(oldest.token);
  }
}

export function validateDashboardSession(req: Request): { session: DashboardSession; mutation: boolean } | null {
  pruneExpiredSessions();
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  // Same-origin browser reads commonly omit Origin. If a caller sends one,
  // it must still match the origin that bootstrapped the session; mutations
  // require the explicit origin plus CSRF to prevent cross-site writes.
  if (origin && origin !== session.origin) return null;
  if (mutation && origin !== session.origin) return null;
  if (mutation) {
    const csrf = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
    if (csrf !== session.csrfToken) return null;
  }
  return { session, mutation };
}

export function clearDashboardSessions(): void {
  sessions.clear();
}
