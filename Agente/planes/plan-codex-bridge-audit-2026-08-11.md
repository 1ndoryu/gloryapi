# Plan — Auditoría y refuerzo del bridge ChatGPT/Codex

- **Objetivo:** que el sidecar Responses → Chat Completions sea modular, configurable y seguro al atravesar Andoryyu, OpenCode Zen y OpenCode Go, preservando herramientas, agentes, plugins, streaming y recuperación de contexto.
- **Alcance:** bridge local, proxy/routing canary de GloryAPI, fixtures, documentación y pruebas locales.
- **No alcance:** cambiar la configuración activa de ChatGPT, activar perfiles reales, llamadas externas, deploy/push o SSH.
- **Fuente canónica:** `Agente/documentacion/codex-chatgpt-bridge-audit-2026-08-11.md`.

## Fases

1. **Descubrimiento y referencias — completada.** Se revisaron el bridge modular, GloryAPI providers/router, contratos OpenAI Responses, el app-server de OpenAI Codex y los históricos `PLAN-CODEX-BRIDGE.md`/`ADR-001`.
2. **Documentación y matriz — completada.** Se fijaron frontera Responses/Chat Completions, ownership de routing, matriz de tres proveedores, límites de tools/agentes/plugins/visión/compactación y riesgos residuales.
3. **Correcciones del bridge — completada.** Se añadió transporte streaming con timeout total/idle, perfil `codex-desktop|generic`, filtrado del fallback reasoning y redacción de errores upstream.
4. **Canary de tres proveedores — completada.** El harness usa SQLite/puertos/credenciales temporales, helper DPAPI token-only, selección server-side autenticada y ejecuta una petición Responses directa por proveedor más fallback; `auto`, modelos no declarados y token inválido quedan fail-closed.
5. **Verificación — completada localmente.** `npm run build:server`, 60/60 tests dirigidos, 270/270 tests del servidor, `npm run task:check:local` y `npm run canary:codex` pasan; el canary ejecuta además un `shell_command` real desde Codex CLI temporal y el bridge se detiene al finalizar.
6. **E2E Desktop/proveedor real — pendiente explícito.** Solo se ejecutará con una ventana autorizada usando un perfil separado, sin editar `config.toml`; hasta entonces la capability real continúa `unverified`.

## Definition of Done

- [x] `server.js` permanece como composición, no como monolito; los adapters tienen responsabilidades separadas.
- [x] El path streaming no puede esperar indefinidamente después de recibir headers.
- [x] Los shims de cliente no están activos en el perfil genérico.
- [x] Una directiva canary no puede seleccionar proveedores en producción ni sin token separado.
- [x] Hay evidencia determinista directa de los tres proveedores y de fallback.
- [x] No se cierra con solo reasoning, no se expone `FALLBACK_REASONING` y no se fabrica `function_call_output` en la misma respuesta.
- [x] Documentación y referencias primarias están versionadas.
- [ ] E2E real de ChatGPT/Codex Desktop y proveedores externos; permanece fuera de esta sesión para proteger la configuración activa.
