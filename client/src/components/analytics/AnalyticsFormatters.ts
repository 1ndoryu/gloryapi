import type { RequestHistoryItem } from '@/components/analytics/AnalyticsTypes'

export function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatHistoryTime(value: string): string {
  return new Date(value).toLocaleString('es-VE', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function requestKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    main: 'Principal',
    audit: 'Auditoría',
    continuation: 'Continuación',
    recovery: 'Recuperación',
    summary: 'Resumen',
    auxiliary_title: 'Título local',
  }
  return labels[kind] ?? kind
}

export function reasoningEffortLabel(effort: RequestHistoryItem['reasoningEffort']): string {
  const labels: Record<NonNullable<RequestHistoryItem['reasoningEffort']>, string> = {
    low: 'Bajo',
    medium: 'Medio',
    high: 'Alto',
    max: 'Máximo',
  }
  return effort ? labels[effort] : 'No solicitado'
}
