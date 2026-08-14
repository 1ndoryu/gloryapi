import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { apiFetch } from '@/lib/api'
import { ensureDashboardSession } from '@/lib/session'

export interface FallbackEntryIdentity {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
}

export interface FallbackEntryRanking {
  priority: number
  effectivePriority: number
  intelligenceRank: number
  speedRank: number
  penalty: number
  rateLimitHits: number
}

export interface FallbackEntryUsage {
  enabled: boolean
  arenaElo: number | null
  artificialAnalysisCodingIndex: number | null
  rpmLimit: number | null
  rpdLimit: number | null
  keyCount: number
  totalRequests: number
  successRate: number | null
}

export interface FallbackEntry extends FallbackEntryIdentity, FallbackEntryRanking, FallbackEntryUsage {}

export interface FallbackRuntime {
  inFlight: Array<{ attemptId: string; platform: string; modelId: string; startedAt: string }>
  lastCompleted: { platform: string; modelId: string; completedAt: string } | null
}

export interface FallbackSnapshot {
  schemaVersion: 'glory-routing-v1'
  revision: number
  entries: FallbackEntry[]
  runtime?: FallbackRuntime
}

export interface ConfiguredModel {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  contextWindow: number | null
  nativeVision: boolean
  supportsReasoning: boolean
  routeIds: string[]
}

export interface ConfigurationSnapshot {
  schemaVersion: 'glory-configuration-v2'
  revision: number
  models: ConfiguredModel[]
}

async function listenForRoutingChanges(
  signal: AbortSignal,
  onChange: () => void,
): Promise<void> {
  const session = await ensureDashboardSession()
  const response = await fetch('/api/fallback/events', {
    headers: { Authorization: `Bearer ${session.token}` },
    signal,
  })
  if (!response.ok) throw new Error(`La sincronización del enrutamiento no está disponible (HTTP ${response.status})`)
  if (!response.body) throw new Error('La sincronización del enrutamiento no devolvió ningún flujo')

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
      if (eventName === 'routing.changed' || eventName === 'routing.runtime') onChange()
    }
  }
}

export function useFallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [eventError, setEventError] = useState<string | null>(null)
  const queuedEntries = useRef<FallbackEntry[] | null>(null)

  const { data: snapshot, isLoading } = useQuery<FallbackSnapshot>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: configuration } = useQuery<ConfigurationSnapshot>({
    queryKey: ['configuration'],
    queryFn: () => apiFetch('/api/configuration'),
  })
  const entries = snapshot?.entries ?? []

  useEffect(() => {
    const controller = new AbortController()
    listenForRoutingChanges(controller.signal, () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    }).catch(error => {
      if (!controller.signal.aborted) setEventError((error as Error).message)
    })
    return () => controller.abort()
  }, [queryClient])

  const saveMutation = useMutation({
    mutationFn: (input: { expectedRevision: number; entries: { modelDbId: number; priority: number; enabled: boolean }[] }) =>
      apiFetch<FallbackSnapshot>('/api/fallback', {
        method: 'PUT',
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

  const modelMutation = useMutation({
    mutationFn: (input: { modelDbId: number; patch: Partial<Omit<ConfiguredModel, 'modelDbId' | 'platform' | 'modelId' | 'routeIds'>> }) => {
      const { modelDbId, patch } = input
      return apiFetch<ConfigurationSnapshot>(`/api/configuration/models/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, expectedRevision: configuration?.revision }),
      })
    },
    onSuccess: next => queryClient.setQueryData(['configuration'], next),
  })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(entry => entry.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(entry => entry.keyCount === 0).map(entry => entry.platform))]
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function persist(nextEntries: FallbackEntry[]) {
    if (!snapshot) return
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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(entry => entry.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(entry => entry.modelDbId === over.id)
    const reorderedVisible = arrayMove(displayEntries, oldIndex, newIndex)
    const unconfigured = allEntries.filter(entry => entry.keyCount === 0)
    persist([
      ...reorderedVisible.map((entry, index) => ({ ...entry, priority: index + 1 })),
      ...unconfigured.map((entry, index) => ({ ...entry, priority: reorderedVisible.length + index + 1 })),
    ])
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    persist(allEntries.map(entry => entry.modelDbId === modelDbId ? { ...entry, enabled } : entry))
  }

  return {
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
  }
}
