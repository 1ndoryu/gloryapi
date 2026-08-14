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
    displayEntries,
    unconfiguredPlatforms,
    sensors,
    handleDragEnd,
    handleToggle,
    eventError,
    saveMutation,
    saveError,
    configuration,
    modelMutation,
    routeMutation,
  } = useFallbackPage()
  const [configuredModelDbId, setConfiguredModelDbId] = useState<number | null>(null)
  const [configuredRouteId, setConfiguredRouteId] = useState<string | null>(null)
  const configuredModel = configuration?.models.find(model => model.modelDbId === configuredModelDbId) ?? null
  const configuredRoute = configuration?.routes.find(route => route.routeId === configuredRouteId) ?? null

  return (
    <div>
      <PageHeader title="Enrutamiento" description="Arrastra para reordenar. Las solicitudes prueban los modelos de arriba abajo hasta que uno responde." actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setConfiguredRouteId('route:auto')} disabled={!configuration}>Configurar Auto</Button></div>} />
      <div className="space-y-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : displayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No hay modelos disponibles. Añade primero tus claves de API en la <a href="/keys" className="underline text-foreground">página de claves</a>.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border divide-y overflow-hidden">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={displayEntries.map(entry => entry.modelDbId)} strategy={verticalListSortingStrategy}>
                  {displayEntries.map((entry, index) => (
                    <SortableModelRow key={entry.modelDbId} entry={entry} index={index} onToggle={handleToggle} onConfigure={setConfiguredModelDbId} />
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
              {saveMutation.isPending ? (
                <span className="text-xs text-muted-foreground">Guardando…</span>
              ) : saveError ? (
                <span className="text-xs text-destructive">{saveError}</span>
              ) : snapshot ? (
                <span className="text-xs text-muted-foreground">Guardado · revisión {snapshot.revision}</span>
              ) : null}
            </div>
            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">Ocultos (sin claves): {unconfiguredPlatforms.join(', ')}</p>
            )}
          </>
        )}
      </div>
      {configuredModel && <ModelConfigDialog model={configuredModel} fields={configuration?.schema.fields ?? []} onClose={() => setConfiguredModelDbId(null)} onSave={patch => modelMutation.mutate({ modelDbId: configuredModel.modelDbId, patch }, { onSuccess: () => setConfiguredModelDbId(null) })} isSaving={modelMutation.isPending} error={modelMutation.error instanceof Error ? modelMutation.error.message : null} />}
      {configuredRoute && <RouteConfigDialog route={configuredRoute} models={configuration?.models ?? []} fields={configuration?.schema.fields ?? []} onClose={() => setConfiguredRouteId(null)} onSave={patch => routeMutation.mutate({ routeId: configuredRoute.routeId, patch }, { onSuccess: () => setConfiguredRouteId(null) })} isSaving={routeMutation.isPending} error={routeMutation.error instanceof Error ? routeMutation.error.message : null} />}
    </div>
  )
}
