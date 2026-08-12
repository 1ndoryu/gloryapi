type DashboardSession = {
  token: string
  csrfToken: string
  expiresAt: number
}

const STORAGE_KEY = 'gloryapi.dashboard.session.v1'
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

function readSession(): DashboardSession | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<DashboardSession> | null
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.csrfToken !== 'string' || typeof parsed.expiresAt !== 'number') return null
    if (parsed.expiresAt <= Date.now() + 5_000) return null
    return parsed as DashboardSession
  } catch {
    return null
  }
}

let pending: Promise<DashboardSession> | null = null

export async function ensureDashboardSession(): Promise<DashboardSession> {
  const existing = readSession()
  if (existing) return existing
  if (!pending) {
    pending = fetch(`${BASE}/api/session/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      .then(async response => {
        if (!response.ok) throw new Error(`La sesión del panel no está disponible (HTTP ${response.status})`)
        const payload = await response.json() as { token: string; csrfToken: string; expiresAt: string }
        const session: DashboardSession = {
          token: payload.token,
          csrfToken: payload.csrfToken,
          expiresAt: Date.parse(payload.expiresAt),
        }
        if (!session.token || !session.csrfToken || !Number.isFinite(session.expiresAt)) throw new Error('Sesión del panel no válida')
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
        return session
      })
      .finally(() => { pending = null })
  }
  return pending
}
