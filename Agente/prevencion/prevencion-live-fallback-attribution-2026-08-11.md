# Prevención — atribución del fallback live del bridge

- **Fecha:** 2026-08-11
- **Estado:** automatizado para el canary aislado; pendiente de evidencia equivalente contra el router live normal.
- **Caso mínimo:** `X-Fallback-Attempts: 2` y `X-Routed-Via: opencode-go/deepseek-v4-flash` prueban que hubo dos intentos antes de Go, pero no identifican por sí solos las plataformas ni el motivo de cada intento.
- **Capa responsable:** runner E2E/diagnóstico y trazas sanitizadas del router; no el traductor Responses.
- **Detección esperada:** una prueba live debe devolver, por intento, únicamente `platform`, `model`, `status`, `classification` y `durationMs`, sin claves, prompts ni cuerpos de proveedor.
- **Evidencia actual:** `npm run canary:codex` ya lee `/api/fallback/traces` y emite `fallbackAttribution` con esos cinco campos por intento; el canary forzado mide `429`/`response.failed` en Andoryyu y OpenCode Zen y `200`/`response.completed` en OpenCode Go. El ensayo normal confirmó dos intentos hasta Go y terminación SSE `[DONE]`, pero todavía no hay una captura automatizada equivalente contra el router live normal.
- **Acción futura:** conectar el mismo lector a un runner live aislado, con credenciales y base temporal, sin cambiar el perfil de ChatGPT. Hasta entonces, la documentación live debe describir el número de fallbacks y la ruta final, no inventar la cadena intermedia.
- **Referencia:** `Agente/documentacion/codex-chatgpt-bridge-audit-2026-08-11.md` y `integrations/codex-bridge/README.md`.
