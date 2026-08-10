import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'
import { scopeLabels, settingLabel, useSettingsPage } from '@/hooks/useSettingsPage'

export default function SettingsPage() {
  const {
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
    unifiedKey,
    updateValue,
    saveChanges,
    discardChanges,
    updateProviderOverride,
    updateModelOverride,
  } = useSettingsPage()

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Validated operational controls. Security invariants remain in code."
        actions={
          <div className="flex items-center gap-2">
            {hasChanges && <Button variant="ghost" size="sm" onClick={discardChanges}>Discard</Button>}
            <Button size="sm" onClick={saveChanges} disabled={!hasChanges || save.isPending || !unifiedKey?.apiKey}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading settings…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Settings could not be loaded.</p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([scope, settings]) => (
            <section key={scope}>
              <h2 className="text-sm font-medium mb-3">{scopeLabels[scope]}</h2>
              <div className="rounded-lg border divide-y bg-card">
                {settings.map(setting => {
                  const value = data?.settings.find(item => item.key === setting.key)?.value ?? setting.defaultValue
                  return (
                    <div key={setting.key} className="flex flex-wrap items-center gap-4 px-4 py-3">
                      <div className="min-w-[240px] flex-1">
                        <div className="flex items-center gap-2">
                          <Label htmlFor={setting.key} className="text-sm">{settingLabel(setting.key)}</Label>
                          {setting.requiresRestart && <Badge variant="outline">restart required</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{setting.description}</p>
                        <p className="text-[11px] text-muted-foreground/70 mt-1 font-mono">{setting.key}</p>
                      </div>
                      <div className="w-[180px]">
                        {setting.type === 'boolean' ? (
                          <label className="flex items-center gap-2 text-sm">
                            <input id={setting.key} type="checkbox" checked={Boolean(value)} onChange={event => updateValue(setting, event.target.checked)} />
                            {value ? 'Enabled' : 'Disabled'}
                          </label>
                        ) : (
                          <Input
                            id={setting.key}
                            type={setting.type === 'string' ? 'text' : 'number'}
                            value={String(value)}
                            min={setting.min}
                            max={setting.max}
                            step={setting.type === 'number' ? '0.01' : '1'}
                            onChange={event => updateValue(setting, event.target.value)}
                            className="font-mono text-xs"
                          />
                        )}
                        {typeof setting.min === 'number' && typeof setting.max === 'number' && <p className="text-[11px] text-muted-foreground mt-1">Allowed: {setting.min}–{setting.max}</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          {save.isError && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
          {save.isSuccess && !hasChanges && <p className="text-xs text-muted-foreground">Saved at revision {data?.revision}.</p>}
          <p className="text-xs text-muted-foreground">Configuration revision: {data?.revision ?? 0}</p>
        </div>
      )}

      {providerSettings && (
        <section className="mt-10">
          <div className="mb-3">
            <h2 className="text-sm font-medium">Provider and model overrides</h2>
            <p className="text-xs text-muted-foreground mt-1">Values marked inherited come from the canonical registry. Overrides are validated before persistence.</p>
          </div>
          <div className="space-y-4">
            {providerSettings.providers.map(provider => {
              const providerDraft = providerDrafts[provider.platform] ?? {}
              return (
                <div key={provider.platform} className="rounded-lg border bg-card p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">{provider.platform}</h3>
                      <p className="text-xs text-muted-foreground">Provider settings and inherited capabilities</p>
                    </div>
                    <Button size="xs" onClick={() => saveProviderOverride.mutate({ platform: provider.platform, overrides: providerDraft, revision: providerSettings.revision })} disabled={saveProviderOverride.isPending || !unifiedKey?.apiKey}>Save provider</Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`base-url-${provider.platform}`} className="text-xs">Base URL</Label>
                      <Input id={`base-url-${provider.platform}`} value={providerDraft.baseUrl ?? provider.effective.baseUrl} onChange={event => updateProviderOverride(provider.platform, 'baseUrl', event.target.value)} className="font-mono text-xs" />
                      <p className="text-[11px] text-muted-foreground">{provider.effective.sources.baseUrl === 'default' ? 'Inherited' : 'Provider override'}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`timeout-${provider.platform}`} className="text-xs">Timeout (ms)</Label>
                      <Input id={`timeout-${provider.platform}`} type="number" min={1000} max={120000} step={1000} value={providerDraft.timeoutMs ?? provider.effective.timeoutMs} onChange={event => updateProviderOverride(provider.platform, 'timeoutMs', event.target.value)} className="font-mono text-xs" />
                      <p className="text-[11px] text-muted-foreground">{provider.effective.sources.timeoutMs === 'default' ? 'Inherited' : 'Provider override'}</p>
                    </div>
                  </div>
                  {provider.models.length > 0 && (
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs font-medium">Model overrides</p>
                      {provider.models.map(model => {
                        const identity = `${provider.platform}:${model.modelId}`
                        const modelDraft = modelDrafts[identity] ?? {}
                        return (
                          <div key={identity} className="grid gap-2 sm:grid-cols-[1fr_180px_auto] items-end rounded-md bg-muted/30 p-3">
                            <div className="space-y-1">
                              <Label htmlFor={`alias-${identity}`} className="text-xs">{model.displayName}</Label>
                              <Input id={`alias-${identity}`} value={modelDraft.alias ?? model.effective.alias ?? ''} placeholder="Inherited model ID" onChange={event => updateModelOverride(provider.platform, model.modelId, 'alias', event.target.value)} className="font-mono text-xs" />
                              <p className="text-[11px] text-muted-foreground">Alias: {model.effective.sources.alias}</p>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`model-timeout-${identity}`} className="text-xs">Timeout (ms)</Label>
                              <Input id={`model-timeout-${identity}`} type="number" min={1000} max={120000} step={1000} value={modelDraft.timeoutMs ?? model.effective.timeoutMs} onChange={event => updateModelOverride(provider.platform, model.modelId, 'timeoutMs', event.target.value)} className="font-mono text-xs" />
                              <p className="text-[11px] text-muted-foreground">Timeout: {model.effective.sources.timeoutMs}</p>
                            </div>
                            <Button size="xs" variant="outline" onClick={() => saveModelOverride.mutate({ platform: provider.platform, modelId: model.modelId, overrides: modelDraft, revision: providerSettings.revision })} disabled={saveModelOverride.isPending || !unifiedKey?.apiKey}>Save model</Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {(saveProviderOverride.isError || saveModelOverride.isError) && <p className="text-sm text-destructive mt-3">{((saveProviderOverride.error ?? saveModelOverride.error) as Error).message}</p>}
        </section>
      )}
    </div>
  )
}
