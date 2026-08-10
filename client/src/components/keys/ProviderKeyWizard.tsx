import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select as SelectDropdown, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ApiKey, ProviderAdapterKind, RegistrySnapshot } from '../../../../shared/types'

interface ProviderKeyWizardProps {
  registry?: RegistrySnapshot
  keys: ApiKey[]
}

export function ProviderKeyWizard({ registry, keys }: ProviderKeyWizardProps) {
  const queryClient = useQueryClient()
  type WizardStep = 1 | 2 | 3 | 4
  const [wizard, setWizard] = useState<{ step: WizardStep; newProvider: boolean }>({ step: 1, newProvider: false })
  const [addedKeyId, setAddedKeyId] = useState<number | null>(null)
  const [form, setForm] = useState<{
    platform: string
    apiKey: string
    label: string
    displayName: string
    endpoint: string
    adapter: ProviderAdapterKind
    authScheme: 'bearer' | 'account-and-token'
  }>({
    platform: '',
    apiKey: '',
    label: '',
    displayName: '',
    endpoint: '',
    adapter: 'openai-compatible',
    authScheme: 'bearer',
  })
  const updateForm = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }))

  const wizardStep = wizard.step
  const isNewProvider = wizard.newProvider
  const setWizardStep = (step: WizardStep) => setWizard(current => ({ ...current, step }))
  const setCreatingNewProvider = (newProvider: boolean) => setWizard(current => ({ ...current, newProvider }))
  const healthStep = isNewProvider ? 4 : 3
  const stepLabels = isNewProvider
    ? [['1', 'Provider'], ['2', 'Endpoint & auth'], ['3', 'Credential'], ['4', 'Health check']]
    : [['1', 'Provider'], ['2', 'Credential'], ['3', 'Health check']]

  const createDraft = useMutation({
    mutationFn: () => apiFetch<{ platform: string }>('/api/registry/providers', {
      method: 'POST',
      body: JSON.stringify({
        platform: form.platform,
        displayName: form.displayName,
        adapter: form.adapter,
        endpoint: form.endpoint,
        authScheme: form.authScheme,
        capabilities: { streaming: true, tools: false, reasoning: false, multimodal: false, maxContextWindow: 131072 },
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registry'] })
      setWizardStep(3)
    },
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch<{ id: number }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['registry'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setForm(current => ({ ...current, apiKey: '' }))
      setWizardStep(isNewProvider ? 4 : 3)
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const providerOptions = (registry?.providers ?? []).map(provider => ({
    value: provider.platform,
    label: provider.displayName,
    lifecycle: provider.lifecycle,
  }))
  const platformsWithKeys = new Set(keys.map(key => key.platform))
  const configuredPlatforms = providerOptions.filter(provider => platformsWithKeys.has(provider.value))
  const newPlatforms = providerOptions.filter(provider => (provider.lifecycle === 'active' || provider.lifecycle === 'draft') && !platformsWithKeys.has(provider.value))
  const selectedProvider = registry?.providers.find(provider => provider.platform === form.platform)
  const selectedProviderModels = registry?.models.filter(model => model.platform === form.platform) ?? []

  const resetWizard = () => {
    setWizardStep(1)
    setAddedKeyId(null)
    setCreatingNewProvider(false)
    setForm({ platform: '', apiKey: '', label: '', displayName: '', endpoint: '', adapter: 'openai-compatible', authScheme: 'bearer' })
  }

  const handleProviderContinue = () => {
    if (!form.platform) return
    if (isNewProvider && form.platform === '__new__') {
      setWizardStep(2)
      return
    }
    if (!isNewProvider) {
      setWizardStep(2)
      return
    }
    if (!form.displayName || !form.endpoint) return
    createDraft.mutate()
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!form.platform || !form.apiKey) return
    addKey.mutate({ platform: form.platform, key: form.apiKey, label: form.label || undefined }, {
      onSuccess: result => setAddedKeyId(result.id),
    })
  }

  return (
    <div className="rounded-lg border p-4 bg-card space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-label="Provider setup progress">
        {stepLabels.map(([step, label], index) => {
          const active = Number(step) === wizardStep
          const complete = Number(step) < wizardStep
          return (
            <div key={step} className="flex items-center gap-2">
              {index > 0 && <span className="text-border">/</span>}
              <span className={`inline-flex size-5 items-center justify-center rounded-full border text-[11px] ${active ? 'border-foreground text-foreground' : complete ? 'border-emerald-500 text-emerald-600' : 'border-border'}`}>
                {step}
              </span>
              <span className={active ? 'text-foreground' : ''}>{label}</span>
            </div>
          )
        })}
      </div>

      {wizardStep === 1 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Provider</Label>
            <SelectDropdown value={form.platform} onValueChange={value => { const next = value ?? ''; setCreatingNewProvider(next === '__new__'); updateForm({ platform: next }) }}>
              <SelectTrigger className="w-full max-w-[320px]"><SelectValue placeholder="Select provider" /></SelectTrigger>
              <SelectContent>
                {configuredPlatforms.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Already configured</SelectLabel>
                    {configuredPlatforms.map(provider => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}
                  </SelectGroup>
                )}
                {configuredPlatforms.length > 0 && newPlatforms.length > 0 && <SelectSeparator />}
                {newPlatforms.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Add new</SelectLabel>
                    {newPlatforms.map(provider => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}
                  </SelectGroup>
                )}
                <SelectGroup>
                  <SelectSeparator />
                  <SelectItem value="__new__">Define a new provider…</SelectItem>
                </SelectGroup>
              </SelectContent>
            </SelectDropdown>
          </div>
          {selectedProvider && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
              <p className="font-medium">{selectedProvider.displayName}</p>
              <p className="text-muted-foreground">Adapter: <code>{selectedProvider.adapter}</code> · Auth: <code>{selectedProvider.authScheme}</code></p>
              <p className="text-muted-foreground">{selectedProvider.credentialCount} credential{selectedProvider.credentialCount === 1 ? '' : 's'} stored · {selectedProviderModels.length} model{selectedProviderModels.length === 1 ? '' : 's'} registered</p>
            </div>
          )}
          <div className="flex justify-end"><Button type="button" size="sm" onClick={handleProviderContinue} disabled={!form.platform || createDraft.isPending}>{createDraft.isPending ? 'Saving draft…' : 'Continue'}</Button></div>
          {createDraft.isError && <p className="text-destructive text-xs">{(createDraft.error as Error).message}</p>}
        </div>
      )}

      {wizardStep === 2 && isNewProvider && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Provider name</Label>
              <Input value={form.displayName} onChange={event => updateForm({ displayName: event.target.value })} placeholder="My OpenAI-compatible provider" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Stable slug</Label>
              <Input value={form.platform === '__new__' ? '' : form.platform} onChange={event => updateForm({ platform: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="my-provider" className="font-mono text-xs" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">HTTPS endpoint</Label>
            <Input value={form.endpoint} onChange={event => updateForm({ endpoint: event.target.value })} placeholder="https://api.example.com/v1" className="font-mono text-xs" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Adapter</Label>
              <SelectDropdown value={form.adapter} onValueChange={value => updateForm({ adapter: (value ?? 'openai-compatible') as ProviderAdapterKind })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="openai-compatible">OpenAI-compatible</SelectItem><SelectItem value="google-gemini">Google Gemini</SelectItem><SelectItem value="cohere">Cohere</SelectItem><SelectItem value="cloudflare-workers-ai">Cloudflare Workers AI</SelectItem></SelectContent>
              </SelectDropdown>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Authentication</Label>
              <SelectDropdown value={form.authScheme} onValueChange={value => updateForm({ authScheme: (value ?? 'bearer') as typeof form.authScheme })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="bearer">Bearer token</SelectItem><SelectItem value="account-and-token">Account + token</SelectItem></SelectContent>
              </SelectDropdown>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">The draft is saved locally and remains inactive until its adapter and required verification checks are available.</p>
          <div className="flex justify-between"><Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(1)}>Back</Button><Button type="button" size="sm" onClick={() => { if (isNewProvider && form.platform !== '__new__' && form.displayName && form.endpoint) createDraft.mutate() }} disabled={!isNewProvider || form.platform === '__new__' || !form.displayName || !form.endpoint || createDraft.isPending}>{createDraft.isPending ? 'Saving draft…' : 'Save provider draft'}</Button></div>
        </div>
      )}

      {((wizardStep === 2 && !isNewProvider) || (wizardStep === 3 && isNewProvider)) && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">API key for {selectedProvider?.displayName ?? form.platform}</Label>
            <Input type="password" value={form.apiKey} onChange={event => updateForm({ apiKey: event.target.value })} placeholder="paste key here" className="font-mono text-xs" autoComplete="new-password" autoFocus />
            <p className="text-[11px] text-muted-foreground">The value is sent once to the local control API and stored in the encrypted vault. It is never shown again.</p>
          </div>
          <div className="space-y-1.5 max-w-[320px]">
            <Label className="text-xs">Label (optional)</Label>
            <Input value={form.label} onChange={event => updateForm({ label: event.target.value })} placeholder="e.g. personal" />
          </div>
          <div className="flex justify-between">
            <Button type="button" variant="outline" size="sm" onClick={() => setWizardStep(1)}>Back</Button>
            <Button type="submit" size="sm" disabled={!form.apiKey || addKey.isPending}>{addKey.isPending ? 'Saving securely…' : 'Save credential'}</Button>
          </div>
        </form>
      )}

      {wizardStep === healthStep && (
        <div className="space-y-4">
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">Credential saved for <span className="font-medium">{selectedProvider?.displayName ?? form.displayName ?? form.platform}</span>. The secret is now masked and cannot be recovered from the UI.</div>
          <p className="text-xs text-muted-foreground">Run an optional health check now. The key follows the existing enabled/disabled routing policy until you change it.</p>
          {checkKey.isError && <p className="text-destructive text-xs">{(checkKey.error as Error).message}</p>}
          <div className="flex justify-between">
            <Button type="button" variant="outline" size="sm" onClick={resetWizard}>Add another</Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={resetWizard}>Done</Button>
              <Button type="button" size="sm" onClick={() => addedKeyId && checkKey.mutate(addedKeyId)} disabled={!addedKeyId || checkKey.isPending}>{checkKey.isPending ? 'Checking…' : 'Check now'}</Button>
            </div>
          </div>
        </div>
      )}
      {addKey.isError && <p className="text-destructive text-xs">{(addKey.error as Error).message}</p>}
    </div>
  )
}
