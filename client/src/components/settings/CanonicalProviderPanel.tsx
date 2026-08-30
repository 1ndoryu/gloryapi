import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select as SelectDropdown, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ConfigurationFieldDefinition, ConfigurationProvider, ConfigurationSnapshot } from '@/hooks/useFallbackPage.types'

type ProviderDraft = Omit<ConfigurationProvider, 'capabilities' | 'transport' | 'failurePolicy'> & {
  capabilities: ConfigurationProvider['capabilities']
  transport: ConfigurationProvider['transport']
  failurePolicy: ConfigurationProvider['failurePolicy']
}

function updateDraftValue(draft: ProviderDraft, key: string, value: unknown): ProviderDraft {
  if (key in draft && !['capabilities', 'transport', 'failurePolicy'].includes(key)) return { ...draft, [key]: value } as ProviderDraft
  if (key in draft.capabilities) return { ...draft, capabilities: { ...draft.capabilities, [key]: value } as ProviderDraft['capabilities'] }
  if (key in draft.transport) return { ...draft, transport: { ...draft.transport, [key]: value } as ProviderDraft['transport'] }
  if (key in draft.failurePolicy) return { ...draft, failurePolicy: { ...draft.failurePolicy, [key]: value } as ProviderDraft['failurePolicy'] }
  return draft
}

function fieldValue(draft: ProviderDraft, key: string): unknown {
  if (key in draft && !['capabilities', 'transport', 'failurePolicy'].includes(key)) return draft[key as keyof ProviderDraft]
  if (key in draft.capabilities) return draft.capabilities[key as keyof ProviderDraft['capabilities']]
  if (key in draft.transport) return draft.transport[key as keyof ProviderDraft['transport']]
  if (key in draft.failurePolicy) return draft.failurePolicy[key as keyof ProviderDraft['failurePolicy']]
  return undefined
}

/* [por que] El componente solo debe renderizar; la lógica de carga, borradores y guardado
 * (estado + efectos + mutación) vive en un hook dedicado para que el panel quede plano. */
function useCanonicalProviderPanel() {
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery<ConfigurationSnapshot>({ queryKey: ['configuration'], queryFn: () => apiFetch('/api/configuration') })
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({})
  useEffect(() => {
    if (data) setDrafts(Object.fromEntries(data.providers.map(provider => [provider.platform, structuredClone(provider)])))
  }, [data])
  const mutation = useMutation({
    mutationFn: (input: { platform: string; draft: ProviderDraft; revision: number }) => apiFetch<ConfigurationSnapshot>(`/api/configuration/providers/${encodeURIComponent(input.platform)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...input.draft, expectedRevision: input.revision, capabilities: input.draft.capabilities, transport: input.draft.transport, failurePolicy: input.draft.failurePolicy }),
    }),
    onSuccess: snapshot => {
      queryClient.setQueryData(['configuration'], snapshot)
      setDrafts(Object.fromEntries(snapshot.providers.map(provider => [provider.platform, structuredClone(provider)])))
    },
  })
  return { data, isLoading, isError, drafts, setDrafts, mutation }
}

export function CanonicalProviderPanel() {
  const { data, isLoading, isError, drafts, setDrafts, mutation } = useCanonicalProviderPanel()

  if (isLoading) return <p className="text-sm text-muted-foreground">Cargando registro central de proveedores…</p>
  if (isError || !data) return <p className="text-sm text-destructive">No se pudo cargar el registro central de proveedores.</p>
  const fields = data.schema.fields.filter(field => field.scope === 'provider')

  return <section className="space-y-4" aria-labelledby="registro-central-proveedores">
    <div><h2 id="registro-central-proveedores" className="text-sm font-medium">Registro central de proveedores</h2><p className="mt-1 text-xs text-muted-foreground">Estos valores son la fuente única que usa el enrutador, el adaptador OpenAI-compatible y el catálogo del bridge. No contiene credenciales.</p></div>
    {data.providers.map(provider => {
      const draft = drafts[provider.platform] ?? provider
      return <div key={provider.platform} className="rounded-lg border bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium">{provider.displayName}</h3><p className="text-xs font-mono text-muted-foreground">{provider.platform} · {provider.adapter}</p></div><Button size="xs" onClick={() => mutation.mutate({ platform: provider.platform, draft, revision: data.revision })} disabled={mutation.isPending}>{mutation.isPending ? 'Guardando…' : 'Guardar proveedor'}</Button></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((field: ConfigurationFieldDefinition) => {
            const value = fieldValue(draft, field.key)
            if (field.type === 'boolean') return <label key={field.key} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={Boolean(value)} onChange={event => setDrafts(current => ({ ...current, [provider.platform]: updateDraftValue(draft, field.key, event.target.checked) }))} /><span><span className="block">{field.label}</span><span className="block text-xs text-muted-foreground">{field.description}</span></span></label>
            if (field.type === 'enum') return <div key={field.key} className="space-y-1.5"><Label htmlFor={`${provider.platform}-${field.key}`}>{field.label}</Label><SelectDropdown value={String(value ?? '')} onValueChange={next => setDrafts(current => ({ ...current, [provider.platform]: updateDraftValue(draft, field.key, next) }))}><SelectTrigger id={`${provider.platform}-${field.key}`} className="w-full" size="sm"><SelectValue placeholder="Seleccionar…" /></SelectTrigger><SelectContent>{(field.options ?? []).map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></SelectDropdown><p className="text-xs text-muted-foreground">{field.description}</p></div>
            if (field.type === 'json-map') return <div key={field.key} className="space-y-1.5 sm:col-span-2"><Label htmlFor={`${provider.platform}-${field.key}`}>{field.label}</Label><textarea id={`${provider.platform}-${field.key}`} className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2 py-1.5 font-mono text-xs" value={value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '{}')} onChange={event => { let next: unknown = event.target.value; try { next = JSON.parse(event.target.value) } catch { /* La API devuelve el error de JSON al guardar; no se descarta el borrador local. */ } setDrafts(current => ({ ...current, [provider.platform]: updateDraftValue(draft, field.key, next) })) }} /><p className="text-xs text-muted-foreground">{field.description}</p></div>
            const numeric = field.type === 'integer' || field.type === 'duration-ms'
            return <div key={field.key} className="space-y-1.5"><Label htmlFor={`${provider.platform}-${field.key}`}>{field.label}</Label><Input id={`${provider.platform}-${field.key}`} type={numeric ? 'number' : 'text'} min={field.min} max={field.max} value={value == null ? '' : String(value)} onChange={event => { const raw = event.target.value; const next = numeric ? (raw === '' ? null : Number(raw)) : raw; setDrafts(current => ({ ...current, [provider.platform]: updateDraftValue(draft, field.key, next) })) }} /><p className="text-xs text-muted-foreground">{field.description}</p></div>
          })}
        </div>
      </div>
    })}
    {mutation.isError && <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>}
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>Revisión canónica: {data.revision}. Catálogo bridge publicado: revisión {data.bridge.revision}, hash {data.bridge.hash.slice(0, 12)}… Las modificaciones concurrentes se rechazan con CAS.</p>
      <p className={data.bridge.sync.state === 'synced' ? 'text-emerald-600' : data.bridge.sync.state === 'stale' ? 'text-amber-600' : 'text-muted-foreground'}>
        Sincronización local del bridge: {data.bridge.sync.state === 'synced' ? 'al día' : data.bridge.sync.state === 'stale' ? 'desactualizada' : data.bridge.sync.state === 'missing' ? 'sin proyección local' : 'proyección inválida'}.
        {data.bridge.sync.state !== 'synced' && data.bridge.sync.errors[0] ? ` ${data.bridge.sync.errors[0]}.` : ''}
      </p>
    </div>
  </section>
}
