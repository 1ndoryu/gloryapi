import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { RequestHistoryItem, RecentError } from '@/components/analytics/AnalyticsTypes'
import {
  formatHistoryTime,
  formatTokens,
  reasoningEffortLabel,
  requestKindLabel,
} from '@/components/analytics/AnalyticsFormatters'

export function ModelBreakdownTable({ rows }: { rows: Array<{ platform: string; displayName: string; requests: number; successRate: number; avgLatencyMs: number; totalInputTokens?: number; totalOutputTokens?: number }> }) {
  return (
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
        {rows.map(m => (
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
  )
}

export function RequestHistoryTable({ rows }: { rows: RequestHistoryItem[] }) {
  return (
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
        {rows.map(entry => (
          <TableRow key={entry.id}>
            <TableCell className="pl-4 text-xs text-muted-foreground whitespace-nowrap">
              {formatHistoryTime(entry.createdAt)}
            </TableCell>
            <TableCell className="min-w-[220px]">
              <div className="text-sm font-medium">{entry.displayName}</div>
              <div className="text-xs text-muted-foreground truncate max-w-[280px]">{entry.modelId}</div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {requestKindLabel(entry.requestKind)}
                {entry.parentRequestId ? ' · vinculada al turno principal' : ''}
              </div>
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
              {entry.cachedInputTokens > 0 ? (
                <div className="text-[10px] text-muted-foreground">{formatTokens(entry.cachedInputTokens)} cacheados</div>
              ) : null}
              {entry.reasoningEffort ? (
                <div className="text-[10px] text-muted-foreground">
                  Razonamiento: {reasoningEffortLabel(entry.reasoningEffort)} · {
                    entry.reasoningTokensSource === 'none'
                      ? 'no confirmado'
                      : `${formatTokens(entry.reasoningTokens)}${entry.reasoningTokensSource === 'estimated' ? ' estimados' : ' del proveedor'}`
                  }
                </div>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RecentErrorsTable({ rows }: { rows: RecentError[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Proveedor</TableHead>
          <TableHead>Mensaje</TableHead>
          <TableHead className="text-right pr-4">Hora</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 20).map(e => (
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
  )
}
