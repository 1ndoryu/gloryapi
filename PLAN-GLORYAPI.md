# Plan maestro: migración de FreeLLMAPI a GloryAPI

> Actualizado: 2026-08-11
> Estado: **bloque local implementado y verificado; quedan únicamente pruebas/acciones externas o de canary**.

## Objetivo y límites

GloryAPI es un workspace hermano, aislado y configurable de FreeLLMAPI: catálogo de cuatro
modelos, bóveda recuperable, routing persistente, Control API autenticada, bridge Responses
modular y bandeja Windows. FreeLLMAPI sigue siendo la ruta operativa y ChatGPT normal sigue
activo. El bridge permanece detenido fuera de canaries aislados.

Reglas permanentes:

- No compartir `.git`, SQLite/WAL, `.env`, datos, puertos, PID, logs, bridge ni perfiles.
- No escribir secretos en Git, documentación, respuestas, logs ni reportes.
- Loopback y autenticación son el modo predeterminado; live/cutover es opt-in.
- No modificar ni eliminar `freellmapi` durante la migración.
- No crear ni publicar un remoto externo sin destino y autorización explícitos.

Catálogo operativo requerido: `andoryyu/deepseek-v4-flash`,
`opencode-zen/deepseek-v4-flash-free`, `tokenharbor/deepseek-v4-flash:free` y
`opencode-go/deepseek-v4-flash`, en ese orden.
Las 23 credenciales permanecen en la bóveda aunque su proveedor no tenga un modelo activo.

## Completado y evidencia compacta

### Aislamiento, APIs reales y bóveda (fases 0–4, 6–9)

- Se localizó la fuente real en
  `C:\Users\Owner\OneDrive\Documentos\area-trabajo\freellmapi\server\data\freeapi.db`
  sin modificarla. El snapshot externo es
  `C:\Users\Owner\.gloryapi\backups\freellmapi-live-20260811.db` (`integrity_check=ok`).
- La base canónica de GloryAPI es `C:\Users\Owner\.gloryapi\gloryapi.db`; contiene 23
  credenciales protegidas por DPAPI `CurrentUser`: las 22 importadas y la credencial TokenHarbor
  añadida desde el panel local. Importación y recuperación son idempotentes, con fingerprints,
  bundle portable, dry-run y health opt-in.
- GloryAPI rechaza rutas que estén dentro del árbol `freellmapi`; runtime, logs y PID usan
  rutas externas configurables. FreeLLMAPI continúa activo en `:3001`.
- Catálogo, registry, settings `glory-settings-v1`, routing `glory-routing-v1`, autosave,
  SSE autenticado, conflict revision, capacidades y fallback fail-closed están cubiertos.
- El wizard visual ahora cubre provider → endpoint/auth → draft/credencial → discovery o
  modelo manual → capabilities → review → health/chat → activación. Las credenciales se envían
  una sola vez al API local y nunca se muestran en UI.
- La fila de routing se extrajo a `client/src/components/routing/SortableModelRow.tsx` para
  reutilizarla en dashboard y bandeja. El snapshot HTTP de routing usa un TTL bounded de 250 ms
  y se invalida al escribir.
- La ruta Chat Completions separó el streaming a `server/src/services/proxy-stream.ts`, y el
  wizard concentra su estado en `useReducer` para mantener responsabilidades y límites claros.

### Bridge modular, contrato y resiliencia local (fase 10 y P4/P6 locales)

- `integrations/codex-bridge/bridge/server.js` quedó como entrypoint/orquestador de menos de
  10 KiB; configuración, HTTP, traducción, Responses, SSE, tools, upstream, visión, estado,
  cachés, diagnóstico y métricas viven en módulos separados.
- La configuración es agnóstica: `BRIDGE_*` tiene prioridad y se mantienen aliases
  `GLORY_*`/`FREEL_*`; upstream, modelo, endpoint, auth, contrato y perfiles son configurables.
- Se añadieron `glory-responses-request-v1`, validación bounded de requests, capabilities por
  combinación cliente/adapter/provider/modelo, diagnostics autenticado y métricas bounded.
  Las capacidades no demostradas son `unsupported` o `unverified`, nunca éxito.
- El fallback interno `FALLBACK_REASONING` queda oculto en la frontera Responses; tool-only,
  reasoning-only y upstream vacío tienen terminación fail-closed y recuperación bounded.
- La coexistencia de ChatGPT normal y bridge quedó preparada con dos `CODEX_HOME` e historiales
  independientes: `%USERPROFILE%\.codex` y `%USERPROFILE%\.codex-gloryapi`. El launcher solo copia
  `config.toml`, nunca `auth.json`, SQLite ni conversaciones; el bridge no se activa automáticamente.
- Redacción estructurada cubre headers, tokens, tool args, bodies, SSE y errores. El estado JSON
  usa versión compatible, TTL, límites, escritura temp/fsync/rename y recuperación ante corrupción.
- DNS de visión valida todas las direcciones antes de cada intento y falla cerrado ante rebinding;
  la conexión fija el conjunto validado con `lookup` controlado y conserva SNI. Límites de
  body/stream/imagen/concurrencia, cancelación, caché LRU por bytes, coalescing, error boundary
  y cierre acotado están activos.
- Se documentaron el ledger de workarounds y el threat model local en
  `Agente/documentacion/migracion/`.

### Evidencia ejecutada en este bloque

- `npm test`: **49 archivos / 281 tests PASS**; shared y client compilan.
- Suite bridge aislada: **113/113 PASS**, incluyendo CLI/Desktop controlados, `--profile`,
  `CODEX_HOME` aislado y switches seguros sin mutar el home normal.
- `npm run build:server`: PASS.
- `npm run quality:doctor`: `ready=true`, Sentinel 0.7.1 alineado y sin issues.
- `npm run task:check -- GLORY-BASELINE`: PASS, 0 errores, 0 warnings; las excepciones explícitas
  de directorios densos quedaron limitadas a bridge/tests/rutas conocidas en `sentinel.config.json`.
- Benchmark routing final: 128/128 sin fallos; p95 **63.9 ms con concurrencia 8**, **30.8 ms
  con 16** y **62.6 ms con 32**, todos bajo el presupuesto de 100 ms. El benchmark calienta
  el pool HTTP y el TTL máximo del snapshot es configurable hasta 250 ms.
- `git diff --check`: PASS.
- No quedan procesos/listeners propios de GloryAPI o bridge; ChatGPT normal, `config.chatgpt.toml`
  y FreeLLMAPI no se modificaron.

### Bloque de coexistencia de historiales — verificado localmente

- Scripts nuevos: `integrations/codex-bridge/mode/prepare-isolated-home.ps1` y
  `integrations/codex-bridge/mode/start-codex-bridge.ps1`.
- Selectores actualizados: `codex-mode.ps1`, `switch-deepseek.ps1` y `switch-chatgpt.ps1`.
- `switch-chatgpt.ps1` es seguro por defecto; la mutación global solo se permite con
  `-LegacyGlobalConfig`.
- Evidencia adicional: parser PowerShell **5/5 OK**; `npm test` **49 archivos / 281 tests PASS**
  y build shared/client; `git diff --check` PASS; `task:check` `GLORY-BASELINE` PASS con cero
  errores y cero warnings.
- El archivo untracked `integrations/codex-bridge/test/_e2e_apply_patch.cjs` es preexistente,
  ajeno a este bloque, no fue tocado y queda fuera del commit.

## Pendientes verificables reales

Los números conservan la trazabilidad del plan histórico; los puntos ya resueltos no se repiten.

### P0 — Dependencias externas y recuperación

1. Crear el repositorio remoto externo `gloryapi` y configurar solo ese `origin`; falta destino,
   credencial y autorización externa.
2. Probar bundle/DPAPI bajo otro perfil o equipo Windows, incluyendo pérdida de frase y perfil;
   requiere una ventana administrativa real.
3. Ejecutar piloto live desde el snapshot, health opt-in y segunda importación completa; queda
   reservado a una ejecución controlada sobre APIs reales.

### P1/P2/P3 — Rendimiento, evidencia externa y contrato completo

4. Capturar trazas metadata-only equivalentes de ChatGPT nativo, Desktop con bridge y VS Code;
   Desktop/bridge no se activan mientras la ruta normal siga siendo la elegida.
5. Cerrar carga de sistema completo: separar selección, SQLite, SSE, backpressure, retry storm,
   provider lento, 1M de historial y soak; el benchmark HTTP de routing ya pasa 8/16/32.
6–7. **Resueltos localmente**: auditoría de UI/fila compartida y wizard completo fail-closed.
8–9. **Resueltos localmente**: ledger de workarounds y división unidireccional del bridge.
10. Request schema y matrix de capabilities están resueltos; falta completar schemas de
    respuestas/unions y pruebas por adapter real.
11. E2E real de Desktop: texto, stream, reasoning, tools, MCP/plugins, web/browser, imagen,
    multiagente, cancelación, contexto largo y fallos tool-only. Requiere reactivar canary.

### P4 — Seguridad, estado y resiliencia avanzada

12. **Resuelto localmente**: redacción estructurada, dumps bounded y pruebas de no filtración.
13. Completar SSRF con pruebas externas en escenario real para web y visión; el bloqueo de rangos,
    HTTPS, redirects, límites, rebinding local y pinning de socket de visión ya están cubiertos.
14–15. **Resueltos localmente**: estado atómico bounded y threat model con límites reales de DPAPI.
16. Separar todos los timeouts por fase y completar idempotency/ownership de retries para no
    repetir efectos externos de tools.
17. Backpressure avanzado: clientes lentos, drain de sockets, restart backoff y crash-loop
    detection; el límite activo, error boundary y cierre bounded ya están cubiertos.
18. Correlación Codex→bridge→GloryAPI→provider por salto, first-token/bytes/eventos,
    cancelaciones y soak 24 h; diagnostics/latencia HTTP bounded ya están disponibles.

### P5 — Fidelidad de protocolo y política por combinación

19–20. Política passthrough-first y separación native relay/repairs/translation con IR neutral,
    encoder Responses único y ledger de transformaciones.
21–22. Estado de reasoning/tools por thread/provider/model/call, rondas abiertas y único terminal
    boundary con high-water marks para frames, items y argumentos.
23–24. Cambio de modo transaccional con journal/preimagen/hash y capabilities versionadas con
    autoridad explícita y revalidación.
25–26. Afinidad/traza de routing, single-flight de mutaciones, límites tras descompresión y
    pruebas diferenciales/metamórficas con procedencia de OpenCodex.

### P6/P7 — Bandeja, canary y cierre

27. **Resuelto localmente**: auth, redacción, CORS, SSRF/DNS, caché corrupta, logs y contratos
    del bridge; faltan escenarios de smoke de scripts contra estados de Windows no simulados.
28. Ejecutar rollback de un paso y verificar restauración de ChatGPT, sin tocar la configuración
    activa durante requests. Solo procede con canary explícito.
29–30. Elegir Tauri/Electron, construir bandeja completa y autostart reversible; el prototipo
    PowerShell aislado existe, pero no es la bandeja final.
31–33. Canary comparativo, ensayo rollback y cutover atómico de VS Code/bridge/scripts/bandeja;
    deliberadamente no se ejecutan mientras ChatGPT normal sea la ruta activa.
34. Auditoría final SOLID/seguridad/rendimiento/recovery/UI/tray y gate full/CI sin warnings
    válidos; el gate local actual tiene 0 errores/0 warnings y routing p95-32 dentro del
    presupuesto, pero quedan escenarios externos.
35. Documentación local de README, ledger, threat model y contrato está actualizada; quedan
    los manuales finales de coexistencia/cutover/bandeja después del canary.

## Criterios de cierre

El objetivo global solo se cierra cuando los puntos restantes tienen evidencia real, no solo
fixtures: el bridge sigue sin alterar ChatGPT normal, FreeLLMAPI conserva rollback, las
capabilities desconocidas son fail-closed, no quedan sidecars/locks/claims propios y build,
tests, auditoría y Sentinel terminan sin hallazgos válidos.

## Fuentes canónicas y orden

- `roadmap.md`: cola operativa compacta.
- `Agente/documentacion/`: contratos, ADRs, migración, recuperación y evidencia.
- `integrations/codex-bridge/README.md`: operación del sidecar y canary.
- `server/src/`: comportamiento vigente.

Orden: `P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7`, con gate después de cada bloque. Las
acciones externas requieren destino explícito y autorización; nunca se toca `freellmapi` para
acelerar el plan.
