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
import type {
  BridgeVisionModel,
  ConfiguredModel,
  ConfigurationRoute,
  ConfigurationSnapshot,
  FallbackEntry,
  FallbackSnapshot,
} from './useFallbackPage.types'

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

  const routeMutation = useMutation({
    mutationFn: (input: { routeId: string; patch: Pick<ConfigurationRoute, 'name' | 'enabled' | 'visible' | 'members'> }) =>
      apiFetch<ConfigurationSnapshot>(`/api/configuration/routes/${encodeURIComponent(input.routeId)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...input.patch, expectedRevision: configuration?.revision }),
      }),
    onSuccess: next => queryClient.setQueryData(['configuration'], next),
  })

  const visionMutation = useMutation({
    mutationFn: (routes: BridgeVisionModel[]) => apiFetch<ConfigurationSnapshot>('/api/configuration/bridge-vision', {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: configuration?.revision,
        routes: routes.map(route => ({ routeId: route.routeId, priority: route.priority, enabled: route.enabled })),
      }),
    }),
    onSuccess: next => {
      queryClient.setQueryData(['configuration'], next)
      queryClient.setQueryData<FallbackSnapshot>(['fallback'], current => current ? { ...current, revision: next.revision, visionModels: next.bridge.visionModels } : current)
    },
  })

  function updateVisionRoutes(nextRoutes: BridgeVisionModel[]) {
    if (!configuration || nextRoutes.length === 0 || visionMutation.isPending) return
    const ordered = nextRoutes.map((route, index) => ({ ...route, priority: index + 1 }))
    visionMutation.mutate(ordered)
  }

  function toggleVisionRoute(routeId: string, enabled: boolean) {
    const routes = configuration?.bridge.visionModels ?? []
    updateVisionRoutes(routes.map(route => route.routeId === routeId ? { ...route, enabled } : route))
  }

  function moveVisionRoute(routeId: string, direction: -1 | 1) {
    const routes = [...(configuration?.bridge.visionModels ?? [])]
    const index = routes.findIndex(route => route.routeId === routeId)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= routes.length) return
    const [route] = routes.splice(index, 1)
    routes.splice(nextIndex, 0, route)
    updateVisionRoutes(routes)
  }

  const autoRoute = configuration?.routes.find(route => route.routeId === 'route:auto') ?? null

  function toggleAutoMembership(modelDbId: number, included: boolean) {
    if (!autoRoute) return
    const activeMembers = autoRoute.members.filter(member => member.enabled && member.modelDbId !== modelDbId)
    if (included) {
      const current = autoRoute.members.find(member => member.modelDbId === modelDbId)
      activeMembers.push({ modelDbId, priority: current?.priority ?? activeMembers.length + 1, enabled: true })
    }
    const members = activeMembers.map((member, index) => ({ ...member, priority: index + 1, enabled: true }))
    if (members.length === 0) return
    routeMutation.mutate({
      routeId: autoRoute.routeId,
      patch: { name: autoRoute.name, enabled: autoRoute.enabled, visible: autoRoute.visible, members },
    })
  }

  function handleAutoDragEnd(event: DragEndEvent) {
    if (!autoRoute) return
    const { active, over } = event
    if (!over || active.id === over.id) return
    const autoMembers = autoRoute.members.filter(member => member.enabled)
    const oldIndex = autoMembers.findIndex(member => member.modelDbId === active.id)
    const newIndex = autoMembers.findIndex(member => member.modelDbId === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const members = arrayMove(autoMembers, oldIndex, newIndex).map((member, index) => ({ ...member, priority: index + 1, enabled: true }))
    routeMutation.mutate({
      routeId: autoRoute.routeId,
      patch: { name: autoRoute.name, enabled: autoRoute.enabled, visible: autoRoute.visible, members },
    })
  }

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
    autoRoute,
    toggleAutoMembership,
    handleAutoDragEnd,
    modelMutation,
    routeMutation,
    visionMutation,
    toggleVisionRoute,
    moveVisionRoute,
  }
}
