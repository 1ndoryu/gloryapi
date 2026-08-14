import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ConfiguredModel, ConfigurationFieldDefinition } from '@/hooks/useFallbackPage'

type EditableValue = string | number | boolean | null
type EditableModel = Record<string, EditableValue>

export function ModelConfigDialog({
  model,
  onClose,
  onSave,
  isSaving,
  error,
  fields,
}: {
  model: ConfiguredModel
  onClose: () => void
  onSave: (patch: EditableModel) => void
  isSaving: boolean
  error: string | null
  fields: ConfigurationFieldDefinition[]
}) {
  const [draft, setDraft] = useState<EditableModel>({
    displayName: model.displayName,
    enabled: model.enabled,
    contextWindow: model.contextWindow,
    nativeVision: model.nativeVision,
    supportsReasoning: model.supportsReasoning,
    bridgeVisible: model.bridgeVisible,
  })

  function update(key: string, value: EditableValue) {
    setDraft(current => ({ ...current, [key]: value }))
  }

  const modelFields = fields.filter(field => field.scope === 'model')

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
          {modelFields.map(field => {
            const key = field.key
            const value = draft[key]
            if (field.type === 'boolean') {
              return (
                <label key={field.key} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={Boolean(value)} onChange={event => update(key, event.target.checked)} />
                  <span><span className="block">{field.label}</span><span className="block text-xs text-muted-foreground">{field.description}</span></span>
                </label>
              )
            }
            const numeric = field.type === 'integer' || field.type === 'duration-ms'
            return (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`modelo-${field.key}`}>{field.label}</Label>
                <Input id={`modelo-${field.key}`} type={numeric ? 'number' : 'text'} min={field.min} max={field.max} value={value == null ? '' : String(value)} onChange={event => {
                  const raw = event.target.value
                  const next = numeric ? (raw === '' ? null : Number(raw)) : raw
                  update(key, next)
                }} />
                <p className="text-xs text-muted-foreground">{field.description}</p>
              </div>
            )
          })}
          {modelFields.length === 0 && <p className="text-sm text-muted-foreground">El esquema de configuración no publicó campos editables para este modelo.</p>}
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
