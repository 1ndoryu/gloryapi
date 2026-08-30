import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { ConfiguredModel, FallbackEntry } from '@/hooks/useFallbackPage.types'

export function SortableModelRow({
  model,
  entry,
  autoMember,
  autoPriority,
  autoToggleDisabled,
  onToggleAuto,
  onConfigureModel,
  onConfigureRoute,
}: {
  model: ConfiguredModel
  entry?: FallbackEntry
  autoMember: boolean
  autoPriority: number | null
  autoToggleDisabled: boolean
  onToggleAuto: (modelDbId: number, included: boolean) => void
  onConfigureModel: (modelDbId: number) => void
  onConfigureRoute: (routeId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: model.modelDbId, disabled: !autoMember })
  const pinnedRouteId = model.routeIds.find(routeId => routeId !== 'route:auto')
  const keyMissing = entry ? entry.keyCount === 0 : false
  return (
    <div ref={setNodeRef} data-sortable-row="true" style={{ '--sortable-transform': CSS.Transform.toString(transform), '--sortable-transition': transition } as CSSProperties} className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50' : ''} ${!model.enabled ? 'opacity-50' : ''}`}>
      <button {...attributes} {...listeners} disabled={!autoMember} className={autoMember ? 'cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors' : 'text-transparent'} aria-label={autoMember ? 'Arrastrar para reordenar Auto' : 'Modelo fuera de Auto'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{autoPriority ?? '—'}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{model.displayName}</span>
          <span className="text-xs text-muted-foreground">{model.platform}</span>
          {autoMember && <span className="text-xs text-blue-600 dark:text-blue-400">Auto</span>}
          {!autoMember && <span className="text-xs text-muted-foreground">Solo explícito</span>}
          {keyMissing && <span className="text-xs text-amber-600 dark:text-amber-400">sin clave</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{model.supportsReasoning ? 'Razonamiento disponible' : 'Sin razonamiento declarado'}</span>
          {model.nativeVision && <span>Visión nativa</span>}
          {model.pickerId && <span>Selector: {model.pickerId}</span>}
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground" title={autoToggleDisabled ? 'Auto debe conservar al menos un modelo' : 'Incluir o quitar de Auto'}>
        <span>Auto</span>
        <Switch checked={autoMember} disabled={autoToggleDisabled} onCheckedChange={checked => onToggleAuto(model.modelDbId, checked)} />
      </label>
      <Button variant="ghost" size="xs" onClick={() => onConfigureModel(model.modelDbId)}>Configurar modelo</Button>
      {pinnedRouteId && <Button variant="outline" size="xs" onClick={() => onConfigureRoute(pinnedRouteId)}>Configurar ruta</Button>}
    </div>
  )
}
