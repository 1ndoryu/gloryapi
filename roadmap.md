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

Ninguno abierto. Las cuatro tareas que había (`039A-1`, `18A-2`, `089A-1`, `099A-1`)
se descartaron el 2026-10-20 por decisión de la usuaria; su texto queda en
`Agente/completados/tareas-2026-10-20.md`.

## Pendientes

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
- `Agente/planes/plan-vision-auth-401-2026-08-18.md` — autenticación de visión Mimo en el bridge;
  implementado y sin tarea en el roadmap desde el 2026-10-20 (se descartó `18A-2`).
