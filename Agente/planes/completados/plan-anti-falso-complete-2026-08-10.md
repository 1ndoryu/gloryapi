# Plan: anti-falso-complete — nudge de ejecución en el bridge (2026-08-10)

## 1. Problema

En Codex Desktop (DeepSeek V4 Flash vía bridge), el agente a veces **cierra el turno
con una narrativa de intención sin ejecutar nada**: responde texto plano ("Voy a
escanear los `.md`...", "Necesito ajustar el fork... lo reintento") sin invocar
ninguna herramienta, y la app lo interpreta como turno terminado → `task_complete`
automático ~0,5 s después. El usuario pierde tiempo revisando manualmente si el
agente continuó o se detuvo.

## 2. Evidencia

| Caso | Turno | Respuesta del modelo | tool_calls | Resultado |
|---|---|---|---|---|
| Rollout `019fee93` (thread detenido) | 2 | "Tienes razón: usaste la fecha en el **nombre**... Voy a escanear los `.md` y extraer las fechas del propio nombre para ordenarlos." | 0 | `task_complete` 0,5 s después, sin ejecutar |
| Sesión fork (turno 1) | 1 | "Necesito ajustar el fork para poder usar el rol especializado del supervisor. Lo reintento con el contexto completo en el mensaje." | 0 | `task_complete` sin reintentar |
| Sesión navegador (stall narrativo) | — | "Voy a intentar abrir el navegador..." | 0 | stall (misma firma, servido por `andoryyu/deepseek-v4-flash`) |

Firma común: **texto con marcadores de intención futura + 0 tool_calls + cierre de
turno inmediato**. No es error del bridge ni de infraestructura: es comportamiento
del modelo (narra el plan en lugar de ejecutarlo), y el bridge traduce fielmente
ese texto como respuesta final → `response.completed` → la app cierra el turno.

## 3. Causa raíz

1. **El modelo** (deepseek-v4-flash) decide "narrar" la acción que va a hacer en
   lugar de invocar la herramienta. Patrón recurrente con tareas que requieren
   leer el sistema de archivos o reintentar una operación.
2. **El bridge** no distingue "respuesta final" de "intención de actuar": cualquier
   texto sin `tool_calls` termina en `response.completed` con `end_turn: true`.
3. **Codex Desktop** no puede saber que el texto era una intención: sin
   `function_call`, cierra el turno.

## 4. Solución (capas)

### Capa A — Prevención en el prompt (barata, reduce frecuencia)

Añadir al chat traducido, **solo cuando hay tools disponibles**, un mensaje
`system` corto con la directiva de ejecución:

> "Si tu respuesta requiere realizar una acción (leer, buscar, editar, ejecutar,
> reintentar...), invoca la herramienta correspondiente EN ESTE MISMO turno.
> Nunca termines tu turno anunciando una acción sin ejecutarla."

Se inyecta en `translateRequest` cuando `chat.tools.length > 0`. Es un mensaje
adicional, no muta el system de Codex (no afecta a `boundSystemContent`).

### Capa B — Detección + reintento automático (nudge) — el fix de fondo

En `streamChatToResponses` (y en `nonStreamingChatToResponses`), **antes de
emitir `response.completed`**:

1. **Detección**: `toolCalls.size === 0` **y** `chat.tools.length > 0` **y** el
   texto final contiene marcadores de intención futura (`voy a`, `vamos a`,
   `necesito`, `debo`, `lo reintento`, `reintento`, `procedo a`, `ahora voy`,
   `primero voy`, `lo haré`, `intentaré`, `voy a intentar`, `voy a hacer`,
   `voy a <verbo>`...).
2. **Nudge**: un segundo request upstream (no-stream, timeout acotado
   `BRIDGE_NUDGE_TIMEOUT_MS`, default 60 s) añadiendo al chat un mensaje
   `user` de empuje:

   > "Continúa: ejecuta ahora la acción que anunciaste usando las herramientas
   > disponibles. No repitas el plan: invoca la herramienta en este turno.
   > Si la acción ya está hecha o no requiere herramienta, responde solo el
   > resultado."

3. **Si el nudge devuelve `tool_calls`** → se emiten como items `function_call`
   (mismo pipeline de `lookupToolCall`/`withSpawnForkFix`) y el turno **continúa**
   (no hay `response.completed` vacío: la app ejecuta la herramienta).
4. **Si el nudge devuelve texto sin tools** → se descarta (no se duplica texto)
   y se cierra con la respuesta original; log `nudge_noop`.

Límites (anti-bucle):
- `BRIDGE_NUDGE_RETRIES` (default 1, máximo 3, 0 = desactivado).
- Solo cuando el request original llevaba tools.
- Solo cuando el texto final es narrativa de intención (heurística conservadora).

### Capa C — Telemetría

Kinds nuevos en `bridge.requests.log`:
- `nudge_retry`: se reintentó y el retry devolvió tool_calls (éxito).
- `nudge_noop`: se reintentó pero el retry devolvió texto sin tools.
- `nudge_error`: falló el request de nudge (502 upstream).

Con `routedVia` para correlacionar proveedor (andoryyu vs opencode-go/zen).

## 5. Alcance / no alcance

- **Sí**: path streaming principal y path non-streaming del bridge.
- **No**: el web-loop interno (`streamInternalWebLoopToResponses`) ya tiene su
  propio ciclo de reintento; el falso complete real no pasa por ahí. Se deja
  fuera para no duplicar mecanismos.
- **No**: cambios en Codex Desktop (no controlamos la app).

## 6. Implementación

Archivo: `integrations/codex-bridge/bridge/server.js` (junction con
`%USERPROFILE%\.codex\bridge`).

1. Constantes: `NUDGE_RETRIES`, `NUDGE_TIMEOUT_MS`, `NUDGE_DIRECTIVE`.
2. Helper `isFutureIntentNarration(text)` (regex de marcadores, case-insensitive).
3. Helper `buildNudgeChat(chat, finalText)` → chat + `user` de empuje.
4. `fetchUpstreamCompletion(chat, authorization, timeoutMs?)` → timeout opcional.
5. `maybeNudge(...)` → si aplica, hace el retry y devuelve `{toolCalls}`.
6. Integración en `streamChatToResponses` (antes de `response.completed`) y en
   `nonStreamingChatToResponses`.
7. Directiva preventiva en `translateRequest` (Capa A, solo con tools).

## 7. Validación

- `node --check` sobre `server.js`.
- Nuevo test estático `test/anti-false-complete.test.cjs` (patrón
  `fork-fix.test.cjs`: extrae `isFutureIntentNarration` del server.js real y
  valida casos positivos/negativos + límite de reintentos).
- Test de integración con upstream mock determinista (patrón
  `browser-stall-regression`): primera respuesta = SSE narrativo sin tools;
  el nudge (2º request no-stream) devuelve `tool_calls` → el bridge debe emitir
  `function_call` y NO cerrar con `response.completed` fantasma.
- Suite completa del bridge (38/39 esperado; `vision-error-redaction` es el único
  fallo pre-existente y ajeno).
- Reinicio del bridge (`restart-bridge.ps1`), health OK en 4100.

## 8. Definition of Done

- [ ] Un turno que antes producía "falso complete" ahora continúa con tool_calls
      (validado por test de integración con upstream mock).
- [ ] Suite del bridge sin regresiones (38/39, único fallo pre-existente).
- [ ] Bridge reiniciado y saludable.
- [ ] Commit coherente en gloryapi (rama gloryapi), sin push (requiere autorización).
- [ ] Telemetría `nudge_retry`/`nudge_noop` en el log para validar en vivo.

## 9. Riesgos

- **Falso positivo de la heurística**: respuesta legítima con "voy a..." que no
  requería tool. Mitigación: el nudge descarta texto del retry; a lo sumo añade
  latencia (1 request extra), nunca cambia la respuesta visible.
- **Loop**: acotado por `NUDGE_RETRIES=1` y por la condición (solo sin tool_calls).
- **Latencia**: el nudge añade hasta ~60 s en el peor caso; el retry solo ocurre
  en el patrón narrativo (raro).

## 10. Estado

- [x] Análisis y diseño (este documento).
- [x] Implementación (server.js: constantes, helpers, Capa A, nudge streaming y non-streaming).
- [x] Tests + suite: `anti-falso-complete.test.cjs` 5/5; suite bridge 42/43 (único
      fallo pre-existente ajeno: vision-error-redaction).
- [x] Reinicio del bridge (PID 33736, health OK) — queda validación en vivo con el
      usuario en su próxima sesión de Codex Desktop (gota del patrón falso-complete).
- [x] Commit `0c8011e` en rama `gloryapi`.

Documentado en `Agente/completados/tareas-2026-08-10.md`.

> **SUPERADO (2026-08-11)**: la heurística de la Capa B (regex `isFutureIntentNarration`)
> dejaba escapar el falso complete con otras redacciones (p. ej. "Sigo la auditoría
> leyendo..." — thread `019fee99`). Se sustituyó por un **hook universal de
> confirmación** que pregunta al modelo ("ok" = cierre real; cualquier otra cosa =
> continúa ejecutando) — tarea `11826-1`, commit `e6cad84`. `isFutureIntentNarration`
> queda solo como telemetría `intent`. Ver `Agente/completados/tareas-2026-08-11.md`.
