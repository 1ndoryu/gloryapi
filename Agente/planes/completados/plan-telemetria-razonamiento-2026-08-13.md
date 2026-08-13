# Plan — Telemetría de razonamiento por solicitud

## Objetivo

Confirmar en GloryAPI si un modelo recibió un nivel de esfuerzo (`low`, `medium`,
`high` o `max`) y cuántos tokens de razonamiento devolvió el proveedor, sin
guardar prompts, respuestas ni credenciales.

## Alcance

- Propagar el esfuerzo ya existente desde `/v1/chat/completions` hasta el
  registro de Analytics.
- Extraer `reasoning_tokens` de las variantes habituales de uso OpenAI-compatible.
- Cubrir streaming: usar el dato final del proveedor y marcar como estimación
  únicamente cuando el proveedor no lo entregue.
- Exponer los datos en `/api/analytics/summary` y `/api/analytics/history`, y
  mostrarlos en la pantalla en español.
- Migración aditiva e idempotente para bases GloryAPI ya existentes.

## Fuera de alcance

- Mostrar la cadena de pensamiento privada.
- Guardar contenido de solicitudes o respuestas.
- Hacer una llamada pagada de prueba a CommandCode.

## Definition of Done

- [x] Columnas nuevas migran sin recrear la base.
- [x] Streaming y no streaming registran esfuerzo y fuente de tokens.
- [x] Analytics muestra el esfuerzo y distingue proveedor/estimación/sin dato.
- [x] Pruebas de extracción, streaming y migración pasan.
- [x] Build de shared, server y client pasa.
- [x] Runtime reiniciado y endpoint de Analytics verificado mediante la base
  operativa migrada y el health check de GloryAPI en `:3101`.
