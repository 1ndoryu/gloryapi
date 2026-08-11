# Plan — Auditoría y refuerzo del bridge ChatGPT/Codex

- **Objetivo:** que el sidecar Responses → Chat Completions sea modular, configurable y seguro al atravesar Andoryyu, OpenCode Zen y OpenCode Go, preservando herramientas, agentes, plugins, streaming y recuperación de contexto.
- **Alcance:** bridge local, proxy/routing canary de GloryAPI, fixtures, documentación y pruebas locales.
- **No alcance:** cambiar la configuración activa de ChatGPT, activar perfiles reales, llamadas externas, deploy/push o SSH.
- **Fuente canónica:** `Agente/documentacion/codex-chatgpt-bridge-audit-2026-08-11.md`.

## Fases

1. **Descubrimiento y referencias — completada.** Se revisaron el bridge modular, GloryAPI providers/router, contratos OpenAI Responses, el app-server de OpenAI Codex y los históricos `PLAN-CODEX-BRIDGE.md`/`ADR-001`.
2. **Documentación y matriz — completada.** Se fijaron frontera Responses/Chat Completions, ownership de routing, matriz de tres proveedores, límites de tools/agentes/plugins/visión/compactación y riesgos residuales.
3. **Correcciones del bridge — completada.** Se añadió transporte streaming con timeout total/idle, perfil `codex-desktop|generic`, filtrado del fallback reasoning, redacción de errores upstream, lectura bounded de bodies, presupuesto de schemas de herramientas y modelo de resumen configurable.
4. **Canary de tres proveedores — completada.** El harness usa SQLite/puertos/credenciales temporales, helper DPAPI token-only, selección server-side autenticada y ejecuta una petición Responses directa por proveedor más fallback; `auto`, modelos no declarados y token inválido quedan fail-closed.
5. **Verificación — completada localmente.** `npm run build:server`, 85/85 tests dirigidos, `npm run task:check -- GLORY-BASELINE` y `npm run canary:codex` pasan; el canary ejecuta SSE Responses real, continuidad al cambiar entre los tres proveedores con historial verificado, toolset namespaced de plugin/MCP, forwarding aislado del Browser skill desde el marketplace local bundled con sanitización allowlist y fuente fija, cancelación bounded de respuestas no-SSE y además un `shell_command` real desde Codex CLI temporal. El bridge se detiene al finalizar. La suite del servidor conserva evidencia histórica 270/270, pero en la verificación actual no inicia por un error externo de resolución/esbuild (`Access is denied` al resolver `../../../../..`).
6. **E2E Desktop/proveedor real — pendiente explícito.** Solo se ejecutará con una ventana autorizada usando un perfil separado, sin editar `config.toml`; hasta entonces la capability real continúa `unverified`.

## Definition of Done

- [x] `server.js` permanece como composición, no como monolito; los adapters tienen responsabilidades separadas.
- [x] El path streaming no puede esperar indefinidamente después de recibir headers.
- [x] Los shims de cliente no están activos en el perfil genérico.
- [x] Una directiva canary no puede seleccionar proveedores en producción ni sin token separado.
- [x] Hay evidencia determinista directa de los tres proveedores y de fallback.
- [x] No se cierra con solo reasoning, no se expone `FALLBACK_REASONING` y no se fabrica `function_call_output` en la misma respuesta.
- [x] Documentación y referencias primarias están versionadas.
- [x] La compactación cuenta herramientas, usa un modelo configurable y no queda bloqueada por un body de resumen abierto.
- [x] Visión y búsqueda web conservan sus deadlines durante la lectura de respuestas bounded.
- [ ] E2E real de ChatGPT/Codex Desktop y proveedores externos; permanece fuera de esta sesión para proteger la configuración activa.
