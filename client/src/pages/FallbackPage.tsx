import { useState } from 'react'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { PageHeader } from '@/components/page-header'
import { SortableModelRow } from '@/components/routing/SortableModelRow'
import { ModelConfigDialog } from '@/components/routing/ModelConfigDialog'
import { RouteConfigDialog } from '@/components/routing/RouteConfigDialog'
import { Button } from '@/components/ui/button'
import { useFallbackPage } from '@/hooks/useFallbackPage'

export default function FallbackPage() {
  const {
    snapshot,
    isLoading,
    sensors,
    handleAutoDragEnd,
    toggleAutoMembership,
    eventError,
    configuration,
    modelMutation,
    routeMutation,
  } = useFallbackPage()
  const [configuredModelDbId, setConfiguredModelDbId] = useState<number | null>(null)
  const [configuredRouteId, setConfiguredRouteId] = useState<string | null>(null)
  const configuredModel = configuration?.models.find(model => model.modelDbId === configuredModelDbId) ?? null
  const configuredRoute = configuration?.routes.find(route => route.routeId === configuredRouteId) ?? null
  const autoMembers = configuration?.routes.find(route => route.routeId === 'route:auto')?.members.filter(member => member.enabled) ?? []
  const autoPriority = new Map(autoMembers.map(member => [member.modelDbId, member.priority]))
  const statsByModelId = new Map((snapshot?.entries ?? []).map(entry => [entry.modelDbId, entry]))
  const models = [...(configuration?.models ?? [])].sort((left, right) => {
    const leftPriority = autoPriority.get(left.modelDbId) ?? Number.MAX_SAFE_INTEGER
    const rightPriority = autoPriority.get(right.modelDbId) ?? Number.MAX_SAFE_INTEGER
    return leftPriority - rightPriority || left.displayName.localeCompare(right.displayName)
  })

  return (
    <div>
      <PageHeader title="Modelos y enrutamiento" description="Una sola lista de modelos. Marca Auto para incluirlo en la ruta automática y configura su ruta fijada desde la misma fila." actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setConfiguredRouteId('route:auto')} disabled={!configuration}>Configurar opciones de Auto</Button></div>} />
      <div className="space-y-6">
        {isLoading || !configuration ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : models.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No hay modelos disponibles. Añade primero tus claves de API en la <a href="/keys" className="underline text-foreground">página de claves</a>.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Auto</span> usa únicamente las filas marcadas. Arrastra esas filas para cambiar su prioridad. Una selección explícita usa la ruta fijada de su modelo.
            </div>
            <div className="rounded-lg border divide-y overflow-hidden">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleAutoDragEnd}>
                <SortableContext items={autoMembers.map(member => member.modelDbId)} strategy={verticalListSortingStrategy}>
                  {models.map(model => (
                    <SortableModelRow
                      key={model.modelDbId}
                      model={model}
                      entry={statsByModelId.get(model.modelDbId)}
                      autoMember={autoPriority.has(model.modelDbId)}
                      autoPriority={autoPriority.get(model.modelDbId) ?? null}
                      autoToggleDisabled={autoPriority.has(model.modelDbId) && autoMembers.length <= 1}
                      onToggleAuto={toggleAutoMembership}
                      onConfigureModel={setConfiguredModelDbId}
                      onConfigureRoute={setConfiguredRouteId}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            <div className="flex justify-between items-center gap-3">
              {eventError ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">{eventError}</span>
              ) : snapshot?.runtime?.inFlight.length ? (
                <span className="text-xs text-muted-foreground">En curso: {snapshot.runtime.inFlight.map(entry => `${entry.platform}/${entry.modelId}`).join(', ')}</span>
              ) : snapshot?.runtime?.lastCompleted ? (
                <span className="text-xs text-muted-foreground">Última completada: {snapshot.runtime.lastCompleted.platform}/{snapshot.runtime.lastCompleted.modelId}</span>
              ) : <span />}
              {routeMutation.isPending ? (
                <span className="text-xs text-muted-foreground">Guardando…</span>
              ) : routeMutation.error instanceof Error ? <span className="text-xs text-destructive">{routeMutation.error.message}</span> : configuration ? <span className="text-xs text-muted-foreground">Guardado · revisión {configuration.revision}</span> : null}
            </div>
          </>
        )}
      </div>
      {configuredModel && <ModelConfigDialog model={configuredModel} fields={configuration?.schema.fields ?? []} onClose={() => setConfiguredModelDbId(null)} onSave={patch => modelMutation.mutate({ modelDbId: configuredModel.modelDbId, patch }, { onSuccess: () => setConfiguredModelDbId(null) })} isSaving={modelMutation.isPending} error={modelMutation.error instanceof Error ? modelMutation.error.message : null} />}
      {configuredRoute && <RouteConfigDialog route={configuredRoute} models={configuration?.models ?? []} fields={configuration?.schema.fields ?? []} onClose={() => setConfiguredRouteId(null)} onSave={patch => routeMutation.mutate({ routeId: configuredRoute.routeId, patch }, { onSuccess: () => setConfiguredRouteId(null) })} isSaving={routeMutation.isPending} error={routeMutation.error instanceof Error ? routeMutation.error.message : null} />}
    </div>
  )
}
