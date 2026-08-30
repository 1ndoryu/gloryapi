import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Panel, Stat } from '@/components/analytics/AnalyticsPrimitives'
import { ModelBreakdownTable, RequestHistoryTable, RecentErrorsTable } from '@/components/analytics/AnalyticsTables'
import { formatTokens } from '@/components/analytics/AnalyticsFormatters'
import type {
  RequestHistoryItem,
  AnalyticsSummary,
  PlatformStats,
  TimelinePoint,
  ModelStats,
  RecentError,
  ErrorDistribution,
} from '@/components/analytics/AnalyticsTypes'

type TimeRange = '24h' | '7d' | '30d'

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
const tooltipStyle = { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }

function ChartEmpty({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground text-center py-8">{label}</p>
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')

  const { data: summary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<PlatformStats[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelinePoint[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ModelStats[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<RecentError[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: history = [] } = useQuery({
    queryKey: ['analytics', 'history', range],
    queryFn: () => apiFetch<RequestHistoryItem[]>(`/api/analytics/history?range=${range}&limit=50`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
  })

  return (
    <div>
      <PageHeader
        title="Analítica"
        description="Volumen de solicitudes, latencia, uso de tokens y fallos."
        actions={
          <div className="flex gap-1 rounded-md border p-0.5">
            {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-3">
          <Stat label="Solicitudes" value={summary?.totalRequests ?? 0} />
          <Stat label="Principales" value={summary?.mainRequests ?? 0} />
          <Stat label="Auxiliares" value={summary?.auxiliaryRequests ?? 0} />
          <Stat label="Tasa de éxito" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Tokens de entrada" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Tokens de salida" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Tokens de razonamiento" value={formatTokens(summary?.totalReasoningTokens)} />
          <Stat label="Tokens cacheados" value={formatTokens(summary?.cachedInputTokens)} />
          <Stat label="Latencia media" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Coste estimado" value={`$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Solicitudes por proveedor">
            {byPlatform.length === 0 ? (
              <ChartEmpty label="Todavía no hay datos" />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Latencia media por proveedor">
            {byPlatform.length === 0 ? (
              <ChartEmpty label="Todavía no hay datos" />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="avgLatencyMs" name="Latencia (ms)" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Solicitudes a lo largo del tiempo">
              {timeline.length === 0 ? (
                <ChartEmpty label="Todavía no hay datos" />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Éxitos" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Fallos" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title="Desglose por modelo">
              {byModel.length === 0 ? (
                <ChartEmpty label="Todavía no hay datos" />
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <ModelBreakdownTable rows={byModel} />
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errores por proveedor">
            {!errorDist?.byPlatform?.length ? (
              <ChartEmpty label="No hay errores" />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Historial reciente de solicitudes">
              {history.length === 0 ? (
                <ChartEmpty label="Todavía no hay solicitudes" />
              ) : (
                <div className="max-h-[320px] overflow-y-auto -mx-4">
                  <RequestHistoryTable rows={history} />
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errores recientes">
            {errors.length === 0 ? (
              <ChartEmpty label="No hay errores" />
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <RecentErrorsTable rows={errors} />
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
