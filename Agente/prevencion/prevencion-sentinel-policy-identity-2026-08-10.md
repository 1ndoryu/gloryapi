# Prevención: identidad de política ausente en el gate full

Fecha: 2026-08-10  
Proyecto: `gloryapi`  
Estado: mitigado con commit/artefacto fijados; publicación upstream pendiente

## Caso reproducible

`quality:doctor` puede devolver `readyForGate: true`, con política `enforce`,
`policyHash` y lock/source/provisionado alineados, mientras `npm run task:check --
<ID>` genera un informe PASS cuya sección `policy` contiene `policyHash:
"unavailable"`, `policyPath: null` y `reason: identidad de política no disponible`.

La causa confirmada estaba en el checkout externo de Sentinel 0.7.0: `gateRun` no
propagaba `policyIdentity` al construir el informe con `createReport`. La corrección
vive ahora en el commit fijado `7d18a755f12751ae9fd1ac67827f5a6dad8be631`, tag
local `v0.7.1`, lock y artefacto provisionado `85ba836d...`; el checkout fuente
está limpio y el gate full pasa sin overlay manual.

## Detección obligatoria

Antes de aceptar un cierre, comparar `quality:doctor` con el JSON/Markdown del
gate full. El gate solo es aceptable si ambos contienen la identidad/hash de
política, `mode: enforce`, cero errores y cero warnings accionables. Un CLI PASS
con identidad ausente es un fallo de herramienta, no un cierre válido.

El wrapper `scripts/quality/task-check.mjs` aplica ahora esta regla y termina con
estado 1 cuando el informe full carece de identidad `enforce`; por eso el comando
puede mostrar las etapas Sentinel en PASS y, aun así, bloquear correctamente el
cierre.

## Reparación esperada

Publicar el tag `v0.7.1` en Sentinel upstream y conservar la misma alineación de
commit, versión, lock y artefacto en GloryAPI. La prevención se archiva solo cuando
el informe fresco del artefacto publicado contiene `policyPath`, `policyHash` y la
decisión de política esperada.
