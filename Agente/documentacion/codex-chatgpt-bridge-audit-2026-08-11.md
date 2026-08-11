# Auditoría del bridge ChatGPT/Codex ↔ GloryAPI

- **Fecha:** 2026-08-11
- **Estado:** implementado y verificado localmente; además pasó una E2E HTTP real y aislada contra el GloryAPI local autenticado. El E2E de la aplicación Desktop con el perfil real sigue sin ejecutarse por decisión operativa (ChatGPT normal permanece activo).
- **Alcance:** `integrations/codex-bridge/`, el proxy de GloryAPI y sus tres proveedores activos: Andoryyu, OpenCode Zen y OpenCode Go.
- **No alcance:** cambiar `C:\Users\Owner\.codex\config.toml`, activar un perfil alternativo desde la aplicación Desktop, hacer llamadas directas a APIs externas de proveedores, deploy, push o SSH.

## Resumen ejecutivo

El bridge es un sidecar local que traduce el protocolo Responses del consumidor ChatGPT/Codex a Chat Completions de GloryAPI. No es un router de proveedores. GloryAPI conserva las credenciales, las capacidades declaradas, health, límites, sticky sessions y fallback.

La auditoría encontró y corrigió siete clases de riesgo:

1. El streaming del bridge hacía `fetch` sin deadline mientras leía el body SSE. Un upstream que enviara headers y luego quedara abierto podía dejar el turno esperando indefinidamente. Ahora hay timeout total e idle, ambos configurables, con `response.failed` explícito y sin `response.completed` falso.
2. Los shims de herramientas específicas de Codex Desktop estaban embebidos en la traducción genérica. Ahora se seleccionan mediante `BRIDGE_TOOL_PROFILE`: `codex-desktop` conserva compatibilidad con herramientas diferidas; `generic` solo reenvía lo que el cliente anuncia.
3. La cobertura de proveedores era indirecta: solo había evidencia de fallback Andoryyu → Zen. El canary aislado ahora fuerza, mediante una directiva autenticada solo en modo canary, una llamada Responses completa a cada proveedor y conserva además el caso de fallback.
4. Dos fallos históricos del baseline impedían una lectura honesta: el preflight no emitía JSON si la bóveda DPAPI no tenía clave y el fixture de visión no coincidía con el endpoint configurado. Ambos quedaron corregidos; además, la suite cubre la preservación de la directiva canary durante nudge/recovery.
5. El primer diseño del canary permitía que `auto` o un modelo explícito sin override cayeran al routing global. Ahora una directiva autenticada exige un modelo con cadena declarada y restringe la selección a un único proveedor de esa cadena; los casos inválidos fallan cerrado.
6. La compactación usaba un transporte propio sin límite de body y no contaba las definiciones de herramientas en el presupuesto. Ahora delega en el transporte bounded, propaga timeout/canary/request-id, cuenta schemas de plugins/MCP y permite elegir `BRIDGE_COMPACTION_MODEL`.
7. Visión y búsqueda web podían detener su deadline al recibir headers. Un lector de cuerpos compartido aplica límite de bytes y mantiene el timeout durante la lectura; los casos de body abierto tienen regresiones HTTP locales.

## Contrato externo que se está adaptando

El cliente no debe tratar el texto de razonamiento como respuesta final ni interpretar una llamada de herramienta como cierre del turno. En el contrato Responses, una conversación de herramientas conserva la relación `call_id`/resultado y continúa con una nueva respuesta; la emisión final debe distinguir `response.failed`, cancelación y `response.completed`.

Fuentes primarias consultadas:

- [Migración a Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses): Responses es la superficie unificada para razonamiento, herramientas, multimodalidad y estado de conversación.
- [Estado de conversación](https://developers.openai.com/api/docs/guides/conversation-state): cuando se administra el historial manualmente hay que conservar las entradas del usuario y todos los items de salida relevantes.
- [Streaming de Responses](https://developers.openai.com/api/docs/guides/streaming-responses): los eventos son incrementales y el consumidor debe reconocer la finalización o el fallo, no inferirla de un delta aislado.
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling): una llamada de función se ejecuta y su resultado vuelve como entrada para continuar el flujo; el bridge no fabrica `function_call_output` en la salida de la misma respuesta.
- [Compaction](https://developers.openai.com/api/docs/guides/compaction): la compactación es una operación de continuidad de contexto y debe conservar suficiente estado para que el siguiente turno sea coherente.
- [MCP y conectores](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) y [Skills](https://developers.openai.com/api/docs/guides/tools-skills): las herramientas pueden descubrirse de forma diferida; no todos los clientes las incluyen en `body.tools` desde el primer request.
- [Guía de modelos y reasoning](https://developers.openai.com/api/docs/guides/latest-model): los historiales largos amplifican el coste de repetir prompts y herramientas; las llamadas programáticas deben preservar la vinculación de cada call.

Como referencia de implementación del cliente, el [app-server de OpenAI Codex](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) modela cada turno como varios items persistibles —mensaje, reasoning, ejecución, cambio de archivo, MCP y colaboración— y termina con `turn/completed`. El [proxy Responses de Codex](https://github.com/openai/codex/tree/main/codex-rs/responses-api-proxy) sirve como referencia adicional para separar el transporte del protocolo de aplicación.

## Arquitectura y propiedad de cada decisión

```text
ChatGPT/Codex (Responses + SSE)
        │  auth local separada; no se reenvía su bearer
        ▼
Bridge loopback
  request-translator ─ context-adapter ─ tool-profile
  response-handlers ─ responses-adapter ─ stream transport
        │  Chat Completions v1 + X-Glory-Request-Id
        ▼
GloryAPI proxy
  capabilities ─ health ─ limits ─ sticky ─ fallback ─ traces
        │
        ├─ Andoryyu FreeBuff
        ├─ OpenCode Zen
        └─ OpenCode Go
```

Reglas de frontera:

- El bridge no decide el proveedor, no recibe claves de proveedor y no acepta un proveedor arbitrario en producción.
- La selección temporal por proveedor existe únicamente si `GLORYAPI_CANARY_MODE=1`, el token canary coincide, el modelo tiene un override declarado y la ruta solicitada pertenece a ese override; `auto`, modelos sin override y requests sin modelo fallan cerrado.
- Un stream ya visible no se reintenta en otro proveedor: repetirlo podría duplicar herramientas o texto. El gateway solo hace fallback antes de haber emitido chunks al cliente.
- Las respuestas vacías o solo de reasoning nunca completan el turno. Se intenta una recuperación bounded; si no produce texto visible o tool calls, se emite `response.failed` con `empty_upstream_response`.
- Una respuesta solo con tool calls sí es válida: se emite `function_call` y `end_turn=false`.
- `FALLBACK_REASONING` solo satisface el contrato de mensajes assistant del upstream de thinking; el `responses-adapter` lo filtra de la salida visible y de la caché expuesta al cliente.

## Matriz de proveedores activos

| Proveedor | Adaptador | Particularidad | Evidencia determinista | Evidencia real |
|---|---|---|---|---|
| Andoryyu | OpenAI-compatible | El gateway bufferiza hasta `[DONE]` porque el worker puede truncar streams en cualquier punto. | PASS directo; PASS como primer candidato de fallback. | No ejecutada en esta auditoría. |
| OpenCode Zen | OpenAI-compatible | Normaliza `content: null` y asegura `reasoning_content` en assistant turns de thinking. | PASS directo; PASS como fallback de Andoryyu. | No ejecutada en esta auditoría. |
| OpenCode Go | OpenAI-compatible | Comparte la normalización de reasoning de Zen; es el último recurso configurado. | PASS directo; incluido en la cadena y en capabilities del gateway. | No ejecutada en esta auditoría. |

“PASS directo” significa una petición Responses completa a través del bridge, con el gateway forzado server-side al proveedor correspondiente y un upstream OpenAI-compatible local determinista. No significa que se haya validado cuota, latencia, disponibilidad o formato de una cuenta externa real. Por ello `/capabilities.providerInference` continúa `unverified` fuera del canary.

## Herramientas, agentes, plugins y visión

- **Herramientas declarativas:** function, custom, namespace, `tool_search` y `web_search` se aplanan a Chat Completions y se reconstruyen como `function_call`, `custom_tool_call`, `tool_search_call` o un loop web interno.
- **Perfil `codex-desktop`:** incluye los shims de `mcp__node_repl__js`, `codex_app__automation_update` y aliases de colaboración que algunos builds no anuncian hasta discovery. La deduplicación evita enviar dos funciones con el mismo nombre.
- **Perfil `generic`:** no conoce `node_repl`, automation ni colaboración de Codex; solo usa las herramientas declaradas por el consumidor y el desmangling genérico de namespaces.
- **Agentes:** `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `close_agent` y `update_agent` conservan namespace `collaboration`; el bridge no ejecuta el agente ni inventa su resultado, solo preserva la llamada para que la app la despache.
- **Web:** `web_search` se resuelve internamente como `assistant.tool_calls` → búsqueda bounded → `role=tool` → nueva llamada al modelo. No se descarga una URL arbitraria proporcionada por el modelo y no se fabrica `function_call_output` en `response.output`.
- **Visión:** los `input_image` se validan por MIME y magic bytes y se adaptan a descripción textual. Es una adaptación lossless respecto a seguridad, pero los pixels no llegan al modelo textual; por eso la capability sigue marcada como `adapted`, no como multimodal nativa.
- **Compactación:** la continuidad nominal queda en el cliente; el bridge mantiene una red de seguridad configurable para contexto sobredimensionado y una recuperación acotada para respuestas vacías. No se presenta esa red como sustituto de la compactación nativa.
- El presupuesto de contexto incluye `messages` y schemas serializados de `tools`; el resumen pasa por el mismo transporte bounded que las respuestas normales y usa `BRIDGE_COMPACTION_MODEL` cuando se configura.

## Configuración canónica

Variables principales (todas opcionales y con límites):

- Upstream: `BRIDGE_UPSTREAM_BASE_URL`, `BRIDGE_UPSTREAM_COMPLETIONS_PATH`, `BRIDGE_UPSTREAM_AUTH_SCHEME`, `BRIDGE_MODEL`, `BRIDGE_UPSTREAM_TIMEOUT_MS`, `BRIDGE_UPSTREAM_TIMEOUT_RECOVERY_MS`.
- Streaming: `BRIDGE_STREAM_IDLE_TIMEOUT_MS` (por defecto 180 s) y `BRIDGE_STREAM_TOTAL_TIMEOUT_MS` (por defecto el timeout upstream de 6 min).
- Cliente/herramientas: `BRIDGE_TOOL_PROFILE=codex-desktop|generic`.
- Límites: `BRIDGE_MAX_BODY_BYTES`, `BRIDGE_MAX_ACTIVE_REQUESTS`, `BRIDGE_MAX_SYSTEM_CHARS`, `BRIDGE_UPSTREAM_MAX_BYTES`, `VISION_MAX_RESPONSE_BYTES`.
- Compactación: `BRIDGE_COMPACTION_MODEL` selecciona el modelo de resumen sin cambiar el modelo principal.
- Canario aislado: `GLORYAPI_CANARY_MODE=1`, `GLORYAPI_CANARY_ROUTING_TOKEN`, `BRIDGE_CANARY_MODE=1`, `BRIDGE_CANARY_ROUTING_TOKEN` y el header interno de proveedor generado por el harness. Estos valores no deben aparecer en `config.toml` ni en un despliegue normal.

El bridge escucha loopback por defecto, usa `BRIDGE_CLIENT_TOKEN` para el cliente y una credencial separada para GloryAPI. `C:\Users\Owner\.codex\config.toml` no forma parte de la configuración del bridge y no debe mutarse para esta auditoría.

## Evidencia ejecutada

- `node --test integrations/codex-bridge/test/*.test.cjs`: **86/86 PASS**; `node --test integrations/codex-bridge/test/security/*.test.cjs`: **2/2 PASS**. En conjunto son 88 pruebas: anti-falso-complete, reasoning-only, tool-only, web loop, compactación de seguridad con schemas de herramientas, resumen configurable, UTF-8 fragmentado, truncamiento, cancelación, preflight, perfiles de herramientas, toolset namespaced de plugin/MCP, ronda multi-agente `function_call` → `agent_message` → `function_call_output`, continuidad incompleta/reordenada rechazada, timers de visión limpiados en éxito/fallo, redacción de visión, límites de body, routing canary preservado en reintentos, streams que quedan abiertos después de headers, sanitización allowlist del perfil de plugins con variantes de secretos/fuentes remotas/rutas no canónicas rechazadas, aislamiento de entorno y stop seguro de PID stale.
- `npm run build:server`: **PASS**.
- `npm test -w server`: la evidencia histórica de esta rama es **270/270 PASS** en 47 archivos, incluidos los tres casos de routing canary fail-closed. En la verificación actual no llegó a iniciar por un error de resolución/esbuild del entorno (`Access is denied` al resolver `../../../../..` y no encuentra `server/vitest.config.ts`); se repitió sin modificar la configuración.
- `npm run canary:codex`: **PASS**. Resultado: `readiness`, `lifecycle`, `capabilities`, texto, SSE Responses real (`stream`), continuidad al cambiar entre proveedores (`providerSwitching`), toolset namespaced de plugin/MCP (`pluginTooling`), forwarding aislado del Browser skill con `features.plugins=true`, instalación temporal desde el marketplace local y marcadores distintivos de sus instrucciones (`pluginSkillForwarding`), loop web interno, ejecución real de `shell_command` desde Codex CLI en `CODEX_HOME` temporal (`codexToolExecution`), fallback, foreign toolset sin cooldown, aislamiento y `providerCoverage` directo para `andoryyu`, `opencode-zen` y `opencode-go`.
- E2E HTTP real aislada: los helpers locales resolvieron ambas credenciales en memoria, sin imprimirlas; un bridge temporal en el puerto `4197` contra GloryAPI `:3101` pasó `/ready`, `/health` y `/capabilities` (`200`), una respuesta no streaming (`message`, `200`), una llamada de herramienta (`function_call`, `200`) y una respuesta SSE (`200`, `text/event-stream`, con `response.completed`). No apareció `FALLBACK_REASONING` en ninguna salida. El proceso y su runtime temporal fueron eliminados al terminar.
- E2E HTTP fiel al payload del plugin/navegador de Codex: con `BRIDGE_TOOL_PROFILE=codex-desktop`, namespace `mcp__node_repl`, `tool_search` e instrucciones de Browser, el bridge temporal en `:4198` devolvió `function_call(js)` con HTTP `200`, sin ejecutar la herramienta y sin fallback visible. Una segunda ronda en `:4199` reinyectó el `function_call` y un `function_call_output` sintético para el mismo `call_id`; devolvió `message` con HTTP `200`, también sin fallback visible. Ambos runtimes temporales fueron eliminados.
- Routing vivo observado en la instancia GloryAPI existente: las peticiones autenticadas de texto y tools devolvieron `X-Routed-Via: opencode-go/deepseek-v4-flash` con HTTP `200`. Esto confirma una ruta real disponible, pero no se interpreta como prueba de salud simultánea de los tres proveedores; esa atribución continúa cubierta por el canary aislado y la capability pública permanece `unverified` fuera de él.
- Matriz real por proveedor en un runtime GloryAPI canary temporal, con DB DPAPI clonada y sin cambiar ChatGPT: Andoryyu devolvió `429` en no-stream y SSE `response.failed`; OpenCode Zen tuvo el mismo estado; OpenCode Go devolvió `200` con `message` y SSE `response.completed`. Las rondas forzadas no hicieron fallback por diseño del header canary, no mostraron `FALLBACK_REASONING`, no dejaron `response.completed` falso y todos los procesos/snapshots temporales fueron eliminados. Esto registra disponibilidad/cuota real de esa ventana, no convierte los dos `429` en un defecto del bridge ni permite declarar los tres proveedores sanos simultáneamente.
- Fallback real normal, sin modo canary, en otro runtime temporal con la misma DB DPAPI: no-stream y SSE devolvieron `200`, `X-Routed-Via: opencode-go/deepseek-v4-flash` y `X-Fallback-Attempts: 2`; el SSE terminó con `data: [DONE]` y sin `stream_error`. Esto confirma dos intentos de fallback hasta Go; los `429` concretos de Andoryyu/Zen fueron medidos por separado en el canary forzado. Junto con la E2E no-canary del bridge (`message` y SSE `response.completed`), respalda la continuidad del sidecar durante el fallback, sin atribuir individualmente los dos intentos normales.
- Los scripts E2E con prefijo `_e2e_` no se incluyen en el baseline automático porque requieren un bridge ya activo en `:4100`; el archivo ajeno `_e2e_apply_patch.cjs` se preserva sin modificar.
- El bridge queda detenido después de las pruebas. ChatGPT normal permanece activo y la configuración del usuario no se cambia.

El canary de plugin lee `config.chatgpt.toml` solo para extraer por allowlist el
marketplace local `openai-bundled`, el plugin habilitado
`browser@openai-bundled` y las opciones seguras de `[features]`; instala el
plugin únicamente en un `CODEX_HOME` temporal. Rechaza claves desconocidas y
variantes sensibles como `bearer`, `access_token`, `api_key`, `client_secret`,
`authorization`, `mcp_servers`, `notify` o `CODEX_HOME` antes de escribir. El
canary confirma que el Browser skill y su herramienta Node atraviesan el bridge,
pero no se presenta como prueba del runtime integrado de plugin/MCP en Desktop.

## Riesgos residuales y criterio de cierre

La compatibilidad de protocolo y el routing canary están respaldados. La E2E HTTP real contra el GloryAPI autenticado confirma el contrato vivo del bridge, pero no identifica por sí sola qué proveedor terminó atendiendo cada request ni sustituye una sesión desde la aplicación Desktop. Ese cierre requiere, en una ventana explícita y reversible, un perfil canary separado y una conversación nueva que pruebe stream, tools, MCP/plugin, colaboración, visión, compactación, cancelación, cambio de proveedor y rollback. Mientras esa evidencia no exista, el estado correcto es **bridge vivo probado / proveedor individual y Desktop E2E no verificados**, no un PASS absoluto.
