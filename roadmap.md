# Roadmap GloryAPI

GloryAPI es un workspace hermano aislado de FreeLLMAPI. La ruta operativa normal sigue siendo
FreeLLMAPI/ChatGPT normal; el bridge se abre bajo demanda en una ventana y un historial aislados.

## Siguiente bloque ejecutable

1. Revisar y commitear el bloque de configuración V2, routing coherente,
   selector dinámico, telemetría y `_e2e_apply_patch.cjs`; la checklist de
   cierre está en `Agente/planes/plan-coherencia-configuracion-modelos-routing-bridge-2026-08-13.md`.
2. Reiniciar únicamente el bridge cuando se quiera hacer la validación live del
   catálogo aislado; ChatGPT normal y `C:\Users\Owner\.codex` permanecen fuera
   del alcance.
3. Si se requiere el gate completo, reparar primero el `sourcePath` fijado de
   Sentinel (`tool-source-missing`); no declarar PASS con otro binario.

## Decisiones y bloqueos explícitos

- No crear `origin`, hacer push/deploy ni escribir en servicios externos sin destino y autorización
  puntual. El workspace no tiene aún un remoto externo configurado.
- No hacer cutover ni rollback sobre la configuración activa: el usuario pidió mantener ChatGPT
  normal. El E2E Desktop probado usa exclusivamente `desktop-user-data-bridge`.
- No ampliar el catálogo ni añadir más overrides hardcodeados mientras esté activo el plan de
  coherencia. Los cambios urgentes de routing deben expresarse en la DB actual y acompañarse de una
  prueba que demuestre que ningún camino alternativo ignora sus flags.
- La restauración bajo otro perfil/equipo Windows requiere una ventana administrativa real; no se
  simula como PASS desde este perfil.

## Bloques ya cerrados localmente

- Ahorro de tokens del bridge: plan ejecutado y conservado en
  `Agente/planes/completados/plan-ahorro-tokens-bridge-2026-08-12.md`; clasificador de
  títulos, auditoría compacta, presupuesto total compartido, telemetría de
  caché/tipo de solicitud y Analytics en español.

- Aislamiento, snapshot real, bóveda DPAPI, importación original 22/22, credencial TokenHarbor,
  recovery y rutas externas.
- Catálogo activo de cuatro familias: Andoryyu, OpenCode Zen, TokenHarbor y OpenCode Go; la ruta
  explícita `deepseek-v4-flash:free` queda fijada a TokenHarbor.
- Catálogo/registry/settings/routing/autosave y wizard provider→activación fail-closed.
- Bridge modular y agnóstico: server.js orquesta; config, HTTP, Responses, SSE, translation,
  tools, upstream, visión, estado, redacción y métricas están separados.
- Contrato `glory-responses-request-v1`, capabilities fail-closed, diagnostics, cachés bounded,
  error boundary y DNS/rebinding de visión con transporte fijado por dirección validada.
- UI: `SortableModelRow` compartido; ledger de workarounds y threat model actualizados.
- Panel operativo completamente localizado al español: navegación, enrutamiento, claves, analítica,
  configuración, estados, errores y wizard de proveedores; contratos, rutas y valores reales intactos.
- CommandCode integrado como proveedor activo con dos modelos explicit-only (DeepSeek V4 Flash y
  Muse Spark 1.2 Contributor). El modelo Pro fue retirado del catálogo y no se enruta. El flujo de
  credencial usa `api_keys` + DPAPI,
  pero la instancia local actual todavía no tiene una fila `commandcode`; la clave debe añadirse
  desde el panel antes de enviar solicitudes reales.
- Selector de modelos del bridge: el picker de Codex Desktop consume el catálogo local y la caché
  aislada regenerados por `prepare-isolated-home.ps1`, y expone Auto, OpenCode Zen, TokenHarbor y
  los dos modelos CommandCode restantes; `body.model` se resuelve contra el catálogo versionado
  `glory-bridge-model-catalog-v1`.
- Muse Spark 1.2 usa visión nativa (bloques `image_url`); el resto conserva la adaptación a texto.
- El web loop interno tiene un presupuesto configurable (`BRIDGE_WEB_TOOL_ROUNDS`) y, al agotarlo,
  elimina la herramienta web y solicita una síntesis final con los resultados ya obtenidos; una nueva
  petición web en esa síntesis falla de forma recuperable para no permitir ciclos infinitos.
- El descubrimiento diferido `tool_search` del perfil `codex-desktop` usa modo directo por defecto
  (`BRIDGE_TOOL_SEARCH_MODE=direct`), con shims concretos y directiva configurable; `generic` conserva
  el modo cliente para integraciones que sí gestionan el protocolo de descubrimiento.
- El catálogo del bridge y el home aislado unifican `context_window`, `max_context_window` y
  `auto_compact_token_limit` en `150000`; el bridge limita también `CONTEXT_LIMIT_TOKENS` a ese valor
  por defecto para que Codex compacte igual al cambiar de modelo.

## Evidencia del bloque actual

- Configuración V2 y routing coherente: `npm run build:server` PASS; suite
  server 54 archivos / 305 tests PASS; snapshot real con 4 miembros activos en
  Auto, 6 modelos y cero DeepSeek V4 Pro.
- Bridge y `_e2e_apply_patch.cjs`: suite secuencial 33 archivos / 168 tests PASS; el E2E es
  opt-in, no guarda tokens en `C:\temp` y usa un directorio temporal aislado.
- CLI: `snapshot`, `bridge sync` y `bridge diagnose` PASS sobre una base
  temporal; el diagnóstico confirma que DB, ruta Auto, proyección y hash son
  coherentes.
- Rendimiento: `npm run bench:routing` 128/128 PASS, p95 37.8 ms con
  concurrencia 32 frente a un presupuesto de 100 ms.
- Telemetría: cada request nuevo conserva modelo solicitado, ruta, revisión,
  motivo y confianza de selección en Analytics.
- Limitación: Sentinel continúa bloqueado por `tool-source-missing`; no se
  presenta como gate PASS.

- `npm test -w server`: 54 archivos / 305 tests PASS.
- Suite bridge: 168/168 PASS en ejecución secuencial, incluyendo el launcher de dos `CODEX_HOME`,
  CLI/Desktop controlados, switches seguros sin mutación del home normal, el web loop del navegador,
  el nudge universal sin depender de frases de intención, recuperación de herramientas mixtas en
  streaming/no-streaming, límite de rondas con síntesis final sin herramienta web, auditoría inconclusa sin falso `completed` y protección
  contra inyección en argumentos. La auditoría también continúa ante una narración intermedia y solo
  emite `response.failed` al agotar sus 3 rondas o presupuesto.
- `npm run build` (shared, server y client): PASS. Vite conserva únicamente el warning existente de
  chunk grande del cliente.
- `npm run quality:doctor`: bloqueado por `tool-source-missing`; el source fijado de Sentinel no está
  inicializado en `glory-rs-rest`.
- `npm run task:check` y `npm run task:check:local`: bloqueados antes del análisis post-cambio porque el runtime
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
