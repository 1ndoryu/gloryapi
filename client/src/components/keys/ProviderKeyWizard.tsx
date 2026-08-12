import { useMemo, useReducer } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select as SelectDropdown, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ApiKey, CapabilityProfile, ProviderAdapterKind, RegistrySnapshot } from '../../../../shared/types'

interface ProviderKeyWizardProps {
  registry?: RegistrySnapshot
  keys: ApiKey[]
}

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7
type VerificationCheck = 'health' | 'capabilities' | 'chat'
type DiscoveredModel = {
  modelId: string
  displayName: string
  contextWindow: number | null
  capabilities: CapabilityProfile
  capabilityEvidence?: Record<string, string>
}
type DiscoveryResponse = { models: DiscoveredModel[]; stale: boolean; fetchedAt: string }
type WizardForm = {
  platform: string
  apiKey: string
  label: string
  displayName: string
  endpoint: string
  adapter: ProviderAdapterKind
  authScheme: 'bearer' | 'account-and-token'
}

const initialForm: WizardForm = {
  platform: '', apiKey: '', label: '', displayName: '', endpoint: '', adapter: 'openai-compatible', authScheme: 'bearer',
}

type WizardState = {
  wizard: { step: WizardStep; newProvider: boolean }
  addedKeyId: number | null
  form: WizardForm
  discovery: DiscoveryResponse | null
  selectedModelIds: string[]
  manualModel: DiscoveredModel | null
  verification: Set<VerificationCheck>
  activationComplete: boolean
}

type WizardAction =
  | { type: 'setStep'; step: WizardStep }
  | { type: 'setNewProvider'; newProvider: boolean }
  | { type: 'updateForm'; patch: Partial<WizardForm> }
  | { type: 'setAddedKeyId'; value: number | null }
  | { type: 'setDiscovery'; value: DiscoveryResponse | null }
  | { type: 'setSelectedModelIds'; value: string[] }
  | { type: 'setManualModel'; value: DiscoveredModel | null }
  | { type: 'verify'; check: VerificationCheck }
  | { type: 'setActivationComplete'; value: boolean }
  | { type: 'reset' }

const initialWizardState: WizardState = {
  wizard: { step: 1, newProvider: false },
  addedKeyId: null,
  form: initialForm,
  discovery: null,
  selectedModelIds: [],
  manualModel: null,
  verification: new Set(),
  activationComplete: false,
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'setStep': return { ...state, wizard: { ...state.wizard, step: action.step } }
    case 'setNewProvider': return { ...state, wizard: { ...state.wizard, newProvider: action.newProvider } }
    case 'updateForm': return { ...state, form: { ...state.form, ...action.patch } }
    case 'setAddedKeyId': return { ...state, addedKeyId: action.value }
    case 'setDiscovery': return { ...state, discovery: action.value }
    case 'setSelectedModelIds': return { ...state, selectedModelIds: action.value }
    case 'setManualModel': return { ...state, manualModel: action.value }
    case 'verify': return { ...state, verification: new Set(state.verification).add(action.check) }
    case 'setActivationComplete': return { ...state, activationComplete: action.value }
    case 'reset': return initialWizardState
  }
}

function capabilitySummary(model: DiscoveredModel): string {
  const labels: Record<string, string> = {
    streaming: 'streaming',
    tools: 'herramientas',
    reasoning: 'razonamiento',
    multimodal: 'multimodal',
  }
  const enabled = Object.entries(model.capabilities)
    .filter(([key, value]) => key !== 'maxContextWindow' && value === true)
    .map(([key]) => labels[key] ?? key)
  return enabled.length ? enabled.join(', ') : 'capacidades sin verificar'
}

export function ProviderKeyWizard({ registry, keys }: ProviderKeyWizardProps) {
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState)
  const { wizard, addedKeyId, form, discovery, selectedModelIds, manualModel, verification, activationComplete } = state

  const wizardStep = wizard.step
  const isNewProvider = wizard.newProvider
  const setWizardStep = (step: WizardStep) => dispatch({ type: 'setStep', step })
  const updateForm = (patch: Partial<WizardForm>) => dispatch({ type: 'updateForm', patch })
  const setCreatingNewProvider = (newProvider: boolean) => dispatch({ type: 'setNewProvider', newProvider })

  const providerOptions = (registry?.providers ?? []).map(provider => ({ value: provider.platform, label: provider.displayName, lifecycle: provider.lifecycle }))
  const platformsWithKeys = new Set(keys.map(key => key.platform))
  const configuredPlatforms = providerOptions.filter(provider => platformsWithKeys.has(provider.value))
  const newPlatforms = providerOptions.filter(provider => (provider.lifecycle === 'active' || provider.lifecycle === 'draft') && !platformsWithKeys.has(provider.value))
  const selectedProvider = registry?.providers.find(provider => provider.platform === form.platform)
  const selectedProviderModels = registry?.models.filter(model => model.platform === form.platform) ?? []
  const availableModels = useMemo(() => {
    const discovered = discovery?.models ?? []
    return manualModel && !discovered.some(model => model.modelId === manualModel.modelId) ? [...discovered, manualModel] : discovered
  }, [discovery, manualModel])
  const selectedModels = availableModels.filter(model => selectedModelIds.includes(model.modelId))
  const allVerified = verification.has('health') && verification.has('capabilities') && verification.has('chat')

  const createDraft = useMutation({
    mutationFn: () => apiFetch<{ platform: string }>('/api/registry/providers', {
      method: 'POST',
      body: JSON.stringify({ platform: form.platform, displayName: form.displayName, adapter: form.adapter, endpoint: form.endpoint, authScheme: form.authScheme, capabilities: { streaming: true, tools: false, reasoning: false, multimodal: false, maxContextWindow: 131072 } }),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['registry'] }); setWizardStep(3) },
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) => apiFetch<{ id: number }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: result => {
      dispatch({ type: 'setAddedKeyId', value: result.id })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['registry'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      updateForm({ apiKey: '' })
      setWizardStep(isNewProvider ? 4 : 3)
    },
  })

  const discover = useMutation({
    mutationFn: () => apiFetch<DiscoveryResponse>(`/api/registry/providers/${encodeURIComponent(form.platform)}/models/discover?keyId=${addedKeyId}`),
    onSuccess: result => {
      dispatch({ type: 'setDiscovery', value: result })
      dispatch({ type: 'setSelectedModelIds', value: result.models.length ? [result.models[0].modelId] : [] })
    },
  })

  const selectModels = useMutation({
    mutationFn: () => apiFetch(`/api/registry/providers/${encodeURIComponent(form.platform)}/models/select`, { method: 'POST', body: JSON.stringify({ models: selectedModels }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['registry'] }); setWizardStep(6) },
  })

  const verify = useMutation({
    mutationFn: (check: VerificationCheck) => apiFetch(`/api/registry/providers/${encodeURIComponent(form.platform)}/verify`, { method: 'POST', body: JSON.stringify({ check, keyId: check === 'capabilities' ? undefined : addedKeyId, modelId: check === 'chat' ? selectedModels[0]?.modelId : undefined }) }),
    onSuccess: (_result, check) => { dispatch({ type: 'verify', check }); queryClient.invalidateQueries({ queryKey: ['registry'] }); queryClient.invalidateQueries({ queryKey: ['health'] }) },
  })

  const activate = useMutation({
    mutationFn: () => apiFetch(`/api/registry/providers/${encodeURIComponent(form.platform)}/activate`, { method: 'POST' }),
    onSuccess: () => { dispatch({ type: 'setActivationComplete', value: true }); queryClient.invalidateQueries({ queryKey: ['registry'] }); queryClient.invalidateQueries({ queryKey: ['keys'] }) },
  })

  const checkExistingKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['health'] }); queryClient.invalidateQueries({ queryKey: ['keys'] }) },
  })

  const resetWizard = () => {
    dispatch({ type: 'reset' })
  }

  const handleProviderContinue = () => {
    if (!form.platform) return
    if (isNewProvider && form.platform === '__new__') { setWizardStep(2); return }
    if (!isNewProvider) { setWizardStep(2); return }
    if (form.displayName && form.endpoint) createDraft.mutate()
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (form.platform && form.apiKey) addKey.mutate({ platform: form.platform, key: form.apiKey, label: form.label || undefined })
  }

  const stepLabels = isNewProvider
    ? [['1', 'Proveedor'], ['2', 'Ruta y autenticación'], ['3', 'Credencial'], ['4', 'Descubrir'], ['5', 'Revisar modelos'], ['6', 'Verificar'], ['7', 'Activar']]
    : [['1', 'Proveedor'], ['2', 'Credencial'], ['3', 'Comprobar salud']]

  return (
    <div className="rounded-lg border p-4 bg-card space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap" aria-label="Progreso de configuración del proveedor">
        {stepLabels.map(([step, label], index) => {
          const active = Number(step) === wizardStep
          const complete = Number(step) < wizardStep
          return <div key={step} className="flex items-center gap-2">{index > 0 && <span className="text-border">/</span>}<span className={`inline-flex size-5 items-center justify-center rounded-full border text-[11px] ${active ? 'border-foreground text-foreground' : complete ? 'border-emerald-500 text-emerald-600' : 'border-border'}`}>{complete ? '✓' : step}</span><span className={active ? 'text-foreground' : ''}>{label}</span></div>
        })}
      </div>

      {wizardStep === 1 && (
        <div className="space-y-4">
          <div className="space-y-1.5"><Label className="text-xs">Proveedor</Label><SelectDropdown value={form.platform} onValueChange={value => { const next = value ?? ''; setCreatingNewProvider(next === '__new__'); updateForm({ platform: next }) }}><SelectTrigger className="w-full max-w-[320px]"><SelectValue placeholder="Selecciona un proveedor" /></SelectTrigger><SelectContent>
            {configuredPlatforms.length > 0 && <SelectGroup><SelectLabel>Ya configurados</SelectLabel>{configuredPlatforms.map(provider => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}</SelectGroup>}
            {configuredPlatforms.length > 0 && newPlatforms.length > 0 && <SelectSeparator />}
            {newPlatforms.length > 0 && <SelectGroup><SelectLabel>Añadir nuevo</SelectLabel>{newPlatforms.map(provider => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}</SelectGroup>}
            <SelectGroup><SelectSeparator /><SelectItem value="__new__">Definir un proveedor nuevo…</SelectItem></SelectGroup>
          </SelectContent></SelectDropdown></div>
          {selectedProvider && <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1"><p className="font-medium">{selectedProvider.displayName}</p><p className="text-muted-foreground">Adaptador: <code>{selectedProvider.adapter}</code> · Autenticación: <code>{selectedProvider.authScheme}</code></p><p className="text-muted-foreground">{selectedProvider.credentialCount} credencial{selectedProvider.credentialCount === 1 ? '' : 'es'} guardada{selectedProvider.credentialCount === 1 ? '' : 's'} · {selectedProviderModels.length} modelo{selectedProviderModels.length === 1 ? '' : 's'} registrado{selectedProviderModels.length === 1 ? '' : 's'}</p></div>}
          <div className="flex justify-end"><Button type="button" size="sm" onClick={handleProviderContinue} disabled={!form.platform || createDraft.isPending}>{createDraft.isPending ? 'Guardando borrador…' : 'Continuar'}</Button></div>
          {createDraft.isError && <p className="text-destructive text-xs">{(createDraft.error as Error).message}</p>}
        </div>
      )}

      {wizardStep === 2 && isNewProvider && <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label className="text-xs">Nombre del proveedor</Label><Input value={form.displayName} onChange={event => updateForm({ displayName: event.target.value })} placeholder="Mi proveedor compatible con OpenAI" autoFocus /></div><div className="space-y-1.5"><Label className="text-xs">Identificador estable</Label><Input value={form.platform === '__new__' ? '' : form.platform} onChange={event => updateForm({ platform: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="mi-proveedor" className="font-mono text-xs" /></div></div><div className="space-y-1.5"><Label className="text-xs">URL de API HTTPS</Label><Input value={form.endpoint} onChange={event => updateForm({ endpoint: event.target.value })} placeholder="https://api.example.com/v1" className="font-mono text-xs" /></div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label className="text-xs">Adaptador</Label><SelectDropdown value={form.adapter} onValueChange={value => updateForm({ adapter: (value ?? 'openai-compatible') as ProviderAdapterKind })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai-compatible">Compatible con OpenAI</SelectItem><SelectItem value="google-gemini">Google Gemini</SelectItem><SelectItem value="cohere">Cohere</SelectItem><SelectItem value="cloudflare-workers-ai">Cloudflare Workers AI</SelectItem></SelectContent></SelectDropdown></div><div className="space-y-1.5"><Label className="text-xs">Autenticación</Label><SelectDropdown value={form.authScheme} onValueChange={value => updateForm({ authScheme: (value ?? 'bearer') as WizardForm['authScheme'] })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bearer">Token Bearer</SelectItem><SelectItem value="account-and-token">Cuenta + token</SelectItem></SelectContent></SelectDropdown></div></div><p className="text-[11px] text-muted-foreground">El borrador permanece inactivo hasta que su adaptador y las comprobaciones requeridas sean aprobados.</p><div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(1)}>Atrás</Button><Button type="button" size="sm" onClick={() => form.platform !== '__new__' && form.displayName && form.endpoint && createDraft.mutate()} disabled={form.platform === '__new__' || !form.displayName || !form.endpoint || createDraft.isPending}>{createDraft.isPending ? 'Guardando borrador…' : 'Guardar borrador del proveedor'}</Button></div></div>}

      {((wizardStep === 2 && !isNewProvider) || (wizardStep === 3 && isNewProvider)) && <form onSubmit={handleSubmit} className="space-y-4"><div className="space-y-1.5"><Label className="text-xs">Clave API para {selectedProvider?.displayName ?? form.platform}</Label><Input type="password" value={form.apiKey} onChange={event => updateForm({ apiKey: event.target.value })} placeholder="pega aquí la clave" className="font-mono text-xs" autoComplete="new-password" autoFocus /><p className="text-[11px] text-muted-foreground">Se envía una sola vez a la API de control local y se guarda en la bóveda cifrada. No volverá a mostrarse.</p></div><div className="space-y-1.5 max-w-[320px]"><Label className="text-xs">Etiqueta (opcional)</Label><Input value={form.label} onChange={event => updateForm({ label: event.target.value })} placeholder="por ejemplo, personal" /></div><div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(1)}>Atrás</Button><Button type="submit" size="sm" disabled={!form.apiKey || addKey.isPending}>{addKey.isPending ? 'Guardando de forma segura…' : 'Guardar credencial'}</Button></div></form>}

      {wizardStep === 3 && !isNewProvider && <div className="space-y-4"><div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">Credencial guardada para <span className="font-medium">{selectedProvider?.displayName ?? form.platform}</span>. El secreto está oculto y no se puede recuperar desde la interfaz.</div><p className="text-xs text-muted-foreground">Puedes ejecutar ahora una comprobación de salud opcional.</p>{checkExistingKey.isError && <p className="text-destructive text-xs">{(checkExistingKey.error as Error).message}</p>}<div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={resetWizard}>Añadir otra</Button><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={resetWizard}>Listo</Button><Button type="button" size="sm" onClick={() => addedKeyId && checkExistingKey.mutate(addedKeyId)} disabled={!addedKeyId || checkExistingKey.isPending}>{checkExistingKey.isPending ? 'Comprobando…' : 'Comprobar ahora'}</Button></div></div></div>}

      {wizardStep === 4 && isNewProvider && <div className="space-y-4"><div><p className="text-sm font-medium">Descubrir o registrar modelos</p><p className="text-xs text-muted-foreground">El descubrimiento está limitado y solo produce borradores. Nada se activa automáticamente.</p></div><div className="flex gap-2"><Button type="button" size="sm" onClick={() => discover.mutate()} disabled={!addedKeyId || discover.isPending}>{discover.isPending ? 'Descubriendo…' : 'Descubrir /models'}</Button><Input value={manualModel?.modelId ?? ''} onChange={event => { const modelId = event.target.value.trim(); const previousModelId = manualModel?.modelId; dispatch({ type: 'setManualModel', value: modelId ? { modelId, displayName: modelId, contextWindow: null, capabilities: { streaming: true, tools: false, reasoning: false, multimodal: false, maxContextWindow: null } } : null }); dispatch({ type: 'setSelectedModelIds', value: modelId ? [...new Set([...selectedModelIds, modelId])] : selectedModelIds.filter(id => id !== previousModelId) }) }} placeholder="o introduce un ID de modelo" className="font-mono text-xs" /></div>{discovery?.stale && <p className="text-xs text-amber-600">Mostrando un descubrimiento antiguo de {discovery.fetchedAt}; revísalo antes de seleccionar.</p>}{availableModels.length > 0 && <div className="space-y-2">{availableModels.map(model => <label key={model.modelId} className="flex items-start gap-3 rounded border p-3 text-xs"><input type="checkbox" checked={selectedModelIds.includes(model.modelId)} onChange={event => dispatch({ type: 'setSelectedModelIds', value: event.target.checked ? [...new Set([...selectedModelIds, model.modelId])] : selectedModelIds.filter(id => id !== model.modelId) })} /><span><span className="font-medium">{model.displayName}</span> <code className="text-muted-foreground">{model.modelId}</code><span className="block text-muted-foreground mt-1">{capabilitySummary(model)}</span></span></label>)}</div>}{discover.isError && <p className="text-destructive text-xs">{(discover.error as Error).message}</p>}<div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(3)}>Atrás</Button><Button type="button" size="sm" onClick={() => setWizardStep(5)} disabled={!selectedModelIds.length}>Revisar modelos seleccionados</Button></div></div>}

      {wizardStep === 5 && isNewProvider && <div className="space-y-4"><div><p className="text-sm font-medium">Revisar antes de guardar los borradores</p><p className="text-xs text-muted-foreground">{selectedModels.length} modelo{selectedModels.length === 1 ? '' : 's'} seleccionado{selectedModels.length === 1 ? '' : 's'} explícitamente para {form.displayName || form.platform}.</p></div><div className="rounded border divide-y">{selectedModels.map(model => <div key={model.modelId} className="p-3 text-xs"><div className="font-medium">{model.displayName}</div><code className="text-muted-foreground">{model.modelId}</code><div className="text-muted-foreground mt-1">{capabilitySummary(model)} · contexto {model.contextWindow ?? 'desconocido'}</div></div>)}</div>{selectModels.isError && <p className="text-destructive text-xs">{(selectModels.error as Error).message}</p>}<div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(4)}>Atrás</Button><Button type="button" size="sm" onClick={() => selectModels.mutate()} disabled={!selectedModels.length || selectModels.isPending}>{selectModels.isPending ? 'Guardando borradores…' : 'Guardar y verificar'}</Button></div></div>}

      {wizardStep === 6 && isNewProvider && <div className="space-y-4"><div><p className="text-sm font-medium">Verificar el proveedor</p><p className="text-xs text-muted-foreground">La activación requiere comprobaciones de salud, capacidades y chat. Para el ping de chat se usa el primer modelo seleccionado.</p></div><div className="grid gap-2 sm:grid-cols-3">{(['health', 'capabilities', 'chat'] as VerificationCheck[]).map(check => { const labels: Record<VerificationCheck, string> = { health: 'salud', capabilities: 'capacidades', chat: 'chat' }; return <Button key={check} type="button" variant={verification.has(check) ? 'outline' : 'default'} onClick={() => verify.mutate(check)} disabled={verify.isPending || (check !== 'capabilities' && !addedKeyId) || (check === 'chat' && !selectedModels[0])}>{verification.has(check) ? `✓ ${labels[check]}` : `Ejecutar ${labels[check]}`}</Button> })}</div>{verify.isError && <p className="text-destructive text-xs">{(verify.error as Error).message}</p>}<div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(5)}>Atrás</Button><Button type="button" size="sm" onClick={() => setWizardStep(7)} disabled={!allVerified}>Revisar activación</Button></div></div>}

      {wizardStep === 7 && isNewProvider && <div className="space-y-4"><div className="rounded-md border p-3 text-sm"><p className="font-medium">Listo para activar {form.displayName || form.platform}</p><p className="text-xs text-muted-foreground mt-1">{selectedModels.length} borrador{selectedModels.length === 1 ? '' : 'es'} de modelo y las tres comprobaciones de verificación superadas. La activación sigue siendo una transacción explícita independiente.</p></div>{activate.isError && <p className="text-destructive text-xs">{(activate.error as Error).message}</p>}{activationComplete && <p className="text-emerald-600 text-sm">Proveedor activado. Ahora es visible en el registro canónico.</p>}<div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={resetWizard}>{activationComplete ? 'Añadir otro' : 'Cancelar'}</Button>{!activationComplete && <Button type="button" size="sm" onClick={() => activate.mutate()} disabled={activate.isPending}>{activate.isPending ? 'Activando…' : 'Activar proveedor'}</Button>}</div></div>}

      {addKey.isError && <p className="text-destructive text-xs">{(addKey.error as Error).message}</p>}
    </div>
  )
}
