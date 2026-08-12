import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { PageHeader } from '@/components/page-header'
import { SortableModelRow } from '@/components/routing/SortableModelRow'
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
  } = useFallbackPage()

  return (
    <div>
      <PageHeader title="Routing" description="Drag to reorder. Requests try models top-to-bottom until one succeeds." />
      <div className="space-y-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : displayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border divide-y overflow-hidden">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={displayEntries.map(entry => entry.modelDbId)} strategy={verticalListSortingStrategy}>
                  {displayEntries.map((entry, index) => (
                    <SortableModelRow key={entry.modelDbId} entry={entry} index={index} onToggle={handleToggle} />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            <div className="flex justify-between items-center gap-3">
              {eventError ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">{eventError}</span>
              ) : snapshot?.runtime?.inFlight.length ? (
                <span className="text-xs text-muted-foreground">In flight: {snapshot.runtime.inFlight.map(entry => `${entry.platform}/${entry.modelId}`).join(', ')}</span>
              ) : snapshot?.runtime?.lastCompleted ? (
                <span className="text-xs text-muted-foreground">Last completed: {snapshot.runtime.lastCompleted.platform}/{snapshot.runtime.lastCompleted.modelId}</span>
              ) : <span />}
              {saveMutation.isPending ? (
                <span className="text-xs text-muted-foreground">Saving…</span>
              ) : saveError ? (
                <span className="text-xs text-destructive">{saveError}</span>
              ) : snapshot ? (
                <span className="text-xs text-muted-foreground">Saved · revision {snapshot.revision}</span>
              ) : null}
            </div>
            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">Hidden (no keys): {unconfiguredPlatforms.join(', ')}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
