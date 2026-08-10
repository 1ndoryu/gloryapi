 import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'

interface FallbackEntryIdentity {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
}

interface FallbackEntryRanking {
  priority: number
  effectivePriority: number
  intelligenceRank: number
  speedRank: number
  penalty: number
  rateLimitHits: number
}

interface FallbackEntryUsage {
  enabled: boolean
  arenaElo: number | null
  artificialAnalysisCodingIndex: number | null
  rpmLimit: number | null
  rpdLimit: number | null
  keyCount: number
  totalRequests: number
  successRate: number | null
}

interface FallbackEntry extends FallbackEntryIdentity, FallbackEntryRanking, FallbackEntryUsage {}

interface FallbackRuntime {
  inFlight: Array<{ attemptId: string; platform: string; modelId: string; startedAt: string }>
  lastCompleted: { platform: string; modelId: string; completedAt: string } | null
}

interface FallbackSnapshot {
  schemaVersion: 'glory-routing-v1'
  revision: number
  entries: FallbackEntry[]
  runtime?: FallbackRuntime
}

function formatArenaElo(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `Arena ${value} Elo` : 'Arena n/a'
}

function formatArtificialAnalysisCodingIndex(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `AA Coding ${value.toFixed(1)}` : 'AA n/a'
}

async function listenForRoutingChanges(
  token: string,
  signal: AbortSignal,
  onChange: () => void,
): Promise<void> {
  const response = await fetch('/api/fallback/events', {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  })
  if (!response.ok) throw new Error(`Live routing sync unavailable (HTTP ${response.status})`)
  if (!response.body) throw new Error('Live routing sync returned no stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const eventName = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
      if (eventName !== 'routing.changed' && eventName !== 'routing.runtime') continue
      onChange()
    }
  }
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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
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
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty
            </span>
          )}
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
          {entry.successRate === null && entry.totalRequests === 0 && (
            <span className="text-muted-foreground/60">no requests</span>
          )}
        </div>
      </div>
      <Switch
        checked={entry.enabled}
        onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
      />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [eventError, setEventError] = useState<string | null>(null)
  const queuedEntries = useRef<FallbackEntry[] | null>(null)

  const { data: snapshot, isLoading } = useQuery<FallbackSnapshot>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: unifiedKey } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  const entries = snapshot?.entries ?? []

  useEffect(() => {
    if (!unifiedKey?.apiKey) return
    const controller = new AbortController()
    listenForRoutingChanges(unifiedKey.apiKey, controller.signal, () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    }).catch(error => {
      if (!controller.signal.aborted) setEventError((error as Error).message)
    })
    return () => controller.abort()
  }, [queryClient, unifiedKey?.apiKey])

  const saveMutation = useMutation({
    mutationFn: (input: { expectedRevision: number; entries: { modelDbId: number; priority: number; enabled: boolean }[] }) =>
      apiFetch<FallbackSnapshot>('/api/fallback', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${unifiedKey?.apiKey ?? ''}` },
        body: JSON.stringify(input),
      }),
    onSuccess: next => {
      queryClient.setQueryData(['fallback'], next)
      setSaveError(null)
      const queued = queuedEntries.current
      queuedEntries.current = null
      if (queued) {
        setLocalEntries(queued)
        queueMicrotask(() => saveMutation.mutate({
          expectedRevision: next.revision,
          entries: queued.map(entry => ({ modelDbId: entry.modelDbId, priority: entry.priority, enabled: entry.enabled })),
        }))
      } else {
        setLocalEntries(null)
      }
    },
    onError: error => {
      queuedEntries.current = null
      setLocalEntries(null)
      setSaveError((error as Error).message)
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(e => e.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(e => e.modelDbId === over.id)
    const reorderedVisible = arrayMove(displayEntries, oldIndex, newIndex)
    const unconfigured = allEntries.filter(e => e.keyCount === 0)
    const merged = [
      ...reorderedVisible.map((e, i) => ({ ...e, priority: i + 1 })),
      ...unconfigured.map((e, i) => ({ ...e, priority: reorderedVisible.length + i + 1 })),
    ]
    persist(merged)
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    const updated = allEntries.map(e =>
      e.modelDbId === modelDbId ? { ...e, enabled } : e
    )
    persist(updated)
  }

  function persist(nextEntries: FallbackEntry[]) {
    if (!snapshot || !unifiedKey?.apiKey) return
    setLocalEntries(nextEntries)
    setSaveError(null)
    if (saveMutation.isPending) {
      queuedEntries.current = nextEntries
      return
    }
    saveMutation.mutate({
      expectedRevision: snapshot.revision,
      entries: nextEntries.map(entry => ({
        modelDbId: entry.modelDbId,
        priority: entry.priority,
        enabled: entry.enabled,
      })),
    })
  }

  return (
    <div>
      <PageHeader
        title="Routing"
        description="Drag to reorder. Requests try models top-to-bottom until one succeeds."
      />

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
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={displayEntries.map(e => e.modelDbId)}
                  strategy={verticalListSortingStrategy}
                >
                  {displayEntries.map((entry, index) => (
                    <SortableModelRow
                      key={entry.modelDbId}
                      entry={entry}
                      index={index}
                      onToggle={handleToggle}
                    />
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
              <p className="text-xs text-muted-foreground">
                Hidden (no keys): {unconfiguredPlatforms.join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
