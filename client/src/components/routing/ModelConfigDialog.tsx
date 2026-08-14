import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ConfiguredModel } from '@/hooks/useFallbackPage'

type EditableModel = Pick<ConfiguredModel, 'displayName' | 'enabled' | 'contextWindow' | 'nativeVision' | 'supportsReasoning'>

export function ModelConfigDialog({
  model,
  onClose,
  onSave,
  isSaving,
  error,
}: {
  model: ConfiguredModel
  onClose: () => void
  onSave: (patch: EditableModel) => void
  isSaving: boolean
  error: string | null
}) {
  const [draft, setDraft] = useState<EditableModel>({
    displayName: model.displayName,
    enabled: model.enabled,
    contextWindow: model.contextWindow,
    nativeVision: model.nativeVision,
    supportsReasoning: model.supportsReasoning,
  })

  function update<Key extends keyof EditableModel>(key: Key, value: EditableModel[Key]) {
    setDraft(current => ({ ...current, [key]: value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="configurar-modelo-titulo">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="configurar-modelo-titulo" className="text-base font-semibold">Configurar modelo</h2>
            <p className="mt-1 text-xs text-muted-foreground font-mono">{model.platform}/{model.modelId}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
        </div>
        <div className="mt-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="modelo-display-name">Nombre visible</Label>
            <Input id="modelo-display-name" value={draft.displayName} onChange={event => update('displayName', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="modelo-context-window">Ventana de contexto</Label>
            <Input id="modelo-context-window" type="number" min={1} max={2000000} value={draft.contextWindow ?? ''} onChange={event => update('contextWindow', event.target.value === '' ? null : Number(event.target.value))} />
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} /> Disponible para selección</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.nativeVision} onChange={event => update('nativeVision', event.target.checked)} /> Visión nativa</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.supportsReasoning} onChange={event => update('supportsReasoning', event.target.checked)} /> Admite razonamiento</label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button onClick={() => onSave(draft)} disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar modelo'}</Button>
          </div>
        </div>
      </section>
    </div>
  )
}
