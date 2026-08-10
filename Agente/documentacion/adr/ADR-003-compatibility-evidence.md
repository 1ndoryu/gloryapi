# ADR-003 — Compatibilidad como evidencia por cliente y modelo

Estado: aceptado para el canary aislado  
Fecha: 2026-08-10

## Decisión

La compatibilidad no se declara por proveedor o nombre de modelo. Se registra por
`cliente × adapter × modelo × wire`, con estados `supported`, `adapted`,
`unsupported` y `unverified`.

El bridge puede usar adaptación con pérdida para imagen, namespaces o tools solo si
la matriz lo declara y el fixture prueba la semántica observable. Un stream truncado,
una capability obligatoria desconocida o un terminal ausente son fallos explícitos.

## Consecuencias

- VS Code Chat, Codex CLI canary y ChatGPT Desktop no se agrupan bajo un contrato
  genérico “ChatGPT”.
- El canary determinista puede validar lifecycle y framing, pero no prueba un
  proveedor real ni Desktop.
- La última etapa antes del cutover es una prueba Desktop real en perfil temporal;
  el perfil principal permanece intacto.
