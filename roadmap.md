# Roadmap GloryAPI

GloryAPI es un workspace hermano aislado de FreeLLMAPI. La ruta operativa normal sigue siendo
FreeLLMAPI/ChatGPT normal; el bridge se abre bajo demanda en una ventana y un historial aislados.

## Siguiente bloque ejecutable

- **039A-1 — Replay de razonamiento Muse en VS Code** *(activa; implementación lista, pendiente de validación funcional en VS Code)*:
  el transporte `responses` ahora envía siempre `store:false` + `include:["reasoning.encrypted_content"]`,
  captura el item `reasoning` en stream y no-stream por canal lateral y lo reinyecta en el turno
  continuado por prefijo de historial (caché solo-memoria LRU 100/TTL 30 min/32 KB, metadata-only).
  Plan en `Agente/planes/plan-muse-replay-vscode-2026-09-03.md`; runtime `:3101` reiniciado el
  2026-09-03 desde `dist` reconstruido (pid nuevo, `GLORYAPI_DEBUG_RESPONSES=1`, log en
  `C:\tmp\glory-3101-039A-1.log`); 039A-1b corrigió el 400 `missing required field summary` del
  replay y 039A-1c la coerción de floats integrales en args de tools (bucle `15000.0 vs u64` visto en
  sesión Desktop con Terra=Muse-Go). 039A-1d añadió prompt maestro anti-bucle al bridge
  (`BRIDGE_LOOP_DIRECTIVE`, off con `=0`; bridge `:4100` reiniciado). Decisión registrada: Muse no
  se usa en VS Code (allí DeepSeek); su camino es CLI + ChatGPT Desktop.
- **18A-2 — Autenticación de visión Mimo en el bridge** *(activa; pendiente de reintento funcional)*:
  la imagen llega correctamente, pero la ruta primaria anónima devolvió `HTTP 401`. El launcher ahora
  usa la credencial DPAPI de OpenCode Zen para `mimo-v2.5-free` por defecto,   conserva OpenCode Go como
  fallback autenticado y deja trazas metadata-only que distinguen ambas rutas. El bridge live está
  `ready`, con `primaryAuth=present` y `fallbackAuth=1`; siguiente paso: reabrir Desktop con
  `-RefreshConfig` y repetir el adjunto.
- **089A-1 — APInex DeepSeek V4 Pro con cooldown de cuota separable** *(activa; `:3101` reiniciado el 2026-09-10 — DB ya efectiva; pendiente E2E: probe + `bridge sync` + reinicio `:4100`)*:
  nuevo código `quota_exhausted` separado de `rate_limited` (`402`/mensajes de cupo gastado) y
  `failurePolicy.quotaCooldownMs` por proveedor (hereda `rateLimitCooldownMs` → `cooldownMs`);
  proveedor `apinex` (`https://apinex.bond/v1`, `deepseek-thinking`, `quotaCooldownMs:86400000`) y
  modelo `free/deepseek-v4-pro-0813` solo-explícito (fuera de Auto, ruta fijada, key id 28 en DPAPI)
  ya escritos en DB (rev 131); el `:3101` vivo aún no los ve — siguiente paso autorizado: reiniciar
  `:3101`, probe E2E `:3101` + `bridge sync` + reinicio `:4100`. Suite 351/351 y `tsc` limpios.
- **089A-2 — VyceAI GPT Luna (`gpt-5.6-new`)** *(cerrada por 089A-3: proveedor y modelo deshabilitados, key borrada)*:
  probe directo `200` en 26s con contenido plano (`reasoning_tokens:0`, sin traza); el catálogo de la
  key no trae ningún id `luna` y pedir un id inexistente deja la conexión colgada (Vyce no devuelve
  404: usar siempre timeout). Proveedor `vyceai` (`https://vyceai.com/v1`, perfil `none`,
  `reasoning:false`, `quotaCooldownMs:86400000`) y modelo `vyceai/gpt-5.6-new` ("GPT Luna (VyceAI)",
  solo-explícito, key id 29 en DPAPI) en DB rev 133; efectivo tras reinicio `:3101`.
  Evaluación 2026-09-08: identidad 1/5 — se declara "GPT-5, created by OpenAI", NO Luna (el resto de
  probes de identidad dio 500); razonamiento 2/2 correctas con justificación (cajas mixtas, bat-ball
  $0.05 con álgebra) pero sin traza observable (`reasoning_tokens:0`); seguridad SIN VEREDICTO (los
  probes SAF devolvieron 500, no refusals); fiabilidad mala — racha de `500 internal_error` tras
  ~121s en todo (incluso trivial) que persistía 15 min después. No fiable para uso real hoy;
  re-probar en otro momento. No usar `C:\tmp` para scripts que deban sobrevivir: algo los borra.
- **089A-3 — Baja de VyceAI + CommandCode flash a 4.1** *(efectiva tras el reinicio `:3101` del 2026-09-10)*:
  VyceAI dado de baja (modelo 174458 y proveedor deshabilitados, key 29 borrada) por identidad
  falsa y racha de 500s. CommandCode: upstream trae `deepseek/deepseek-v4.1-flash`; probe directo OK
  (391 correcto en 2.4s) salvo pregunta de identidad (contenido vacío; su campo oculto `reasoning`
  divaga "ChatGPT/GPT-4.1/o3" —_setting reportado, las respuestas normales sí sirven). Alta 174459
  (`supportsReasoning:1`, picker propio), baja 109624, Auto conserva prioridades con 4.1 en P3 y el
  picker `gpt-5.6-auto` intacto. OpenCode Go/Zen NO tienen 4.1 (siguen en `deepseek-v4-flash`;
  `deepseek-flash` exige header `x-opencode-session`): se dejan como están.
- **089A-4 — Compat cross-modelo: `fill-tool-reasoning` en CommandCode** *(cerrada 2026-09-10; en producción en `:3101` reiniciado)*:
  el 400 `request_invalid` ("reasoning_content must be passed back") de VS Code era historial de luna
  (8 turnos tool con `reasoning_content:""`, incluido el msg 17 con 3 calls en paralelo) cayendo en
  `cc41` tras reordenar el usuario Auto a cc41-first (rev 164, 07:37:11). Bisección con el body real de
  `failed_requests.log`: tramos ≤15 msgs → 200, +msg17 → 400, msg17 con marcador → 200 todo el
  historial; sin `reasoning_effort` también 400. Nuevo `messageProfile 'fill-tool-reasoning'` que
  rellena reasoning ausente/vacío SOLO en turnos con tool_calls con marcador honesto
  `[cross-model continuation: ...]` (trazas reales intactas, espejo si hay un solo campo); asignado a
  `commandcode` (rev 165). Verificado en vivo: replay verbatim del historial → 200; cc41/luna/auto
  frescos 200. Suite 352/352 + `tsc` limpio. Nota: el orden Auto actual (cc41 P1) lo puso el usuario
   en dashboard, no el sistema; no tocar.
- **109A-1 — Alta Experiential Labs `deepseek-v4.1-flash` como `174460`** *(cerrada 2026-09-10,
  rev 166)*: upstream `/models` lista 321 modelos e incluye `deepseek-v4.1-flash` (además de
  `deepseek-v4-flash*`, `deepseek-v4-pro*`). Alta vía `POST /api/configuration/models`
  (solo-explícita, `addToAuto:false`): display `DeepSeek V4.1 Flash (Experiential Labs)`, ctx 150000,
  `nativeVision:1` (verificado: acepta `image_url` y responde), `supportsReasoning:1` (usage trae
  `reasoning_tokens` aunque el texto de thinking no se expone), picker `deepseek-v4.1-flash` visible.
  Verificado vía `:3101`: non-stream `17*23` → `391` con `reasoning_tokens:17`; stream → `stop`
  (`Hi there friend`). Ojo: con `max_tokens` bajo devuelve `content:null`+`finish:length` (el thinking
  consume el presupuesto) y se autoidentifica como "ChatGPT/OpenAI". Transporte EL conserva
   `strip-empty-reasoning`. No se tocó el orden Auto.
- **099A-1 — Subir vitest 3→5 (advisory GHSA-82fw-gwwq-j7x9, dev-only)** *(pendiente; riesgo aceptado)*:
  `npm audit` en `server/` reporta 2 moderate (`vitest`, `@vitest/mocker`, rango 2.1.0–4.1.10,
  path traversal vía redirect mock); `prod vulns: 0`. El fix exige `vitest@5.0.2` (breaking, 2 majors)
  con riesgo sobre la suite 352/352 y el trabajo activo (039A-1/18A-2/089A-1): no se bumpió en el
  sweep 2026-09-28. Explotable solo ejecutando tests no confiables; la suite propia no está expuesta.
  Hacerlo en ventana tranquila con suite completa verde antes/después.

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
  La entrada de imagen del bridge se publica separada como `acceptsImageInput`, por lo que Desktop
  permite adjuntos para todos los modelos y Mimo adapta los no nativos.
- Pensamiento visible en el bridge: el item de razonamiento se finaliza siempre antes del item de
  mensaje, incluso cuando el proveedor (CommandCode) envía contenido antes del pensamiento; el
  stream retiene el texto hasta abrir el item `reasoning` y cierra el resumen con los eventos
  terminales. Regresión cubierta en `test/reasoning-stream-order.test.cjs`.
- Cadena de visión persistida: `/fallback` muestra una lista separada de modelos de visión del
  bridge (prioridad + activación), persistida en `bridge_vision_routes` y expuesta en la
  proyección del catálogo (`visionModels`/`visionHash`); el launcher la convierte en
  `VISION_BASE_URL`/`VISION_MODEL` + fallbacks con credenciales DPAPI por `authPlatform`.
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
- Desktop Bridge live: proceso aislado, `CODEX_HOME`, Auto como predeterminado
  recuperable desde `Avanzado → Restablecer a predeterminado` mediante el slug
  reservado `gpt-5.6-sol`, seis modelos
  explícitos visibles (incluido Zen mediante `gpt-5.4-mini`),
  `/v1/models`, health `published` y ausencia de Pro verificados; no se hizo
  una llamada externa de proveedor durante la prueba.

- FreeLLMAPI sigue en `:3001`; ChatGPT normal y `C:\Users\Owner\.codex\config.toml` permanecen
  sin cambios. El bridge responde en `http://127.0.0.1:4100/health` y se opera desde el acceso
  directo `ChatGPT Bridge - GloryAPI.lnk`.
- La coexistencia quedó preparada y verificada: el home normal es
  `C:\Users\Owner\.codex` y el home aislado es `C:\Users\Owner\.codex-gloryapi`; el segundo
  no copia `auth.json`, SQLite ni conversaciones del primero.
- Manual operativo: `integrations/codex-bridge/COMANDOS-BRIDGE.md`.
- Evidencia 18A-2: helper de visión Zen/Go validado sin exponer claves; bridge `:4100` health/readiness/capabilities PASS; catálogo aislado 7/7 entradas anuncia `text,image` y solo Muse conserva visión nativa; suites bridge 176/176 y server 310/310 PASS. No se cerró todavía porque falta la inferencia real de Mimo tras el reintento del usuario.
- Pensamiento CommandCode + cadena de visión (2026-08-25): `npm run build:server` PASS, `tsc -b` del cliente PASS, suite del bridge (incluido `reasoning-stream-order.test.cjs` nuevo) PASS y server 55/55 en los archivos afectados PASS. Detalle en `Agente/completados/tareas-2026-08-25.md`.

Fuente de detalle: `PLAN-GLORYAPI.md`. Evidencia histórica: `Agente/completados/` y
`Agente/documentacion/migracion/`.
