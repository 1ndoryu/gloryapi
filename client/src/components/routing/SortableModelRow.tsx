import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { FallbackEntry } from '@/hooks/useFallbackPage'

function formatArenaElo(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `Arena ${value} Elo` : 'Arena n/d'
}

function formatArtificialAnalysisCodingIndex(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `AA Coding ${value.toFixed(1)}` : 'AA n/d'
}

export function SortableModelRow({ entry, index, onToggle, onConfigure }: { entry: FallbackEntry; index: number; onToggle: (modelDbId: number, enabled: boolean) => void; onConfigure: (modelDbId: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.modelDbId })
  const setSortableNode = (node: HTMLDivElement | null) => {
    setNodeRef(node)
    if (!node) return
    node.style.setProperty('--sortable-transform', CSS.Transform.toString(transform) ?? 'none')
    node.style.setProperty('--sortable-transition', transition ?? 'none')
  }
  return (
    <div ref={setSortableNode} data-sortable-row="true" className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50' : ''} ${entry.enabled ? '' : 'opacity-50'}`}>
      <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors" aria-label="Arrastrar para reordenar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap"><span className="font-medium text-sm">{entry.displayName}</span><span className="text-xs text-muted-foreground">{entry.platform}</span>{entry.penalty > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">−{entry.penalty} penalización</span>}</div><div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums"><span>Inteligencia #{entry.intelligenceRank}</span><span>{formatArenaElo(entry.arenaElo)}</span><span>{formatArtificialAnalysisCodingIndex(entry.artificialAnalysisCodingIndex)}</span><span>Velocidad #{entry.speedRank}</span>{entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}{entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}{entry.successRate !== null && <span className={entry.successRate >= 80 ? 'text-green-600 dark:text-green-400' : entry.successRate >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>{entry.successRate}% de éxito ({entry.totalRequests} solicitudes)</span>}{entry.successRate === null && entry.totalRequests === 0 && <span className="text-muted-foreground/60">sin solicitudes</span>}</div></div>
      <Button variant="ghost" size="xs" onClick={() => onConfigure(entry.modelDbId)}>Configurar</Button>
      <Switch checked={entry.enabled} onCheckedChange={checked => onToggle(entry.modelDbId, checked)} />
    </div>
  )
}
