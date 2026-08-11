# Prevención — atribución del fallback live del bridge

- **Fecha:** 2026-08-11
- **Estado:** automatizado para canary aislado y auditor live reproducible; la ejecución live depende de proporcionar explícitamente una base SQLite externa.
- **Caso mínimo:** `X-Fallback-Attempts: 2` y `X-Routed-Via: opencode-go/deepseek-v4-flash` prueban que hubo dos intentos antes de Go, pero no identifican por sí solos las plataformas ni el motivo de cada intento.
- **Capa responsable:** runner E2E/diagnóstico y trazas sanitizadas del router; no el traductor Responses.
- **Detección esperada:** una prueba live debe devolver, por intento, únicamente `platform`, `model`, `status`, `classification` y `durationMs`, sin claves, prompts ni cuerpos de proveedor.
- **Evidencia actual:** `npm run canary:codex` y `npm run canary:codex:live` usan el mismo proyector allowlisted; el primero lee `/api/fallback/traces` del canary determinista y emite `fallbackAttribution`, mientras el segundo crea una copia SQLite temporal y captura la matriz live normal/forzada sin cambiar ChatGPT. La ejecución live no se lanza automáticamente porque requiere una ruta externa explícita.
- **Acción futura:** ejecutar `GLORYAPI_LIVE_DB_PATH=<ruta>` en una ventana controlada y conservar únicamente el JSON sanitizado. Hasta obtener esa captura, la documentación live debe distinguir la disponibilidad observada de la salud simultánea y no inventar la cadena intermedia.
- **Referencia:** `Agente/documentacion/codex-chatgpt-bridge-audit-2026-08-11.md` y `integrations/codex-bridge/README.md`.
