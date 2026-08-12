# Roadmap GloryAPI

GloryAPI es un workspace hermano aislado de FreeLLMAPI. La ruta operativa sigue siendo
FreeLLMAPI/ChatGPT normal; el bridge queda detenido fuera de canaries temporales.

## Siguiente bloque ejecutable

1. Mantener y verificar el runtime externo: `%USERPROFILE%\.gloryapi\gloryapi.db`, snapshot
   `freellmapi-live-20260811.db` y 22 credenciales DPAPI; no tocar `freellmapi`.
2. Completar schemas de respuesta/unions, timeouts por fase, idempotency de tools, propagación
   de métricas por salto, SSRF de socket y smoke de scripts Windows sin activar ChatGPT.
3. Ejecutar preflight de cada bloque: `npm run task:check:local -- <ID>`; al cerrar:
   `npm run task:check -- GLORY-BASELINE`, build, suite server/client y suite bridge.

## Decisiones y bloqueos explícitos

- No crear `origin`, hacer push/deploy ni escribir en servicios externos sin destino y autorización
  puntual. El workspace no tiene aún un remoto externo configurado.
- No ejecutar E2E Desktop, cutover ni rollback sobre la configuración activa: el usuario pidió
  mantener ChatGPT normal. Esos escenarios quedan preparados para un canary aislado.
- La restauración bajo otro perfil/equipo Windows requiere una ventana administrativa real; no se
  simula como PASS desde este perfil.

## Bloques ya cerrados localmente

- Aislamiento, snapshot real, bóveda DPAPI, importación 22/22, recovery y rutas externas.
- Catálogo/registry/settings/routing/autosave y wizard provider→activación fail-closed.
- Bridge modular y agnóstico: server.js orquesta; config, HTTP, Responses, SSE, translation,
  tools, upstream, visión, estado, redacción y métricas están separados.
- Contrato `glory-responses-request-v1`, capabilities fail-closed, diagnostics, cachés bounded,
  error boundary y DNS/rebinding de visión con transporte fijado por dirección validada.
- UI: `SortableModelRow` compartido; ledger de workarounds y threat model actualizados.
- Panel operativo completamente localizado al español: navegación, enrutamiento, claves, analítica,
  configuración, estados, errores y wizard de proveedores; contratos, rutas y valores reales intactos.

## Evidencia del bloque actual

- `npm test`: 48 archivos / 274 tests PASS.
- Suite bridge: 112/112 PASS.
- `npm run build:server`: PASS.
- `npm run quality:doctor`: `ready=true`; Sentinel 0.7.1 alineado.
- `task:check -- GLORY-BASELINE`: PASS, 0 errores, 0 warnings; las excepciones de directorios
  densos están declaradas explícitamente en `sentinel.config.json`.
- Routing: 128/128 sin fallos; p95 **63.9 ms con concurrencia 8**, **30.8 ms con 16** y
  **62.6 ms con 32**, todos bajo el presupuesto de 100 ms.
- El bridge y GloryAPI están detenidos; FreeLLMAPI sigue en `:3001`; ChatGPT normal y
  `C:\Users\Owner\.codex\config.chatgpt.toml` permanecen sin cambios.

Fuente de detalle: `PLAN-GLORYAPI.md`. Evidencia histórica: `Agente/completados/` y
`Agente/documentacion/migracion/`.
