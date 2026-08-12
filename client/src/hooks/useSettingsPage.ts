import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type {
  ModelSettingsOverrides,
  ProviderSettingsOverrides,
  ProviderSettingsSnapshot,
  SettingPrimitive,
  SettingScope,
  SettingValue,
  SettingsSnapshot,
} from '../../../shared/types'

export const scopeLabels: Record<SettingScope, string> = {
  routing: 'Enrutamiento',
  health: 'Salud y reintentos',
  provider: 'Proveedores',
  logging: 'Registros',
  security: 'Seguridad',
}

const settingTranslations: Record<string, { label: string; description: string }> = {
  'routing.maxAttempts': { label: 'Máximo de intentos', description: 'Máximo de proveedores que se pueden intentar para una solicitud de inferencia.' },
  'routing.maxDurationMs': { label: 'Duración máxima (ms)', description: 'Tiempo total máximo de enrutamiento antes de que la solicitud falle de forma segura.' },
  'routing.nearLimitThreshold': { label: 'Umbral de límite cercano', description: 'Proporción de uso a partir de la cual un modelo pierde prioridad antes de alcanzar su límite.' },
  'routing.stickyTtlMs': { label: 'Duración del modelo preferido (ms)', description: 'Tiempo durante el que una conversación inactiva conserva su modelo preferido.' },
  'routing.stickyRotationMs': { label: 'Rotación del modelo preferido (ms)', description: 'Antigüedad máxima de una asignación preferida antes de que pueda rotar.' },
  'health.checkIntervalMs': { label: 'Intervalo de comprobación (ms)', description: 'Intervalo entre comprobaciones de salud opcionales de los proveedores.' },
  'health.providerFailureThreshold': { label: 'Umbral de fallos del proveedor', description: 'Fallos consecutivos necesarios antes de poner un proveedor en pausa.' },
  'health.providerCooldownMs': { label: 'Pausa del proveedor (ms)', description: 'Tiempo de pausa después de alcanzar el umbral de fallos.' },
}

export function settingLabel(key: string): string {
  if (settingTranslations[key]) return settingTranslations[key].label
  const name = key.split('.').at(-1) ?? key
  return name.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`).replace(/^./, letter => letter.toUpperCase())
}

export function settingDescription(key: string, fallback: string): string {
  return settingTranslations[key]?.description ?? fallback
}

function sameValues(left: Record<string, SettingPrimitive>, right: Record<string, SettingPrimitive>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}

export function useSettingsPage() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Record<string, SettingPrimitive>>({})
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderSettingsOverrides>>({})
  const [modelDrafts, setModelDrafts] = useState<Record<string, ModelSettingsOverrides>>({})

  const { data, isLoading, isError } = useQuery<SettingsSnapshot>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings'),
  })
  const { data: providerSettings } = useQuery<ProviderSettingsSnapshot>({
    queryKey: ['provider-settings'],
    queryFn: () => apiFetch('/api/settings/providers'),
  })

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.settings.map(setting => [setting.key, setting.value])))
  }, [data])

  useEffect(() => {
    if (!providerSettings) return
    setProviderDrafts(Object.fromEntries(providerSettings.providers.map(provider => [provider.platform, provider.providerOverrides])))
    setModelDrafts(Object.fromEntries(providerSettings.providers.flatMap(provider => provider.models.map(model => [
      `${provider.platform}:${model.modelId}`,
      model.overrides,
    ]))))
  }, [providerSettings])

  const grouped = useMemo(() => {
    const groups = new Map<SettingScope, SettingValue[]>()
    for (const setting of data?.settings ?? []) {
      const entries = groups.get(setting.scope) ?? []
      entries.push(setting)
      groups.set(setting.scope, entries)
    }
    return [...groups.entries()]
  }, [data])

  const save = useMutation({
    mutationFn: (body: { expectedRevision: number; values: Record<string, SettingPrimitive> }) =>
      apiFetch<SettingsSnapshot>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: snapshot => {
      queryClient.setQueryData(['settings'], snapshot)
      setDraft(Object.fromEntries(snapshot.settings.map(setting => [setting.key, setting.value])))
    },
  })

  const saveProviderOverride = useMutation({
    mutationFn: (input: { platform: string; overrides: ProviderSettingsOverrides; revision: number }) =>
      apiFetch<ProviderSettingsSnapshot>(`/api/settings/providers/${encodeURIComponent(input.platform)}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: input.revision, values: { overrides: input.overrides } }),
      }),
    onSuccess: snapshot => {
      queryClient.setQueryData(['provider-settings'], snapshot)
      queryClient.setQueryData<SettingsSnapshot>(['settings'], current => current ? { ...current, revision: snapshot.revision } : current)
    },
  })

  const saveModelOverride = useMutation({
    mutationFn: (input: { platform: string; modelId: string; overrides: ModelSettingsOverrides; revision: number }) =>
      apiFetch<ProviderSettingsSnapshot>(`/api/settings/providers/${encodeURIComponent(input.platform)}/models/${encodeURIComponent(input.modelId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: input.revision, values: { overrides: input.overrides } }),
      }),
    onSuccess: snapshot => {
      queryClient.setQueryData(['provider-settings'], snapshot)
      queryClient.setQueryData<SettingsSnapshot>(['settings'], current => current ? { ...current, revision: snapshot.revision } : current)
    },
  })

  const hasChanges = Boolean(data && !sameValues(
    draft,
    Object.fromEntries(data.settings.map(setting => [setting.key, setting.value])),
  ))

  function updateValue(setting: SettingValue, raw: string | boolean) {
    const value = setting.type === 'boolean' ? raw : setting.type === 'string' ? raw : Number(raw)
    setDraft(current => ({ ...current, [setting.key]: value }))
  }

  function saveChanges() {
    if (data && hasChanges) save.mutate({ expectedRevision: data.revision, values: draft })
  }

  function discardChanges() {
    if (data) setDraft(Object.fromEntries(data.settings.map(setting => [setting.key, setting.value])))
  }

  function resetScope(scope: SettingScope) {
    setDraft(current => {
      const next = { ...current }
      for (const setting of data?.settings ?? []) {
        if (setting.scope === scope) next[setting.key] = setting.defaultValue
      }
      return next
    })
  }

  function updateProviderOverride(platform: string, key: keyof ProviderSettingsOverrides, value: string) {
    setProviderDrafts(current => {
      const next = { ...current[platform] }
      if (value === '') delete next[key]
      else if (key === 'timeoutMs') next[key] = Number(value)
      else if (key === 'baseUrl') next[key] = value
      return { ...current, [platform]: next }
    })
  }

  function updateModelOverride(platform: string, modelId: string, key: keyof ModelSettingsOverrides, value: string) {
    const identity = `${platform}:${modelId}`
    setModelDrafts(current => {
      const next = { ...current[identity] }
      if (value === '') delete next[key]
      else if (key === 'timeoutMs') next[key] = Number(value)
      else if (key === 'alias') next[key] = value
      return { ...current, [identity]: next }
    })
  }

  return {
    data,
    isLoading,
    isError,
    providerSettings,
    providerDrafts,
    modelDrafts,
    grouped,
    hasChanges,
    save,
    saveProviderOverride,
    saveModelOverride,
    updateValue,
    saveChanges,
    discardChanges,
    resetScope,
    updateProviderOverride,
    updateModelOverride,
  }
}
