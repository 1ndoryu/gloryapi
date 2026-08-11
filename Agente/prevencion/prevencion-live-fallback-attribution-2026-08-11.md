# Prevención — atribución del fallback live del bridge

- **Fecha:** 2026-08-11
- **Estado:** pendiente de automatización
- **Caso mínimo:** `X-Fallback-Attempts: 2` y `X-Routed-Via: opencode-go/deepseek-v4-flash` prueban que hubo dos intentos antes de Go, pero no identifican por sí solos las plataformas ni el motivo de cada intento.
- **Capa responsable:** runner E2E/diagnóstico y trazas sanitizadas del router; no el traductor Responses.
- **Detección esperada:** una prueba live debe devolver, por intento, únicamente `platform`, `model`, `status`, `classification` y `durationMs`, sin claves, prompts ni cuerpos de proveedor.
- **Evidencia actual:** el canary forzado midió `429`/`response.failed` en Andoryyu y OpenCode Zen y `200`/`response.completed` en OpenCode Go; el ensayo normal confirmó dos intentos hasta Go y terminación SSE `[DONE]`, pero no correlacionó cada intento normal con una plataforma.
- **Acción futura:** extender el runner live aislado o exponer un bundle de trazas bounded para correlacionar cada intento sin cambiar el perfil de ChatGPT. Hasta entonces, la documentación debe describir el número de fallbacks y la ruta final, no inventar la cadena intermedia.
- **Referencia:** `Agente/documentacion/codex-chatgpt-bridge-audit-2026-08-11.md` y `integrations/codex-bridge/README.md`.
