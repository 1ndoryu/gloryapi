# Plan: replay de razonamiento Muse en VS Code (transporte Responses)

- **Tarea:** 039A-1
- **Objetivo:** que Muse Spark por OpenCode Go deje de replanificar desde cero en VS Code, portando a GloryAPI el contrato stateless del CLI (`store:false` + `include:["reasoning.encrypted_content"]` + replay del item `reasoning`), sin shim externo ni llamadas live.
- **Alcance:** `server/src/providers/responses/` (request/response/stream + caché nueva), `server/src/providers/openai-compat.ts` (usar caché en ambos caminos + fallback), tests en `server/src/__tests__/providers/responses-translate.test.ts`, documentación del md existente.
- **No alcance:** cambiar el contrato `chat/completions` de otros proveedores, tocar schema DB o `endpointKinds`, usar `previous_response_id` (gateway da 400 confirmado), mostrar pensamiento cifrado en claro, hacer llamadas externas con la key real, tocar ChatGPT normal/`:4100`/`:3001`.
- **Dependencias:** transporte `responses` ya en working copy (`muse→responses`, sanitizers, traducción stream); evidencia del md `Agente/documentacion/muse-opencode-go-vscode-bucle-2026-09-03.md §3.3/§7`; contrato CLI en `data/referencias-cli/opencode/packages/opencode/src/provider/transform.ts:23`.

## Mejoras sobre el §7 original

1. **Se descarta la Opción A (shim `:3102`):** misma heurística de asociación sin `conversation id`, pero con otro proceso/puerto que operar. El fix va directo en GloryAPI.
2. **La Opción B se concreta:** no basta "guardar id+blob"; hay que (a) pedirlo siempre, (b) capturarlo en stream y no-stream por canal lateral sin filtrarlo al cliente chat, (c) asociarlo por **prefijo de historial** (el historial VS Code crece por append; la key exacta del turno anterior nunca iguala a la del siguiente), (d) acotar memoria/TTL/bytes y (e) telemetría metadata-only.
3. **La Opción C se acota a un default seguro:** solo `max_output_tokens=4096` cuando el cliente no envía `max_tokens` y solo en transporte `responses` (evita `length` cuando el reasoning consume presupuesto). No se cambia `effort` por defecto; el clamp existente se conserva.
4. **Fail-open explícito:** si el gateway rechaza `store/include` con 400 `unknown parameter`, reintentar una vez sin esos campos en vez de romper la llamada.
5. **Seguridad explícita:** `encrypted_content` opaco, solo memoria, nunca disco/logs/telemetría; `failed_requests.log` sigue registrando `messages` chat (sin blob).

## Fases verificables

1. Nueva `reasoning-cache.ts`: normalización compacta por mensaje (role+texto truncado+tools), hash SHA-256 por mensaje y de conversación, LRU 100 entradas + TTL 30 min + tope 32 KB/8 items por entrada, lookup por prefijo más largo, sin persistencia.
2. `translate-request.ts`: enviar siempre `store:false` + `include:["reasoning.encrypted_content"]` en `responses`; aceptar `previousReasoning?` y anteponerlo al `input`; default `max_output_tokens=4096` solo si no hay `max_tokens`.
3. `translate-response.ts`: nuevo `extractReasoningItems(json)` (items `type:reasoning` con `id`+`encrypted_content` string no vacío, acotados); `translateResponsesResponse` conserva su firma y comportamiento chat.
4. `translate-stream.ts`: aceptar `collector?` opcional; rastrear `output_item.added/done` tipo `reasoning` + `response.completed.output` para poblar `collector.reasoningItems` sin alterar los chunks chat existentes.
5. `openai-compat.ts`: en `chatCompletion` y `streamChatCompletion`, lookup antes del fetch y store después del éxito/completed; fallback 400 una vez sin `store/include`; log metadata-only `hit/miss+bytes` sin blob.
6. Tests: request incluye `store/include` + replay al frente + default 4096; extract acota y filtra inválidos; caché prefijo/TTL/LRU/evicción por bytes; stream collector puebla desde `added/done/completed`; provider hace fallback ante 400 `unknown parameter`.
7. `npm run build:server` + suite del archivo + suite server completa sin regresiones; actualizar este plan y roadmap solo con evidencia.

## Estado

- **Actual:** implementación completada 2026-09-03; pendiente de validación funcional en VS Code.
- **Evidencia reproducible:** `npm run build:server` PASS; `npx vitest run src/__tests__/providers/responses-translate.test.ts` 22/22 PASS (8 nuevos 039A-1); suite server 56 archivos / 342 tests PASS; `quality:doctor` no listo por causas preexistentes ajenas (checkout sentinel dirty, evidencia release ausente, CLI 0.7.6 vs 0.7.7 esperado) — se reporta sin mezclar.
- **Limitación:** sin llamadas externas con la key real; falta reiniciar `:3101` y probar 4–5 turnos continuados en VS Code. Si el gateway rechaza `store/include` con 400, el fallback sin estado ya está cubierto y probado.
- **Siguiente paso:** reiniciar el runtime, reproducir la tarea del botón Volver en conversación nueva con `GLORYAPI_DEBUG_RESPONSES=1` y comparar replanificación/tokens por turno.
- **Gate:** `npm run build:server`, `npm test -w server` (al menos archivo afectado + completa si es viable), `npm run quality:doctor` si el entorno lo permite; sin llamadas externas.
- **Definition of Done:** body `responses` siempre con `store/include`, replay por prefijo con hit en turno continuado y miss en conversación distinta, blobs nunca en logs, tests verdes y evidencia registrada en `Agente/completados/tareas-2026-09-03.md`.
