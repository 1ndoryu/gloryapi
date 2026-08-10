import { ensureDashboardSession } from './session'

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const session = path.startsWith('/api/session/') ? null : await ensureDashboardSession()
  const method = (options?.method ?? 'GET').toUpperCase()
  const optionHeaders = Object.fromEntries(new Headers(options?.headers).entries())
  const { headers: _ignoredHeaders, ...requestOptions } = options ?? {}
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    ...(session && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token': session.csrfToken } : {}),
    ...optionHeaders,
  }
  const res = await fetch(`${BASE}${path}`, {
    ...requestOptions,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
