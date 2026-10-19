# Roadmap — gloryapi

**Contexto.** GloryAPI es un workspace aislado de FreeLLMAPI: panel local de configuración y
enrutamiento de modelos más un bridge Responses para ChatGPT/Codex. Corre solo en el portátil
(GloryAPI `:3101`, FreeLLMAPI `:3001`, bridge `:4100`); no tiene remoto externo ni producción. Plan
vivo de detalle: `PLAN-GLORYAPI.md`. La ruta operativa normal sigue siendo FreeLLMAPI/ChatGPT normal;
el bridge se abre bajo demanda en una ventana y un historial aislados. La lista de Enrutamiento es la
única superficie operativa para modelos: su interruptor controla la pertenencia a Auto, el orden la
prioridad de Auto y la ruta fijada se abre desde esa misma fila (`Configurar Auto` queda solo para
sus opciones generales). La capacidad de razonamiento es efectiva por modelo y debe declararla también
el proveedor: Andoryyu, OpenCode Zen, OpenCode Go y CommandCode Flash la anuncian, mientras TokenHarbor
permanece desactivado porque su contrato local no declara esa capacidad.

## Siguiente bloque

- [ ] `039A-1` — **Replay de razonamiento Muse en VS Code.**
  Activa; implementación lista, pendiente de validación funcional en VS Code.
  El transporte `responses` ahora envía siempre `store:false` + `include:["reasoning.encrypted_content"]`,
  captura el item `reasoning` en stream y no-stream por canal lateral y lo reinyecta en el turno
  continuado por prefijo de historial (caché solo-memoria LRU 100/TTL 30 min/32 KB, metadata-only).
  Plan en `Agente/planes/completados/plan-muse-replay-vscode-2026-09-03.md`; runtime `:3101` reiniciado el
  2026-09-03 desde `dist` reconstruido (pid nuevo, `GLORYAPI_DEBUG_RESPONSES=1`, log en
  `C:\tmp\glory-3101-039A-1.log`); 039A-1b corrigió el 400 `missing required field summary` del
  replay y 039A-1c la coerción de floats integrales en args de tools (bucle `15000.0 vs u64` visto en
  sesión Desktop con Terra=Muse-Go). 039A-1d añadió prompt maestro anti-bucle al bridge
  (`BRIDGE_LOOP_DIRECTIVE`, off con `=0`; bridge `:4100` reiniciado). Decisión registrada: Muse no
  se usa en VS Code (allí DeepSeek); su camino es CLI + ChatGPT Desktop.

## Pendientes

- [ ] `18A-2` — **Autenticación de visión Mimo en el bridge.**
  Activa; pendiente de reintento funcional.
  La imagen llega correctamente, pero la ruta primaria anónima devolvió `HTTP 401`. El launcher ahora
  usa la credencial DPAPI de OpenCode Zen para `mimo-v2.5-free` por defecto,   conserva OpenCode Go como
  fallback autenticado y deja trazas metadata-only que distinguen ambas rutas. El bridge live está
  `ready`, con `primaryAuth=present` y `fallbackAuth=1`; siguiente paso: reabrir Desktop con
  `-RefreshConfig` y repetir el adjunto.
- [ ] `089A-1` — **APInex DeepSeek V4 Pro con cooldown de cuota separable.**
  Activa; `:3101` reiniciado el 2026-09-10 — DB ya efectiva; pendiente E2E: probe + `bridge sync` + reinicio `:4100`.
  Nuevo código `quota_exhausted` separado de `rate_limited` (`402`/mensajes de cupo gastado) y
  `failurePolicy.quotaCooldownMs` por proveedor (hereda `rateLimitCooldownMs` → `cooldownMs`);
  proveedor `apinex` (`https://apinex.bond/v1`, `deepseek-thinking`, `quotaCooldownMs:86400000`) y
  modelo `free/deepseek-v4-pro-0813` solo-explícito (fuera de Auto, ruta fijada, key id 28 en DPAPI)
  ya escritos en DB (rev 131); el `:3101` vivo aún no los ve — siguiente paso autorizado: reiniciar
  `:3101`, probe E2E `:3101` + `bridge sync` + reinicio `:4100`. Suite 351/351 y `tsc` limpios.
- [ ] `099A-1` — **Subir vitest 3→5 (advisory GHSA-82fw-gwwq-j7x9, dev-only).**
  Pendiente; riesgo aceptado.
  `npm audit` en `server/` reporta 2 moderate (`vitest`, `@vitest/mocker`, rango 2.1.0–4.1.10,
  path traversal vía redirect mock); `prod vulns: 0`. El fix exige `vitest@5.0.2` (breaking, 2 majors)
  con riesgo sobre la suite 352/352 y el trabajo activo (039A-1/18A-2/089A-1): no se bumpió en el
  sweep 2026-09-28. Explotable solo ejecutando tests no confiables; la suite propia no está expuesta.
   Hacerlo en ventana tranquila con suite completa verde antes/después.

## Bloqueos

- `deploy` — **Sin destino ni autorización.** No se crea `origin`, ni se hace push/deploy, ni se
  escribe en servicios externos sin destino y autorización puntual; el workspace no tiene aún un
  remoto externo configurado.
- `cutover` — **No se toca la configuración activa.** No se hace cutover ni rollback sobre la
  configuración activa: el usuario pidió mantener ChatGPT normal. El E2E Desktop probado usa
  exclusivamente `desktop-user-data-bridge`.
- `catálogo` — **Congelado mientras el plan de coherencia esté activo.** No se amplía el catálogo ni
  se añaden más overrides hardcodeados; los cambios urgentes de routing se expresan en la DB actual y
  se acompañan de una prueba que demuestre que ningún camino alternativo ignora sus flags.
- `restauración` — **Requiere ventana administrativa real.** La restauración bajo otro perfil/equipo
  Windows no se simula como PASS desde este perfil.

## Planes activos

- `Agente/planes/plan-codex-bridge-audit-2026-08-11.md` — `11826-1` — auditoría y refuerzo del bridge
  ChatGPT/Codex (serie `11826-1…9`); fases 1–5 y 7 hechas, pendiente el E2E real desde Desktop.
- `Agente/planes/plan-vision-auth-401-2026-08-18.md` — `18A-2` — autenticación de visión Mimo en el
  bridge; implementado, pendiente el reintento funcional del usuario.
