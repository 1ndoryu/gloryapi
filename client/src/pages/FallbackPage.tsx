import { DndContext, closestCenter } from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { useFallbackPage, type FallbackEntry } from '@/hooks/useFallbackPage'

function formatArenaElo(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `Arena ${value} Elo` : 'Arena n/a'
}

function formatArtificialAnalysisCodingIndex(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `AA Coding ${value.toFixed(1)}` : 'AA n/a'
}

function SortableModelRow({
  entry,
  index,
  onToggle,
}: {
  entry: FallbackEntry
  index: number
  onToggle: (modelDbId: number, enabled: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50' : ''} ${entry.enabled ? '' : 'opacity-50'}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
        aria-label="Drag to reorder"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <span className="text-xs text-muted-foreground">{entry.platform}</span>
          {entry.penalty > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">−{entry.penalty} penalty</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>{formatArenaElo(entry.arenaElo)}</span>
          <span>{formatArtificialAnalysisCodingIndex(entry.artificialAnalysisCodingIndex)}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          {entry.successRate !== null && (
            <span className={entry.successRate >= 80 ? 'text-green-600 dark:text-green-400' : entry.successRate >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>
              {entry.successRate}% success ({entry.totalRequests} req)
            </span>
          )}
          {entry.successRate === null && entry.totalRequests === 0 && <span className="text-muted-foreground/60">no requests</span>}
        </div>
      </div>
      <Switch checked={entry.enabled} onCheckedChange={checked => onToggle(entry.modelDbId, checked)} />
    </div>
  )
}

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
