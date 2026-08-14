import { Button } from '@/components/ui/button'
import type { ConfiguredModel, ConfigurationRoute } from '@/hooks/useFallbackPage'

function routeModel(route: ConfigurationRoute, models: ConfiguredModel[]): ConfiguredModel | null {
  const member = route.members.find(candidate => candidate.enabled) ?? route.members[0]
  return member ? models.find(model => model.modelDbId === member.modelDbId) ?? null : null
}

export function ConfiguredRouteList({
  routes,
  models,
  onConfigureModel,
  onConfigureRoute,
}: {
  routes: ConfigurationRoute[]
  models: ConfiguredModel[]
  onConfigureModel: (modelDbId: number) => void
  onConfigureRoute: (routeId: string) => void
}) {
  const pinnedRoutes = routes
    .filter(route => route.kind === 'pinned' && route.visible)
    .map(route => ({ route, model: routeModel(route, models) }))
    .filter((entry): entry is { route: ConfigurationRoute; model: ConfiguredModel } => entry.model !== null)
    .sort((left, right) => left.model.displayName.localeCompare(right.model.displayName))

  if (pinnedRoutes.length === 0) return null

  return (
    <section className="space-y-3" aria-labelledby="rutas-fijadas-titulo">
      <div>
        <h2 id="rutas-fijadas-titulo" className="text-sm font-medium">Rutas fijadas</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Modelos seleccionables de forma explícita. No se añaden a Auto salvo que los agregues a esa ruta.
        </p>
      </div>
      <div className="rounded-lg border divide-y overflow-hidden">
        {pinnedRoutes.map(({ route, model }) => (
          <div key={route.routeId} className="flex items-center gap-3 px-4 py-3 bg-card">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{model.displayName}</span>
                <span className="text-xs text-muted-foreground">{model.platform}</span>
                <span className="text-xs text-muted-foreground">Fijada</span>
                {!route.enabled || !model.enabled ? <span className="text-xs text-amber-600 dark:text-amber-400">Desactivada</span> : null}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-mono">{model.modelId}</span>
                <span>{route.name}</span>
                {model.supportsReasoning ? <span>Razonamiento</span> : null}
                {model.nativeVision ? <span>Visión</span> : null}
              </div>
            </div>
            <Button variant="ghost" size="xs" onClick={() => onConfigureModel(model.modelDbId)}>Configurar modelo</Button>
            <Button variant="outline" size="xs" onClick={() => onConfigureRoute(route.routeId)}>Configurar ruta</Button>
          </div>
        ))}
      </div>
    </section>
  )
}
