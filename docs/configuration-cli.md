# CLI de configuración coherente

La fuente única de proveedores, modelos, rutas y catálogo del bridge es la base SQLite de GloryAPI. El
comando de configuración modifica esa fuente mediante revisiones CAS; no se deben editar catálogos JSON ni
listas de fallback a mano.

## Operaciones seguras

Desde la raíz de `gloryapi`:

```powershell
npm --silent run config -w server -- snapshot --json
npm --silent run config -w server -- config export --output .\config-export.json --json
npm --silent run config -w server -- config validate .\config-export.json --json
npm --silent run config -w server -- config diff .\config-export.json --json
npm --silent run config -w server -- config apply .\config-export.json --expected-revision 12 --idempotency-key apply-20260813 --dry-run --json
```

`--dry-run` valida y devuelve la propuesta sin publicar una revisión. En operaciones mutables, usar una
`--idempotency-key` estable permite reintentar sin crear otra revisión. Reutilizar la misma clave con un
payload diferente es un error deliberado.

## Contrato de salida y errores

Con `--json`, tanto éxito como error producen un único objeto JSON en stdout:

```json
{
  "ok": false,
  "error": {
    "code": "configuration_revision_conflict",
    "message": "..."
  }
}
```

Códigos estables principales:

- `configuration_revision_conflict`: la revisión esperada ya no es la actual; volver a leer y decidir.
- `invalid_configuration`: documento o propuesta inválida.
- `invalid_json`: JSON de argumento ilegible.
- `invalid_number`: flag numérico inválido.
- `idempotency_key_invalid`: clave con caracteres o longitud no permitidos.
- `idempotency_key_reused`: clave usada con otra operación/payload.
- `idempotency_key_in_progress`: otra ejecución aún está procesando la clave.
- `cli_error`: error de I/O, ruta inexistente o fallo inesperado.

Códigos de salida: `0` éxito, `2` entrada/configuración/idempotencia inválida, `3` conflicto CAS y `1`
fallo de ejecución. Sin `--json`, stderr conserva el formato legible `codigo: mensaje`.

## Bridge

```powershell
npm --silent run config -w server -- bridge catalog --json
npm --silent run config -w server -- bridge sync "$env:USERPROFILE\.gloryapi\runtime\bridge-runtime\bridge-model-catalog.json" --json
npm --silent run config -w server -- bridge diagnose "$env:USERPROFILE\.gloryapi\runtime\bridge-runtime\bridge-model-catalog.json" --json
```

El archivo local es una proyección transportable. La base sigue siendo la autoridad; `bridge diagnose`
compara revisión, hash, Auto y exclusiones. La interfaz muestra si esa proyección está al día, desactualizada,
ausente o inválida.

## Linaje de solicitudes internas

Las auditorías, continuaciones, recuperaciones, síntesis web y compactaciones conservan metadatos internos
no visibles al modelo: request padre, `routeId`, revisión de configuración y motivo de selección. GloryAPI los
guarda en la telemetría para distinguir el modelo solicitado del modelo que realmente atendió cada ronda.
