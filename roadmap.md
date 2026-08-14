# Roadmap GloryAPI

GloryAPI es un workspace hermano aislado de FreeLLMAPI. La ruta operativa normal sigue siendo
FreeLLMAPI/ChatGPT normal; el bridge se abre bajo demanda en una ventana y un historial aislados.

## Siguiente bloque ejecutable

La corrección de coherencia del selector y las capacidades quedó validada
localmente. La UI usa una sola lista de modelos,
sin duplicar la configuración de Auto y rutas fijadas, y publicar el catálogo
  aislado después de verificar que las rutas compatibles de DeepSeek V4 Flash
  transmiten el nivel de razonamiento seleccionado. ChatGPT normal y
`C:\Users\Owner\.codex` permanecen fuera del alcance.

## Decisiones y bloqueos explícitos

- No crear `origin`, hacer push/deploy ni escribir en servicios externos sin destino y autorización
  puntual. El workspace no tiene aún un remoto externo configurado.
- No hacer cutover ni rollback sobre la configuración activa: el usuario pidió mantener ChatGPT
  normal. El E2E Desktop probado usa exclusivamente `desktop-user-data-bridge`.
- No ampliar el catálogo ni añadir más overrides hardcodeados mientras esté activo el plan de
  coherencia. Los cambios urgentes de routing deben expresarse en la DB actual y acompañarse de una
  prueba que demuestre que ningún camino alternativo ignora sus flags.
- La lista de Enrutamiento es la única superficie operativa para modelos: su interruptor controla la
  pertenencia a Auto, el orden controla la prioridad de Auto y la ruta fijada se abre desde esa misma
  fila. `Configurar Auto` queda solo para sus opciones generales.
- La capacidad de razonamiento es efectiva por modelo y debe estar declarada también por el proveedor;
  Andoryyu, OpenCode Zen, OpenCode Go y CommandCode Flash la anuncian, mientras TokenHarbor permanece
  desactivado porque su contrato local no declara esa capacidad.
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
  explícita `deepseek-v4-flash:free` queda fijada a TokenHarbor. CommandCode Flash y Muse se
  mantienen como modelos explícitos fuera de Auto.
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
  aislada regenerados por `prepare-isolated-home.ps1`, y expone los modelos visibles de la única
  configuración canónica; `body.model` se resuelve contra el catálogo versionado
  `glory-bridge-model-catalog-v2`.
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
  server 54 archivos / 310 tests PASS; snapshot real con Auto limitado a sus
  dos miembros actualmente activos, seis modelos configurados más la entrada
  Auto en el selector, y cero DeepSeek V4 Pro.
- Bridge: suite secuencial 174 tests PASS; E2E aislado de configuración 1/1 PASS
  y regresión del sincronizador PASS. `_e2e_apply_patch.cjs` permanece opt-in y
  fuera de la suite automática.
- CLI: `snapshot`, `bridge sync` y `bridge diagnose` PASS sobre la base
  operativa; el diagnóstico confirma que DB, ruta Auto, proyección y hash son
  coherentes.
- Rendimiento: `npm run bench:routing` 128/128 PASS, p95 53.2 ms con
  concurrencia 32 frente a un presupuesto de 100 ms.
- Telemetría: cada request nuevo conserva modelo solicitado, ruta, revisión,
  motivo y confianza de selección en Analytics.
- Calidad: `quality:doctor` PASS con Sentinel 0.7.5 alineado; `task:check`
  `GLORY-COHERENCIA-FULL-20260814F` PASS con identidad `enforce`, 0 errores,
  15 warnings y 1 info.
- Desktop Bridge live: proceso aislado, `CODEX_HOME`, selector de 7 entradas,
  `/v1/models`, health `published` y ausencia de Pro verificados; no se hizo
  una llamada externa de proveedor durante la prueba.

- FreeLLMAPI sigue en `:3001`; ChatGPT normal y `C:\Users\Owner\.codex\config.toml` permanecen
  sin cambios. El bridge responde en `http://127.0.0.1:4100/health` y se opera desde el acceso
  directo `ChatGPT Bridge - GloryAPI.lnk`.
- La coexistencia quedó preparada y verificada: el home normal es
  `C:\Users\Owner\.codex` y el home aislado es `C:\Users\Owner\.codex-gloryapi`; el segundo
  no copia `auth.json`, SQLite ni conversaciones del primero.
- Manual operativo: `integrations/codex-bridge/COMANDOS-BRIDGE.md`.

Fuente de detalle: `PLAN-GLORYAPI.md`. Evidencia histórica: `Agente/completados/` y
`Agente/documentacion/migracion/`.
