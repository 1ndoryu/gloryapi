import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ConfiguredModel, ConfigurationFieldDefinition, ConfigurationRoute } from '@/hooks/useFallbackPage.types'

/* [por que] El diálogo mantiene 4 estados (nombre, habilitado, visible y selección); la regla
 * usestate-excesivo pide extraerlos a un hook dedicado para que el componente quede plano. */
function useRouteDialogState(route: ConfigurationRoute, models: ConfiguredModel[]) {
  const initialIds = useMemo(() => new Set(route.members.filter(member => member.enabled).map(member => member.modelDbId)), [route.members])
  const [name, setName] = useState(route.name)
  const [flags, setFlags] = useState(() => ({ enabled: route.enabled, visible: route.visible }))
  const [selectedIds, setSelectedIds] = useState<Set<number>>(initialIds)
  const orderedModels = useMemo(() => {
    const priorities = new Map(route.members.map(member => [member.modelDbId, member.priority]))
    return [...models].sort((left, right) => (priorities.get(left.modelDbId) ?? 999999) - (priorities.get(right.modelDbId) ?? 999999) || left.displayName.localeCompare(right.displayName))
  }, [models, route.members])

  function toggle(modelDbId: number) {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(modelDbId)) next.delete(modelDbId)
      else next.add(modelDbId)
      return next
    })
  }

  function buildMembers(): Pick<ConfigurationRoute, 'name' | 'enabled' | 'visible' | 'members'> | null {
    const members = route.kind === 'auto'
      ? route.members.filter(member => member.enabled).map((member, index) => ({ ...member, priority: index + 1, enabled: true }))
      : orderedModels.filter(model => selectedIds.has(model.modelDbId)).map((model, index) => ({ modelDbId: model.modelDbId, priority: index + 1, enabled: true }))
    if (members.length === 0) return null
    return { name: name.trim() || route.name, ...flags, members }
  }

  return { name, setName, flags, setFlags, selectedIds, orderedModels, toggle, buildMembers }
}

export function RouteConfigDialog({
  route,
  models,
  fields,
  onClose,
  onSave,
  isSaving,
  error,
}: {
  route: ConfigurationRoute
  models: ConfiguredModel[]
  fields: ConfigurationFieldDefinition[]
  onClose: () => void
  onSave: (patch: Pick<ConfigurationRoute, 'name' | 'enabled' | 'visible' | 'members'>) => void
  isSaving: boolean
  error: string | null
}) {
  const { name, setName, flags, setFlags, selectedIds, orderedModels, toggle, buildMembers } = useRouteDialogState(route, models)
  const routeFields = fields.filter(field => field.scope === 'route')
  const nameField = routeFields.find(field => field.key === 'name')
  const enabledField = routeFields.find(field => field.key === 'enabled')
  const visibleField = routeFields.find(field => field.key === 'visible')

  function save() {
    const patch = buildMembers()
    if (patch) onSave(patch)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="w-full max-w-xl rounded-xl border bg-card p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="configurar-ruta-titulo">
        <div className="flex items-start justify-between gap-4">
          <div><h2 id="configurar-ruta-titulo" className="text-base font-semibold">Configurar ruta</h2><p className="mt-1 text-xs font-mono text-muted-foreground">{route.routeId} · {route.kind}</p></div>
          <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
        </div>
        <div className="mt-5 space-y-4">
          {nameField && <div className="space-y-1.5"><Label htmlFor="ruta-nombre">{nameField.label}</Label><Input id="ruta-nombre" value={name} minLength={nameField.min} maxLength={nameField.max} onChange={event => setName(event.target.value)} /><p className="text-xs text-muted-foreground">{nameField.description}</p></div>}
          <div className="flex flex-wrap gap-4 text-sm">{enabledField && <label className="flex items-center gap-2"><input type="checkbox" checked={flags.enabled} onChange={event => setFlags(current => ({ ...current, enabled: event.target.checked }))} /> {enabledField.label}</label>}{visibleField && <label className="flex items-center gap-2"><input type="checkbox" checked={flags.visible} onChange={event => setFlags(current => ({ ...current, visible: event.target.checked }))} /> {visibleField.label}</label>}</div>
          {route.kind === 'auto' ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">La pertenencia y el orden de Auto se controlan directamente en la lista principal.</p>
          ) : (
            <div className="space-y-2"><p className="text-sm font-medium">Modelos de respaldo, en este orden</p>{orderedModels.map(model => <label key={model.modelDbId} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="checkbox" checked={selectedIds.has(model.modelDbId)} onChange={() => toggle(model.modelDbId)} /><span className="flex-1">{model.displayName}<span className="ml-2 text-xs text-muted-foreground">{model.platform}/{model.modelId}</span></span></label>)}</div>
          )}
          {route.kind !== 'auto' && selectedIds.size === 0 && <p className="text-sm text-destructive">Selecciona al menos un modelo.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t pt-4"><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={save} disabled={isSaving || (route.kind !== 'auto' && selectedIds.size === 0)}>{isSaving ? 'Guardando…' : 'Guardar ruta'}</Button></div>
        </div>
      </section>
    </div>
  )
}
