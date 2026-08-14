# Bridge local de Codex para GloryAPI

`bridge/` es la única carpeta física del bridge. La ruta esperada por Codex,
`%USERPROFILE%\.codex\bridge`, es un junction de Windows hacia esa carpeta: no hay
copia instalada ni paso de sincronización.

## Estructura del bridge

`server.js` es únicamente el entrypoint y el orquestador del proceso. La lógica está separada por
responsabilidad para poder probarla y sustituir el proveedor sin editar el servidor:

- `config.js`: configuración normalizada desde variables de entorno, límites, timeouts, contratos y defaults.
- `request-translator.js`: Responses → Chat Completions, herramientas, namespaces y mensajes históricos.
- `context-adapter.js`: límites de contexto (incluidos schemas de tools), compactación de seguridad, calibración, modelo de resumen configurable y recuperaciones de cierre.
- `responses-adapter.js`: serialización Chat Completions → Responses/SSE y routing de tool calls.
- `upstream-adapter.js`: transporte al proveedor, timeouts total/idle de streaming, recuperación de respuestas vacías y web loop.
- `response-handlers.js`: paths streaming y non-streaming, con la misma política de recuperación.
- `tool-profile.js`: perfiles de compatibilidad `codex-desktop` y `generic`; los shims de MCP/automation/colaboración no están en el núcleo.
- `vision.js` y `reasoning-cache.js`: adaptaciones y cachés persistentes aislados.
- `http-server.js`: endpoints HTTP, autenticación local, readiness, lifecycle y shutdown graceful.
- `responses-schema.js`: contrato de entrada `glory-responses-request-v1`, con límites de items,
  tools y contenido antes de traducir.
- `redaction.js`, `atomic-json.js` y `metrics.js`: redacción estructurada, estado JSON acotado/atómico
  y métricas metadata-only con muestras bounded.

La configuración prioriza aliases agnósticos y mantiene compatibilidad con `GLORY_*`/`FREEL_*`:
`BRIDGE_UPSTREAM_BASE_URL`, `BRIDGE_UPSTREAM_COMPLETIONS_PATH`, `BRIDGE_UPSTREAM_API_KEY`,
`BRIDGE_UPSTREAM_AUTH_SCHEME`, `BRIDGE_MODEL`, `BRIDGE_HOST`, `BRIDGE_PROVIDER_NAME` y
`BRIDGE_UPSTREAM_CONTRACT`. Los límites y políticas siguen siendo configurables mediante las variables
`BRIDGE_*` documentadas en este archivo. El bridge continúa escuchando en loopback por defecto y
apunta a un upstream OpenAI-compatible por defecto; cambiar de proveedor no requiere editar adapters.

`BRIDGE_CAPABILITY_MATRIX_JSON` permite declarar combinaciones cliente/adapter/provider/modelo sin editar
el código; los estados de soporte siguen siendo calculados por el bridge y nunca se aceptan desde ese JSON.

`BRIDGE_MODEL_CATALOG_JSON` permite reemplazar el catálogo de modelos del selector sin tocar código.
Cada entrada es `{ id, pickerId?, provider, displayName, nativeVision, contextWindow }`; `pickerId` es
opcional y solo sirve como alias compatible con el filtro del renderer de Desktop. El bridge siempre lo
traduce al `id` real antes de enviar la solicitud. El esquema versionado es
`glory-bridge-model-catalog-v2` (ver `model-catalog.js`). El bridge siempre conserva la entrada `auto`.

El contrato de entrada se identifica como `BRIDGE_REQUEST_SCHEMA=glory-responses-request-v1`. Los campos
de extensión desconocidos se toleran, pero tipos conocidos inválidos fallan cerrado con una ruta estructural
sanitizada.

El perfil de herramientas se elige con `BRIDGE_TOOL_PROFILE=codex-desktop|generic`. El primero mantiene los
shims necesarios para builds de Codex Desktop que descubren tarde algunas herramientas; `generic` solo reenvía
las herramientas anunciadas por el cliente. `BRIDGE_TOOL_SEARCH_MODE=direct|client` controla el descubrimiento
diferido: por defecto `codex-desktop` usa `direct` para evitar bucles cuando el cliente vuelve a solicitar
`tool_search` sin descubrir ninguna herramienta, y `generic` conserva `client` para clientes que gestionan ese
protocolo. `BRIDGE_TOOL_SEARCH_DIRECTIVE` permite personalizar la instrucción que recibe el modelo en modo
directo. El transporte streaming acepta además `BRIDGE_STREAM_IDLE_TIMEOUT_MS`
(180 s por defecto) y `BRIDGE_STREAM_TOTAL_TIMEOUT_MS` (6 min por defecto); ambos deadlines cubren también el
body después de recibir headers.

Los scripts `codex-mode.ps1`, `switch-chatgpt.ps1` y `switch-deepseek.ps1` tienen su
única fuente física en `mode/`. Sus rutas conocidas en `%USERPROFILE%\.codex` son
enlaces simbólicos hacia esos archivos; siguen ejecutándose con los mismos nombres y
también quedan listos para versionarse en el fork personal. En este clon permanecen
sin commit por indicación del usuario.

## Contrato y estado

- Expone Responses en `127.0.0.1:4100` y traduce al endpoint Chat Completions de
  GloryAPI.
- `/health` devuelve `service=gloryapi-codex-bridge`, versión y modelo para que los
  scripts distingan el bridge de cualquier otro proceso en el puerto, sin revelar
  el upstream.
- `/ready` y `/capabilities` requieren el token local y validan el contrato
  `chat-completions-v1`, credenciales y versiones antes de aceptar tráfico. Su
  respuesta es metadata-only y no incluye prompts, URL upstream ni secretos.
- `/lifecycle` expone el contrato versionado `glory-codex-lifecycle-v1`: `starting`,
  `ready`, `blocked`, `draining` y `stopped`. Solo `ready` acepta inferencia; el
  shutdown rechaza solicitudes nuevas, drena las activas y fuerza el cierre tras
  un límite acotado. `/capabilities` publica el mismo estado por combinación
  cliente/adapter/modelo bajo `glory-codex-capabilities-v2`.
- `/diagnostics` requiere el token local y expone únicamente schema, lifecycle y percentiles
  metadata-only bounded; `/health` sigue siendo liveness mínimo.
- La búsqueda web se resuelve mediante un bucle interno conforme al patrón de function
  calling: llamada upstream, `assistant.tool_calls`, búsqueda, mensaje `role=tool` y
  segunda llamada upstream. Antes de cerrar cualquier respuesta final con tools
  disponibles, el mismo bucle aplica una confirmación acotada: si el modelo aún
  tiene trabajo devuelve la herramienta visible que falta; si terminó responde
  `ok` y se conserva el resumen original. Esto no depende de una frase concreta
  de intención. Codex Desktop recibe la respuesta final; el bridge no fabrica un
  `function_call_output` dentro de `response.output`.
- La descarga de URLs arbitrarias está deshabilitada para evitar SSRF. Los resultados
  de búsqueda se marcan como contenido web no confiable.

## Selector de modelos y visión nativa

El selector es el picker de modelos de la aplicación Codex Desktop, que consume
`/v1/models` del bridge y envía el `model` elegido en el body de cada request
Responses. En versiones de Desktop que filtran los IDs de proveedores personalizados, el catálogo local
usa `pickerId` con IDs reconocidos por ese renderer; el nombre visible sigue indicando el proveedor real.
El bridge no crea una UI paralela: resuelve `body.model` contra el
catálogo versionado `glory-bridge-model-catalog-v2` y lo traduce al modelo wire
que GloryAPI enruta.

- `auto` (o modelo ausente) conserva el comportamiento anterior: envía
  `deepseek-v4-flash` y GloryAPI aplica su cadena de fallback existente.
- Selección explícita: el bridge envía el id exacto del modelo elegido. Los dos
  modelos CommandCode disponibles quedan fijados a su propio proveedor en GloryAPI
  (`deepseek/deepseek-v4-flash` y `meta/muse-spark-1.2-contributor`); el modelo Pro fue
  retirado y ya no se publica ni se enruta; un fallo devuelve error estructurado visible y
  nunca salta silenciosamente a otro proveedor gratuito.
- Los modelos CommandCode son explicit-only: no entran en la cadena `auto` de
  GloryAPI para no gastar crédito sin selección expresa.
- Esfuerzo de razonamiento: el selector de Codex envía `reasoning.effort` y el
  bridge lo traduce a `reasoning_effort` (`low`, `medium`, `high` o `max`). Muse
  Spark 1.2 declara soporte, así que `Alto` llega a CommandCode como
  `reasoning_effort: "high"`; el servidor conserva sus límites por proveedor y
  modelo. TokenHarbor declara que no lo soporta y no recibe ese parámetro.
- Visión nativa: cuando el modelo elegido está marcado `nativeVision: true` en el
  catálogo (Muse Spark 1.2 Contributor, multimodal), el bridge reenvía el bloque
  `image_url` validado al upstream para que el modelo vea la imagen directamente.
  El resto de modelos conservan la adaptación lossy a texto (el modelo de visión
  describe la imagen). Una imagen inválida bajo visión nativa produce una nota de
  diagnóstico explícita; nunca se descarta en silencio ni se interpreta como
  "carpeta vacía".
- La credencial de CommandCode se guarda con el flujo seguro existente de GloryAPI
  (`api_keys` + DPAPI `CurrentUser`) mediante `POST /api/keys` con
  `platform: "commandcode"`; el bridge nunca conoce ni reenvía esa clave.

## Seguridad por defecto

- No hay claves embebidas. El sidecar exige `BRIDGE_CLIENT_TOKEN` para
  Codex→sidecar y usa por separado `GLORY_API_KEY` (o `FREEL_API_KEY` transitorio)
  para sidecar→GloryAPI; nunca reenvía ciegamente el bearer del cliente.
  Visión admite `VISION_API_KEY` o un endpoint anónimo explícitamente habilitado con
  `VISION_ALLOW_ANONYMOUS=1`. Se pueden configurar rutas alternativas en
  `VISION_FALLBACKS_JSON`; cada entrada usa `baseUrl`, `model`, `completionsPath`
  opcional, `allowAnonymous` y `apiKeyEnv` para que las claves sigan fuera del JSON.
  El launcher usa por defecto la clave DPAPI local de `opencode-go` como fallback para
  `mimo-v2.5`, si existe una credencial habilitada.
- No se habilita CORS para navegadores.
- El cuerpo se limita a 8 MiB, configurable con `BRIDGE_MAX_BODY_BYTES`.
- Cada respuesta de backend de búsqueda se limita a 1 MiB, configurable con
  `BRIDGE_SEARCH_MAX_BYTES`.
- El timeout de cada request upstream (web loop interno y non-streaming) es de 6 min
  por defecto, configurable con `BRIDGE_UPSTREAM_TIMEOUT_MS` (rango 100-600000 ms).
  Si un request aborta por timeout, se reintenta UNA vez con la ventana extendida
  `BRIDGE_UPSTREAM_TIMEOUT_RECOVERY_MS` (default 720000 = 2×, rango 1000-1200000 ms)
  y se registra `kind: 'upstream_timeout_retry'` en el log; si el reintento también
  falla, el bridge responde `response.failed` (el cliente muestra "stream
  disconnected before completion"). Esto evita cortar la conexión cuando un round
  con contexto grande (100k+ tokens, prefix cache 0) excede el timeout base aunque
  el modelo esté trabajando.
- El resumen de compactación reutiliza el transporte upstream bounded: conserva timeout
  durante el body, límite de bytes, `request-id` y directiva canary; `BRIDGE_COMPACTION_MODEL`
  permite separarlo del modelo principal.
- El path streaming tiene un deadline total separado y un deadline idle por frame. Si
  el upstream entrega headers pero no vuelve a producir SSE, el bridge aborta el fetch
  y emite `response.failed`; no deja el turno esperando indefinidamente. El idle y el
  total se configuran con `BRIDGE_STREAM_IDLE_TIMEOUT_MS` y
  `BRIDGE_STREAM_TOTAL_TIMEOUT_MS`.
- Visión y búsqueda web mantienen sus deadlines durante la lectura de respuestas y
  aplican límites de body (`VISION_MAX_RESPONSE_BYTES` y `BRIDGE_SEARCH_MAX_BYTES`).
- Una respuesta del proveedor con `tool_calls` sin texto es una continuación válida:
  el bridge emite los `function_call` y `response.completed` lleva `end_turn=false`.
  El `FALLBACK_REASONING` usado solo para satisfacer DeepSeek en mensajes históricos
  se filtra y nunca se devuelve como razonamiento visible al cliente.
- El `reasoning_content` real del proveedor se adapta a un resumen Responses con
  `response.reasoning_summary_part.added` y
  `response.reasoning_summary_text.delta`; no se expone la cadena de pensamiento
  cruda ni el texto sintético de fallback. La ruta no streaming también incluye
  el resumen como un item `reasoning`.
- La auditoría de cierre es adaptativa y configurable con
  `BRIDGE_AUDIT_MODE=adaptive|strict|off` (por defecto `adaptive`). `adaptive`
  solo audita turnos ambiguos con herramientas disponibles; `strict` audita cada
  respuesta textual elegible y `off` desactiva esta capa. `BRIDGE_AUDIT_ENABLED=0`
  conserva compatibilidad y también la desactiva. La auditoría envía únicamente
  un pedido y una respuesta acotados, sin historial ni schemas de herramientas.
  La decisión usa el último mensaje real del usuario conservado antes de
  fusionar mensajes consecutivos; el contexto inyectado por Desktop no puede
  convertir un saludo o una prueba simple en una acción pendiente.
  Solo si responde `COMPLETE`/`ok` se evita el reenvío completo; cualquier otra
  decisión intenta una continuación real con el contexto necesario.
- Auditoría y continuación comparten el presupuesto de
  `BRIDGE_NUDGE_BUDGET_MS` (120 s por defecto, máximo 300 s). La auditoría queda
  limitada además por `BRIDGE_NUDGE_TIMEOUT_MS` para dejar tiempo a la acción.
  `BRIDGE_NUDGE_MAX_ATTEMPTS` (3, máximo 3),
  `BRIDGE_NUDGE_TIMEOUT_RECOVERY_MS` y `BRIDGE_AUDIT_MAX_CHARS` acotan las
  rondas, la espera y el tamaño. Un timeout, error o respuesta no confirmatoria
  nunca se convierte en `response.completed`: streaming emite `response.failed`
  recuperable y non-streaming devuelve error estructurado.
- Cada solicitud lleva telemetría interna (`main`, `audit`, `continuation`,
  `recovery` o `auxiliary_title`) y una relación con el request principal. La
  página Analytics muestra esa separación y los tokens cacheados que entregue
  el proveedor, sin guardar prompts ni claves. También conserva el esfuerzo de
  razonamiento solicitado y los tokens de razonamiento cuando el proveedor los
  devuelve; si solo hay deltas de streaming, los marca como `estimados`, y si
  no hay ninguna señal los marca como `no confirmado`. Para CommandCode, el
  bridge solicita el uso final del stream (`stream_options.include_usage`) y
  GloryAPI no acepta un cero provisional como prueba de razonamiento.
- La generación automática de título de Desktop se reconoce por su contrato
  estructurado estricto (`codex_output_schema` con `title` y `description`) y
  por el alias configurable de título (`BRIDGE_TITLE_MODEL_ALIASES`, por
  defecto `gpt-bridge-auto`). Se responde localmente respetando ese JSON schema y
  con cero tokens; no se compara su prompt con el turno visible
  porque Desktop ejecuta el título en un thread interno distinto. Los demás
  modelos del selector no se consideran auxiliares por defecto.
- Una respuesta vacía o solo de razonamiento no cierra el turno. El bridge hace
  como máximo una recuperación acotada (`BRIDGE_EMPTY_RECOVERY_RETRIES`, por defecto
  1; timeout `BRIDGE_EMPTY_RECOVERY_TIMEOUT_MS`, 90 s) con una directiva explícita;
  si tampoco hay texto final ni tools, devuelve `response.failed` con
  `empty_upstream_response` y registra `empty_recovery_*`.
- Una respuesta que mezcle herramientas web internas con herramientas que debe
  ejecutar el cliente tampoco cierra el turno en el primer intento. El bridge
  ejecuta primero las llamadas web, conserva sus resultados en el historial
  interno, compacta el contexto si el modo de emergencia lo necesita y envía
  una directiva para que el modelo reemita solo las llamadas del cliente.
  `BRIDGE_MIXED_TOOL_RECOVERY_RETRIES` controla el límite (1 por defecto, máximo
  2). Si el modelo vuelve a mezclar después del límite, se emite un error
  explícito `web_loop_error` y se registra `mixed_tool_recovery_exhausted`; esto
  evita el cierre prematuro sin permitir bucles infinitos.
- El bucle web tiene `BRIDGE_WEB_TOOL_ROUNDS` (3 por defecto) más las rondas de
  recuperación mixta. Si alcanza ese límite después de ejecutar una búsqueda,
  el bridge elimina las herramientas web y hace una última síntesis acotada con
  los resultados ya obtenidos. Así un modelo que insiste en buscar no corta el
  turno útilmente; si vuelve a pedir web en esa síntesis, se devuelve un error
  recuperable `web_tool_limit_recovery_exhausted` para impedir un bucle infinito.
- Las cachés persistentes tienen TTL y límite de bytes; se escriben con `fsync`/rename y
  no conservan el reasoning sintético.
- La visión lossy (texto) no se anuncia en `/capabilities` ni en `/v1/models` sin
  configuración explícita y probe de salud aprobado; cada intento valida todas las
  respuestas DNS y bloquea rangos privados. La conexión usa el conjunto de direcciones
  ya validado como `lookup` fijado, conserva SNI para HTTPS y no sigue redirects. La
  visión nativa (bloques `image_url`) no depende del modelo de visión: solo se activa
  para modelos del catálogo marcados como multimodales y reutiliza la validación de
  imagen bounded (MIME + magic bytes + 8 MiB).
- Si una ruta devuelve `429`, el bridge conserva sus reintentos acotados y prueba la
  siguiente ruta configurada. Si todas fallan, el modelo recibe un diagnóstico explícito
  de que la imagen sí llegó pero no pudo describirse; nunca se transforma en “carpeta vacía”.
- La red de seguridad de contexto compacta antes cuando la autocompactación nativa
  no actuó (`BRIDGE_COMPACTION_SAFETY_FACTOR=1.25` por defecto), y el system prompt
  reenviado queda limitado a 120000 caracteres (`BRIDGE_MAX_SYSTEM_CHARS`). Ambos
  límites siguen siendo configurables.
- `bridge.requests.log` guarda metadatos; los errores remotos conservan solo clase,
  status y tamaño. El cuerpo completo
  solo se habilita conscientemente con `BRIDGE_REQUEST_LOG_FULL=1`.
- El archivo rota al superar `BRIDGE_REQUEST_LOG_MAX_BYTES` (4 MiB por defecto) y
  conserva `BRIDGE_REQUEST_LOG_RETENTION` rotaciones (3 por defecto).
- Las escrituras son asíncronas y la cola está limitada por
  `BRIDGE_REQUEST_LOG_QUEUE_CAPACITY` (64 por defecto); cuando se satura se
  descartan entradas metadata-only y se contabiliza el drop. Una entrada mayor
  que el presupuesto se degrada a un registro de tamaño, no aumenta el archivo.
- `stop-bridge.ps1` valida PID, ejecutable y ruta de `server.js` antes de detener.

## Autenticación separada

Configura ambos secretos fuera del repositorio y del TOML de Codex:

```text
BRIDGE_CLIENT_TOKEN=<token efímero para el cliente local>
GLORY_API_KEY=<clave unificada de GloryAPI>
```

La ausencia de cualquiera produce un fallo cerrado: `/v1/responses` devuelve `401`
si el token del cliente no coincide y `503` si no existe credencial configurada para
GloryAPI o el lifecycle no está en `ready`. `/health` sigue siendo una comprobación
mínima de identidad/liveness; `/lifecycle` requiere auth para exponer estado operativo.

El token local se crea/rota dentro de la bóveda DPAPI de GloryAPI:

```powershell
npm run build:server
node .\server\dist\scripts\bridge-auth.js --rotate
node .\server\dist\scripts\bridge-auth.js --metadata
```

`integrations/codex-bridge/mode/get-codex-auth.ps1` es el comando que debe usar la
configuración `auth` de Codex; emite únicamente el token y nunca lo escribe en TOML,
logs o documentación. `start-bridge.ps1` lo resuelve automáticamente cuando
`BRIDGE_CLIENT_TOKEN` no está presente.

La credencial sidecar → GloryAPI se resuelve primero desde `GLORY_API_KEY` o
`FREEL_API_KEY`; si no están en el entorno, `start-bridge.ps1` usa el helper
token-only `server/dist/scripts/bridge-upstream-auth.js`, que lee `unified_api_key`
en modo SQLite `readonly`. El helper nunca imprime el valor salvo con `--print`
para entregarlo directamente al proceso del bridge y no lo persiste en archivos.
`unified_api_key` ya está migrada a `local_auth_tokens` con DPAPI `CurrentUser`;
el helper solo acepta esa fila DPAPI y falla cerrado si falta. La base operativa
se guarda por defecto fuera del repositorio en `%USERPROFILE%\.gloryapi\gloryapi.db`;
`GLORYAPI_DB_PATH` o `-DatabasePath` permiten seleccionar otra ruta persistente.
El helper abre SQLite en modo `readonly` y no tiene código de escritura.
Antes de iniciar el sidecar, el mismo script levanta el runtime local de GloryAPI
en 3101 mediante `start-gloryapi.ps1` si `/api/ping` aún no responde.

`start-gloryapi.ps1` arranca el runtime con un entorno aislado: nunca hereda
`BRIDGE_CLIENT_TOKEN`, `GLORY_API_KEY`, `FREEL_API_KEY` ni `BRIDGE_RUNTIME_DIR`.
El bridge se lanza después con un entorno explícito que contiene únicamente sus
dos tokens, el puerto, el contrato y las variables mínimas de Node/Windows.
El test `environment-isolation.test.cjs` captura el entorno real del proceso
hijo y exige que las tres credenciales estén ausentes.

## Reinicio del bridge

Un solo comando detiene el bridge actual (si existe), espera a que el puerto quede
libre, lo inicia con el build actual y verifica `/health`:

```powershell
.\restart-bridge.ps1            # reinicia solo el bridge
.\restart-bridge.ps1 -Runtime   # además reinicia el runtime GloryAPI :3101
.\restart-bridge.ps1 -Force     # sustituye también un proceso ajeno en :4100
.\restart-bridge.ps1 -RuntimeDataDir "$env:TEMP\gloryapi-bridge-runtime" # runtime/logs fuera de server/data
```

El mismo mecanismo está disponible sin el wrapper:

```powershell
.\start-bridge.ps1 -Restart     # detiene el bridge actual y lo inicia de nuevo
.\start-bridge.ps1 -RuntimeDataDir "$env:TEMP\gloryapi-bridge-runtime" -Port 4100
```

Detalles de robustez:

- `stop-bridge.ps1` acepta `-Force` y, tras detener, espera (`-WaitReleaseSeconds`,
  por defecto 10 s) a que `:4100` deje de escuchar; así un `start` inmediato no
  falla por la carrera clásica de "puerto todavía ocupado".
- `start-bridge.ps1 -Restart` detiene el bridge con la misma validación de
  identidad (PID + `server.js`) y reintenta el stop si el puerto sigue ocupado.
  Sin `-Restart` mantiene su comportamiento anterior: no sustituye nada y avisa
  con un mensaje que apunta al nuevo conmutador.
- `restart-bridge.ps1 -Runtime` detiene el runtime solo si el proceso coincide con
  `server/dist/index.js`; un ocupante ajeno en `:3101` exige `-Force`.
- `start-bridge.ps1`, `stop-bridge.ps1` y `restart-bridge.ps1` aceptan
  `-RuntimeDataDir`, `-DatabasePath` y `-Port`; los defaults son
  `%USERPROFILE%\.gloryapi\runtime\bridge-runtime`,
  `%USERPROFILE%\.gloryapi\gloryapi.db` y `4100`. Esto permite ejecutar el bridge
  en una carpeta temporal o con otra instancia local sin editar el perfil de
  ChatGPT ni mover credenciales a archivos.
- `start-bridge.ps1` verifica siempre `/api/ping` de GloryAPI antes de salir por
  el camino rápido de bridge ya existente; si `:3101` fue cerrado, lo recupera
  automáticamente. Esto también aplica al acceso directo del modo bridge.
- `stop-bridge.ps1 -Force` no convierte un PID stale en permiso para matar un
  proceso: si CIM no puede verificar la línea de comandos, exige además que el
  PID figure escuchando en el `-Port` solicitado; de lo contrario falla cerrado.

## Dos historiales aislados: ChatGPT normal y bridge

El modo normal sigue usando `%USERPROFILE%\.codex`. El bridge usa por defecto
`%USERPROFILE%\.codex-gloryapi`, con su propia base SQLite, historial, logs y perfiles. El preparador
conserva la configuración normal en `normal-base.config.toml` y genera un `config.toml` bridge-específico;
no copia `auth.json`, `state_*.sqlite` ni conversaciones. Así se pueden mantener abiertas ambas sesiones
sin que una cambie el historial de la otra.

Para abrir la sesión bridge en una ventana separada:

```powershell
.\mode\switch-deepseek.ps1
```

También se puede preparar sin abrirla todavía, o usar la modalidad CLI/TUI:

```powershell
.\mode\prepare-isolated-home.ps1 -RefreshConfig
.\mode\start-codex-bridge.ps1 -PrepareOnly
.\mode\start-codex-bridge.ps1
```

`-RefreshConfig` actualiza únicamente la copia de configuración base del home aislado y regenera el
catálogo de modelos que usa el selector de Desktop. El home
normal no se sobrescribe. `-BridgeHome`, `-SourceCodexHome`, `-ProfileName` y `-BridgePort` permiten
adaptar la instalación sin editar el script. La modalidad `-Desktop` abre directamente `ChatGPT.exe` con un
`--user-data-dir` y un `--profile` propios para evitar reutilizar la instancia gráfica normal. Si la
instalación de Desktop no está disponible, usa el fallback Codex y puede requerir CLI/TUI.

`switch-chatgpt.ps1` detiene el bridge sin tocar el `config.toml` ni el historial normal. Para la
restauración global del flujo antiguo existe una opción deliberadamente explícita:
`codex-mode.ps1 -Mode chatgpt -LegacyGlobalConfig`. El historial del bridge queda en
`%USERPROFILE%\.codex-gloryapi` para retomarlo después.

## Perfil temporal de canary

Para preparar una prueba real sin tocar el perfil principal:

```powershell
.\mode\prepare-canary-profile.ps1
codex --profile gloryapi-canary
```

El script escribe únicamente `%CODEX_HOME%\gloryapi-canary.config.toml`, usa
`model_providers.<id>.auth.command` y no contiene `experimental_bearer_token` ni
ningún secreto. No reemplaza `config.toml`; `-Force` solo permite regenerar ese
perfil temporal. El rollback es seleccionar el perfil ChatGPT y detener el bridge.
`npm run canary:codex` provisiona por sí mismo una DB SQLite, una `CODEX_HOME`,
credenciales token-only y puertos loopback temporales; arranca GloryAPI y el bridge,
y cierra conexiones keep-alive antes de eliminar el runtime. Usa un upstream local
determinista y ahora prueba rutas directas a Andoryyu, OpenCode
Zen y OpenCode Go, continuidad de historial y de una llamada de herramienta al cambiar
de Andoryyu a Go, además de un `codex app-server` aislado con turnos, `shell_command` y
compaction, y el fallback; no cambia la configuración activa ni demuestra
disponibilidad de las cuentas externas. Una ejecución verificada terminó en 28,5 s
con código 0 después de corregir el cierre bounded del upstream temporal.

Para repetir una auditoría contra las cuentas reales sin activar Desktop, se puede
proporcionar explícitamente una ruta de base SQLite y ejecutar:

```powershell
$env:GLORYAPI_LIVE_DB_PATH = 'C:\ruta\externa\gloryapi.db'
npm run canary:codex:live
Remove-Item Env:GLORYAPI_LIVE_DB_PATH
```

El auditor usa `better-sqlite3.backup()` hacia una carpeta temporal, inicia un
GloryAPI y un bridge temporales en loopback, ejecuta una ronda normal y rondas
forzadas por cada proveedor, y lee `/api/fallback/traces` autenticado. Solo emite
estado HTTP, clasificación y metadatos acotados por intento; un `429` externo se
registra como observación y no se interpreta como fallo del bridge. No lee ni
modifica `config.toml`, no hereda credenciales del proceso hacia los servicios
temporales y elimina la copia SQLite y los procesos al finalizar.

## Enlace local

La instalación se comprueba con:

```powershell
Get-Item "$env:USERPROFILE\.codex\bridge" | Select-Object LinkType, Target
```

Debe devolver `LinkType = Junction` y apuntar a esta carpeta `bridge/`. Si el
repositorio se mueve, se recrea el junction; nunca se copia `server.js`.

Los scripts de modo se comprueban con:

```powershell
Get-Item "$env:USERPROFILE\.codex\*-*.ps1", "$env:USERPROFILE\.codex\codex-mode.ps1" |
  Select-Object Name, LinkType, Target
```

Antes de cualquier cambio de modo se ejecuta el preflight de activación, que es de
solo lectura y termina con código distinto de cero si falta un enlace, el perfil no
usa Responses en 4100 con `auth.command` DPAPI canónico o el bridge no responde con
su identidad esperada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\mode\codex-activation-preflight.ps1 -Json
```

El resultado versionado es `glory-codex-activation-preflight-v1`; no imprime tokens,
argumentos completos ni cuerpos de respuesta. Tras el cutover local del 2026-08-10
devuelve `ready=true`: los cuatro enlaces apuntan a GloryAPI, el perfil usa Responses
en 4100 y el bridge/runtime pasan health y readiness. El preflight sigue siendo de
solo lectura y no activa ni repunta nada por sí mismo.

El controlador `mode/codex-mode.ps1` comprueba la existencia del launcher aislado antes de abrir
DeepSeek y se detiene sin modificar `config.toml`. Para revisar el resultado sin mutar nada:

```powershell
.\mode\codex-mode.ps1 -Mode deepseek -Preview
```

El preflight histórico sigue disponible para auditorías del bridge, pero no forma parte del cambio
de proveedor del home normal. El launcher aislado valida que sus dos `CODEX_HOME` sean distintos
antes de ejecutar Codex.

El preflight también comprueba dos prerrequisitos de runtime que antes solo se
detectaban después de intentar arrancar: los helpers compilados de auth y la
presencia de una credencial upstream en el entorno o en la bóveda local. Solo
informa presencia/ausencia; nunca imprime ni persiste el valor. Por tanto,
`-SkipHealth` ya no puede dar un falso "listo" cuando el bridge no puede resolver
su token DPAPI ni la clave unificada.

## Runbook de cutover (solo documental; Desktop E2E pendiente)

La operación local del 2026-08-10 siguió este orden reversible:

1. Registrar hashes de `config.toml`, `config.chatgpt.toml`, los cuatro enlaces y
   cualquier journal existente; detener la operación si falta el snapshot.
2. Ejecutar este preflight desde la fuente GloryAPI; devolvió `ready=true` sin
   `target-not-gloryapi`, perfil legacy ni secretos bearer.
3. Alinear los cuatro enlaces con GloryAPI mediante una operación explícita y
   verificable; no editar ni copiar `freellmapi`.
4. Generar el perfil temporal `gloryapi-canary`, iniciar el bridge con identidad
   `gloryapi-codex-bridge` y repetir `/health`, `/ready` y `/capabilities`.
5. Ejecutar el canary aislado: SQLite temporal, puertos loopback, helper DPAPI
   token-only y cobertura directa de los tres proveedores más fallback. El E2E de
   Codex Desktop con una conversación nueva, incluyendo stream, tools, web y rollback,
   sigue pendiente.
6. Para revertir: detener el bridge, restaurar ChatGPT desde el snapshot hashado,
   comprobar que los enlaces y el modo coinciden con el snapshot y registrar la
   evidencia final.

La E2E HTTP aislada del 2026-08-11 ya fue ejecutada sin activar ningún perfil de
ChatGPT: un bridge temporal en `:4197`, contra el GloryAPI autenticado en `:3101`,
pasó `/ready`, `/health`, `/capabilities`, una respuesta no streaming, una llamada
`function_call` y una respuesta SSE con `response.completed`. El resultado no
contuvo `FALLBACK_REASONING`; el proceso y el runtime temporal se eliminaron al
finalizar. Esto valida el contrato vivo del bridge, pero no sustituye una prueba
desde Codex Desktop ni identifica por sí sola el proveedor final.

La prueba fiel del payload de Browser/plugin también se ejecutó en `:4198` y
`:4199` con `BRIDGE_TOOL_PROFILE=codex-desktop`: la primera ronda produjo
`function_call(js)` y la segunda reinyectó su `function_call_output` sintético,
obteniendo un `message`, siempre con HTTP `200` y sin mostrar
`FALLBACK_REASONING`. No se ejecutó ninguna herramienta real. La instancia
GloryAPI existente observó además `X-Routed-Via:
opencode-go/deepseek-v4-flash` para texto y tools; esto demuestra una ruta real
disponible, no la salud simultánea de los tres proveedores.

La matriz real aislada por proveedor registró además: Andoryyu y OpenCode Zen
respondieron `429` en no-stream y `response.failed` en SSE; OpenCode Go pasó
ambos casos (`message` y `response.completed`). El header canary restringe la
ronda a un proveedor y por eso no hace fallback en ese ensayo; la operación
normal mantiene el fallback configurado. Una prueba normal separada confirmó
`X-Fallback-Attempts: 2`, `X-Routed-Via: opencode-go/deepseek-v4-flash` y
terminación SSE `[DONE]` sin `stream_error`. Los `429` son disponibilidad/cuota
de esa ventana, no un cierre falso del bridge, y el capability de proveedor
sigue en `unverified` hasta una ventana estable.

El snapshot histórico de rollback puede existir en `%USERPROFILE%\.codex\gloryapi-cutover.rollback.*.json`.
En la operación actual ChatGPT normal es la ruta activa y el bridge queda detenido después
de las pruebas; no se debe ejecutar un switch para esta auditoría.

## Validación sin activar DeepSeek

```powershell
node --check .\bridge\server.js
$files = Get-ChildItem .\bridge, .\mode -Filter *.ps1
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $file.FullName, [ref]$tokens, [ref]$errors
  ) | Out-Null
  if ($errors) { throw $errors }
}
```

No se debe anunciar compatibilidad E2E con Codex Desktop hasta probar el flujo real:
consulta que requiera web, llamada visible, resultado consumido por el modelo y
respuesta final no nula.
