import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Panel, Stat } from '@/components/analytics/AnalyticsPrimitives'
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


function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatHistoryTime(value: string): string {
  return new Date(value).toLocaleString('es-VE', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'

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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Solicitudes" value={summary?.totalRequests ?? 0} />
          <Stat label="Tasa de éxito" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Tokens de entrada" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Tokens de salida" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Latencia media" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Ahorro estimado" value={`$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Solicitudes por proveedor">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Todavía no hay datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Latencia media por proveedor">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Todavía no hay datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name="Latencia (ms)" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Solicitudes a lo largo del tiempo">
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Todavía no hay datos</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
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
                <p className="text-sm text-muted-foreground text-center py-8">Todavía no hay datos</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Modelo</TableHead>
                        <TableHead>Proveedor</TableHead>
                        <TableHead className="text-right">Solicitudes</TableHead>
                        <TableHead className="text-right">Éxito</TableHead>
                        <TableHead className="text-right">Latencia</TableHead>
                        <TableHead className="text-right">Tokens entrada</TableHead>
                        <TableHead className="text-right pr-4">Tokens salida</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map(m => (
                        <TableRow key={`${m.platform}:${m.displayName}`}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(m.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errores por proveedor">
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">No hay errores</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Historial reciente de solicitudes">
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Todavía no hay solicitudes</p>
              ) : (
                <div className="max-h-[320px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Cuándo</TableHead>
                        <TableHead>Modelo</TableHead>
                        <TableHead>Proveedor</TableHead>
                        <TableHead>Clave API</TableHead>
                        <TableHead>Resultado</TableHead>
                        <TableHead className="text-right">Latencia</TableHead>
                        <TableHead className="text-right pr-4">Tokens</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map(entry => (
                        <TableRow key={entry.id}>
                          <TableCell className="pl-4 text-xs text-muted-foreground whitespace-nowrap">
                            {formatHistoryTime(entry.createdAt)}
                          </TableCell>
                          <TableCell className="min-w-[220px]">
                            <div className="text-sm font-medium">{entry.displayName}</div>
                            <div className="text-xs text-muted-foreground truncate max-w-[280px]">{entry.modelId}</div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{entry.platform}</TableCell>
                          <TableCell className="text-xs">
                            {entry.apiKeyLabel
                              ? <span className="font-mono text-[10px]">{entry.apiKeyLabel}</span>
                              : <span className="text-muted-foreground/50 text-[10px]">{entry.apiKeyId ? `#${entry.apiKeyId}` : '-'}</span>
                            }
                          </TableCell>
                          <TableCell className="min-w-[220px]">
                            <div className="flex items-center gap-2">
                              <Badge variant={entry.status === 'success' ? 'secondary' : 'destructive'}>
                                {entry.status === 'success' ? 'Éxito' : 'Error'}
                              </Badge>
                              <span className="text-xs">{entry.resultBrief}</span>
                            </div>
                            {entry.status === 'error' && entry.errorPreview && entry.errorPreview !== entry.resultBrief ? (
                              <div className="text-xs text-muted-foreground truncate max-w-[280px] mt-1">{entry.errorPreview}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums whitespace-nowrap">{entry.latencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums pr-4 whitespace-nowrap">
                            {formatTokens(entry.inputTokens)} / {formatTokens(entry.outputTokens)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errores recientes">
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No hay errores</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Proveedor</TableHead>
                      <TableHead>Mensaje</TableHead>
                      <TableHead className="text-right pr-4">Hora</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map(e => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
