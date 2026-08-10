import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select as SelectDropdown, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform, RegistrySnapshot } from '../../../shared/types'
import { UnifiedKeySection } from '@/components/keys/UnifiedKeySection'

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<{
    platform: Platform | ''
    apiKey: string
    label: string
  }>({ platform: '', apiKey: '', label: '' })
  const updateForm = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }))

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: registry } = useQuery<RegistrySnapshot>({
    queryKey: ['registry'],
    queryFn: () => apiFetch('/api/registry'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['registry'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setForm({ platform: '', apiKey: '', label: '' })
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['registry'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
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
  const platformsWithKeys = new Set(keys.map(k => k.platform))
  const configuredPlatforms = providerOptions.filter(p => platformsWithKeys.has(p.value))
  const newPlatforms = providerOptions.filter(p => p.lifecycle === 'active' && !platformsWithKeys.has(p.value))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.platform || !form.apiKey) return
    addKey.mutate({ platform: form.platform, key: form.apiKey, label: form.label || undefined })
  }

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const grouped = providerOptions.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          keys.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              {checkAll.isPending ? 'Checking…' : 'Check all'}
            </Button>
          )
        }
      />

      <div className="space-y-8">
        <UnifiedKeySection />

        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <SelectDropdown value={form.platform} onValueChange={(v) => updateForm({ platform: v as Platform })}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {configuredPlatforms.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Already configured</SelectLabel>
                      {configuredPlatforms.map(p => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {configuredPlatforms.length > 0 && newPlatforms.length > 0 && (
                    <SelectSeparator />
                  )}
                  {newPlatforms.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Add new</SelectLabel>
                      {newPlatforms.map(p => (
                        <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </SelectDropdown>
            </div>
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">API key</Label>
              <Input
                type="password"
                value={form.apiKey}
                onChange={e => updateForm({ apiKey: e.target.value })}
                placeholder="paste key here"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input
                value={form.label}
                onChange={e => updateForm({ label: e.target.value })}
                placeholder="optional"
                className="w-[160px]"
              />
            </div>
            <Button type="submit" size="sm" disabled={!form.platform || !form.apiKey || addKey.isPending}>
              {addKey.isPending ? 'Adding…' : 'Add key'}
            </Button>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium mb-3">Configured providers</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-sm font-medium">{group.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="rounded-lg border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      return (
                        <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                          <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                            Check
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>
                            Remove
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
