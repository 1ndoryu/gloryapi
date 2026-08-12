# Roadmap GloryAPI

GloryAPI es un workspace hermano aislado de FreeLLMAPI. La ruta operativa normal sigue siendo
FreeLLMAPI/ChatGPT normal; el bridge se abre bajo demanda en una ventana y un historial aislados.

## Siguiente bloque ejecutable

1. Mantener y verificar el runtime externo: `%USERPROFILE%\.gloryapi\gloryapi.db`, snapshot
   `freellmapi-live-20260811.db` y 23 credenciales DPAPI; no tocar `freellmapi`.
2. Completar schemas de respuesta/unions, timeouts por fase, idempotency de tools, propagación
   de métricas por salto, SSRF de socket y smoke de scripts Windows sin activar ChatGPT.
3. Ejecutar preflight de cada bloque: `npm run task:check:local -- <ID>`; al cerrar:
   `npm run task:check -- GLORY-BASELINE`, build, suite server/client y suite bridge.

## Decisiones y bloqueos explícitos

- No crear `origin`, hacer push/deploy ni escribir en servicios externos sin destino y autorización
  puntual. El workspace no tiene aún un remoto externo configurado.
- No hacer cutover ni rollback sobre la configuración activa: el usuario pidió mantener ChatGPT
  normal. El E2E Desktop probado usa exclusivamente `desktop-user-data-bridge`.
- La restauración bajo otro perfil/equipo Windows requiere una ventana administrativa real; no se
  simula como PASS desde este perfil.

## Bloques ya cerrados localmente

- Aislamiento, snapshot real, bóveda DPAPI, importación original 22/22, credencial TokenHarbor,
  recovery y rutas externas.
- Catálogo activo de cuatro modelos: Andoryyu, OpenCode Zen, TokenHarbor y OpenCode Go; la ruta
  explícita `deepseek-v4-flash:free` queda fijada a TokenHarbor.
- Catálogo/registry/settings/routing/autosave y wizard provider→activación fail-closed.
- Bridge modular y agnóstico: server.js orquesta; config, HTTP, Responses, SSE, translation,
  tools, upstream, visión, estado, redacción y métricas están separados.
- Contrato `glory-responses-request-v1`, capabilities fail-closed, diagnostics, cachés bounded,
  error boundary y DNS/rebinding de visión con transporte fijado por dirección validada.
- UI: `SortableModelRow` compartido; ledger de workarounds y threat model actualizados.
- Panel operativo completamente localizado al español: navegación, enrutamiento, claves, analítica,
  configuración, estados, errores y wizard de proveedores; contratos, rutas y valores reales intactos.

## Evidencia del bloque actual

- `npm test`: 50 archivos / 281 tests PASS.
- Suite bridge: 132/132 PASS en ejecución secuencial, incluyendo el launcher de dos `CODEX_HOME`,
  CLI/Desktop controlados, switches seguros sin mutación del home normal, el web loop del navegador,
  el nudge universal sin depender de frases de intención, recuperación de herramientas mixtas en
  streaming/no-streaming, límite de rondas, auditoría inconclusa sin falso `completed` y protección
  contra inyección en argumentos. La auditoría también continúa ante una narración intermedia y solo
  emite `response.failed` al agotar sus 3 rondas o presupuesto.
- `npm run build` (shared, server y client): PASS. Vite conserva únicamente el warning existente de
  chunk grande del cliente.
- `npm run quality:doctor`: `ready=true`; Sentinel 0.7.1 alineado.
- `npm run task:check -- GLORY-BASELINE`: bloqueado antes del análisis post-cambio porque el runtime
  local de Sentinel no tiene inicializado su `sourcePath` (`tool-source-missing`). No se declara PASS;
  la suite y el build sí son evidencia post-cambio. Las excepciones de directorios densos siguen
  declaradas explícitamente en `sentinel.config.json`.
- Routing: 128/128 sin fallos; p95 **63.9 ms con concurrencia 8**, **30.8 ms con 16** y
  **62.6 ms con 32**, todos bajo el presupuesto de 100 ms.
- FreeLLMAPI sigue en `:3001`; ChatGPT normal y `C:\Users\Owner\.codex\config.toml` permanecen
  sin cambios. El bridge responde en `http://127.0.0.1:4100/health` y se opera desde el acceso
  directo `ChatGPT Bridge - GloryAPI.lnk`.
- La coexistencia quedó preparada y verificada: el home normal es
  `C:\Users\Owner\.codex` y el home aislado es `C:\Users\Owner\.codex-gloryapi`; el segundo
  no copia `auth.json`, SQLite ni conversaciones del primero.
- El bloque anterior quedó en `89e4506` (`fix(codex): estabiliza bridge aislado y recuperacion de turnos`);
  el bloque actual añade recuperación del web loop, resúmenes Responses y presupuesto de nudge.
- Manual operativo: `integrations/codex-bridge/COMANDOS-BRIDGE.md`.

Fuente de detalle: `PLAN-GLORYAPI.md`. Evidencia histórica: `Agente/completados/` y
`Agente/documentacion/migracion/`.
