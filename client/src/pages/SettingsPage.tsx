import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'
import { scopeLabels, settingDescription, settingLabel, useSettingsPage } from '@/hooks/useSettingsPage'

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
    updateValue,
    saveChanges,
    discardChanges,
    resetScope,
    updateProviderOverride,
    updateModelOverride,
  } = useSettingsPage()
  const [activeScope, setActiveScope] = useState<string>('routing')
  const tabScopes = [
    ['general', 'General'],
    ['routing', 'Enrutamiento'],
    ['health', 'Salud y reintentos'],
    ['provider', 'Proveedores'],
    ['compatibility', 'Compatibilidad'],
    ['logging', 'Registros'],
    ['security', 'Seguridad'],
  ] as const
  const activeSettings = grouped.find(([scope]) => scope === activeScope)?.[1] ?? []

  return (
    <div>
      <PageHeader
        title="Configuración"
        description="Controles operativos validados. Las invariantes de seguridad permanecen en el código."
        actions={
          <div className="flex items-center gap-2">
            {hasChanges && <Button variant="ghost" size="sm" onClick={discardChanges}>Descartar</Button>}
          <Button size="sm" onClick={saveChanges} disabled={!hasChanges || save.isPending}>
              {save.isPending ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando configuración…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">No se pudo cargar la configuración.</p>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-1" role="tablist" aria-label="Secciones de configuración">
            {tabScopes.map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                role="tab"
                aria-selected={activeScope === scope}
                onClick={() => setActiveScope(scope)}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${activeScope === scope ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{scopeLabels[activeScope as keyof typeof scopeLabels] ?? tabScopes.find(([scope]) => scope === activeScope)?.[1]}</h2>
              {activeSettings.length > 0 && <Button variant="outline" size="xs" onClick={() => resetScope(activeScope as keyof typeof scopeLabels)}>Restaurar valores predeterminados</Button>}
            </div>
            {activeSettings.length > 0 ? (
              <div className="rounded-lg border divide-y bg-card">
                {activeSettings.map(setting => {
                  const value = data?.settings.find(item => item.key === setting.key)?.value ?? setting.defaultValue
                  return (
                    <div key={setting.key} className="flex flex-wrap items-center gap-4 px-4 py-3">
                      <div className="min-w-[240px] flex-1">
                        <div className="flex items-center gap-2">
                          <Label htmlFor={setting.key} className="text-sm">{settingLabel(setting.key)}</Label>
                          {setting.requiresRestart && <Badge variant="outline">requiere reinicio</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{settingDescription(setting.key, setting.description)}</p>
                        <p className="text-[11px] text-muted-foreground/70 mt-1 font-mono">{setting.key}</p>
                      </div>
                      <div className="w-[180px]">
                        {setting.type === 'boolean' ? (
                          <label className="flex items-center gap-2 text-sm">
                            <input id={setting.key} type="checkbox" checked={Boolean(value)} onChange={event => updateValue(setting, event.target.checked)} />
                            {value ? 'Activado' : 'Desactivado'}
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
                        {typeof setting.min === 'number' && typeof setting.max === 'number' && <p className="text-[11px] text-muted-foreground mt-1">Permitido: {setting.min}–{setting.max}</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                Esta sección todavía no tiene configuraciones modificables. La compatibilidad de proveedores y las invariantes de seguridad permanecen explícitas y fallan de forma segura.
              </div>
            )}
          </section>
          {save.isError && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
          {save.isSuccess && !hasChanges && <p className="text-xs text-muted-foreground">Guardado en la revisión {data?.revision}.</p>}
          <p className="text-xs text-muted-foreground">Revisión de configuración: {data?.revision ?? 0}</p>
        </div>
      )}

      {providerSettings && activeScope === 'provider' && (
        <section className="mt-10">
          <div className="mb-3">
            <h2 className="text-sm font-medium">Sobrescrituras de proveedores y modelos</h2>
            <p className="text-xs text-muted-foreground mt-1">Los valores marcados como heredados vienen del registro canónico. Las sobrescrituras se validan antes de guardarse.</p>
          </div>
          <div className="space-y-4">
            {providerSettings.providers.map(provider => {
              const providerDraft = providerDrafts[provider.platform] ?? {}
              return (
                <div key={provider.platform} className="rounded-lg border bg-card p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">{provider.platform}</h3>
                      <p className="text-xs text-muted-foreground">Configuración del proveedor y capacidades heredadas</p>
                    </div>
                    <Button size="xs" onClick={() => saveProviderOverride.mutate({ platform: provider.platform, overrides: providerDraft, revision: providerSettings.revision })} disabled={saveProviderOverride.isPending}>Guardar proveedor</Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`base-url-${provider.platform}`} className="text-xs">URL base</Label>
                      <Input id={`base-url-${provider.platform}`} value={providerDraft.baseUrl ?? provider.effective.baseUrl} onChange={event => updateProviderOverride(provider.platform, 'baseUrl', event.target.value)} className="font-mono text-xs" />
                      <p className="text-[11px] text-muted-foreground">{provider.effective.sources.baseUrl === 'default' ? 'Heredado' : 'Sobrescritura del proveedor'}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`timeout-${provider.platform}`} className="text-xs">Tiempo límite (ms)</Label>
                      <Input id={`timeout-${provider.platform}`} type="number" min={1000} max={120000} step={1000} value={providerDraft.timeoutMs ?? provider.effective.timeoutMs} onChange={event => updateProviderOverride(provider.platform, 'timeoutMs', event.target.value)} className="font-mono text-xs" />
                      <p className="text-[11px] text-muted-foreground">{provider.effective.sources.timeoutMs === 'default' ? 'Heredado' : 'Sobrescritura del proveedor'}</p>
                    </div>
                  </div>
                  {provider.models.length > 0 && (
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs font-medium">Sobrescrituras de modelos</p>
                      {provider.models.map(model => {
                        const identity = `${provider.platform}:${model.modelId}`
                        const modelDraft = modelDrafts[identity] ?? {}
                        return (
                          <div key={identity} className="grid gap-2 sm:grid-cols-[1fr_180px_auto] items-end rounded-md bg-muted/30 p-3">
                            <div className="space-y-1">
                              <Label htmlFor={`alias-${identity}`} className="text-xs">{model.displayName}</Label>
                              <Input id={`alias-${identity}`} value={modelDraft.alias ?? model.effective.alias ?? ''} placeholder="ID de modelo heredado" onChange={event => updateModelOverride(provider.platform, model.modelId, 'alias', event.target.value)} className="font-mono text-xs" />
                              <p className="text-[11px] text-muted-foreground">Alias: {model.effective.sources.alias === 'default' ? 'predeterminado' : 'modelo'}</p>
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`model-timeout-${identity}`} className="text-xs">Tiempo límite (ms)</Label>
                              <Input id={`model-timeout-${identity}`} type="number" min={1000} max={120000} step={1000} value={modelDraft.timeoutMs ?? model.effective.timeoutMs} onChange={event => updateModelOverride(provider.platform, model.modelId, 'timeoutMs', event.target.value)} className="font-mono text-xs" />
                              <p className="text-[11px] text-muted-foreground">Tiempo límite: {model.effective.sources.timeoutMs === 'default' ? 'predeterminado' : 'modelo'}</p>
                            </div>
                            <Button size="xs" variant="outline" onClick={() => saveModelOverride.mutate({ platform: provider.platform, modelId: model.modelId, overrides: modelDraft, revision: providerSettings.revision })} disabled={saveModelOverride.isPending}>Guardar modelo</Button>
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
