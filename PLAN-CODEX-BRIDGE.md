# FreeLLMAPI + bridge de Codex

> Auditoría y plan de estabilización local. Iniciado: 2026-08-09.
> Estado: implementación local aprobada con reserva de E2E. El modo activo sigue
> siendo ChatGPT y el bridge operativo permanece detenido.

## Objetivo

Dejar `freellmapi`, el bridge Responses → Chat Completions y los scripts de cambio de
modo en un estado versionable, comprobable y reversible. La validación local debe cubrir
la traducción y los flujos de herramientas con mocks; la prueba real desde Codex Desktop
queda explícitamente pendiente hasta activar de nuevo el modo DeepSeek.

## Alcance

- Repositorio `freellmapi` y su estado de build/tests.
- Única carpeta física del bridge en `integrations\codex-bridge\bridge`; la ruta
  operativa `C:\Users\Owner\.codex\bridge` es un junction hacia ella.
- Scripts `codex-mode.ps1`, `switch-chatgpt.ps1` y `switch-deepseek.ps1`.
- Contrato Responses requerido por proveedores personalizados de Codex.
- Búsqueda web, tool calls, streaming, health checks, rutas y manejo de errores.

No se incluye:

- activar el modo DeepSeek durante esta tarea;
- llamadas reales al proveedor;
- deploy, push o escrituras en servicios externos;
- copiar claves o tokens a documentación o logs.

## Estado inicial confirmado

### Mudanza del repositorio

- Origen anterior: `C:\Users\Owner\OneDrive\Documentos\test1\freellmapi`.
- Ubicación actual: `C:\Users\Owner\OneDrive\Documentos\area-trabajo\freellmapi`.
- El repositorio, `.git`, `.env`, `node_modules` y los cambios locales se movieron juntos.
- Rama inicial: `main`, un commit por delante y 413 por detrás de `origin/main`.
- Había 31 archivos rastreados modificados y varios archivos no rastreados antes de esta tarea.
  Deben preservarse; no se atribuirán automáticamente a esta auditoría.

### Bridge

- `bridge.pid` no existía y no había proceso Node del bridge.
- Hash SHA-256 inicial de `server.js`:
  `E74D8A273893185E8EFFAD7A0D88B6E79923B3565A3A67FB4261C152CA0E1C89`.
- Hash SHA-256 inicial de `start-bridge.ps1`:
  `83247786F3EB6C816BE11FB3457DCEE626CF63E6666FE9A5C8B39D47FF417EB6`.
- Hash SHA-256 inicial de `stop-bridge.ps1`:
  `B0C29242B89242C577CC70EB7125FE13A7B55302279FEB659D291600816F9633`.
- Estos hashes coinciden con el baseline aportado por el usuario.

### Contrato oficial relevante

- Codex acepta `responses` como único valor de `model_providers.<id>.wire_api`.
- Existe `model_providers.<id>.supports_standalone_web_search`, pero la documentación
  oficial lo marca en desarrollo y desactivado por defecto. No se adoptará sin evidencia
  del cliente instalado y una prueba de contrato.
- Referencia: <https://developers.openai.com/codex/config-reference/>.

## Hallazgos y decisiones

1. La búsqueda B' ya está implementada en el bridge; no era una tarea pendiente.
2. B' emitía un `function_call_output` como item de salida de la misma respuesta. El
   flujo público de Responses es: llamada de función, ejecución, incorporación del
   resultado y respuesta final. La revisión final rechazó conservar ese shim. Se
   reemplazó por un bucle interno: el bridge añade `assistant.tool_calls` y el mensaje
   `tool` al chat upstream, hace una segunda llamada y entrega a Desktop la respuesta
   final, sin fabricar `function_call_output` en `response.output`. Referencia:
   <https://developers.openai.com/api/docs/guides/function-calling>.
3. El fetch arbitrario de URLs era SSRF. Se eliminó: una URL literal produce una
   explicación segura y nunca se descarga. La búsqueda solo usa backends declarados,
   tiene un presupuesto total de 12 segundos y marca los resultados como no confiables.
4. Tras mover el repositorio, los junctions de npm workspaces seguían apuntando a la
   ruta anterior. `npm install --ignore-scripts --no-audit --no-fund` los recreó hacia
   la ubicación actual. El lockfile ya estaba modificado dentro del árbol recibido y npm
   volvió a escribirlo: SHA-256 anterior `7EF5599F...3083`, actual
   `3B359F91...A580`. No se intentó reconstruir o descartar la edición previa del usuario.
5. La primera línea base, ejecutada antes de reparar los junctions, dejó 145 aprobadas y
   18 fallidas. Después de reparar el workspace y corregir las causas reales, la suite
   completa termina con 163/163 aprobadas.
6. Había dos credenciales reales embebidas en `server.js` y la clave unificada recién
   creada se imprimía completa desde la inicialización de la base de datos. Los literales
   se retiraron, visión exige `VISION_API_KEY`, el upstream exige header o
   `FREEL_API_KEY`, y FreeLLMAPI ya no imprime el secreto. Como las claves estuvieron
   expuestas en archivos y backups, su rotación externa sigue siendo obligatoria antes
   de reutilizarlas; esta tarea no escribió en proveedores externos.
7. `stop-bridge.ps1` podía matar cualquier proceso que escuchara en 4000. Ahora exige
   que el proceso sea Node y que su línea de comando apunte al `server.js` exacto.
8. `switch-deepseek.ps1` aplicaba la configuración incluso si el health check fallaba.
   Ambos scripts individuales delegan ahora en `codex-mode.ps1`, que arranca y valida
   el bridge antes de aplicar DeepSeek y copia la configuración mediante un temporal.
   regresión funcional: el build no resolvió `@freellmapi/shared` y Vitest terminó con
   145 pruebas aprobadas y 18 fallidas en cascada. Se repetirá con el workspace reparado.

## Decisión de arquitectura

Se adopta la siguiente solución:

1. Resolver web dentro del bridge:
   `assistant.tool_calls` → búsqueda → mensaje `tool` → segunda llamada upstream →
   respuesta final de Responses.
2. Rechazar explícitamente una ronda que mezcle herramientas web internas y herramientas
   que debe ejecutar el cliente, porque el upstream exigiría resultados para todas antes
   de continuar. El bucle admite hasta tres rondas y tiene timeout/respuesta acotados.
3. Al activar DeepSeek, ejecutar el E2E de Desktop para validar la integración instalada,
   no para legitimar un contrato conocido como incorrecto.
4. No habilitar `supports_standalone_web_search` mientras siga marcado en desarrollo y
   no exista evidencia del cliente instalado.

## Cambios implementados

### FreeLLMAPI

- Migración V21 repara su contrato y reactiva `gemini-3.1-pro-preview`.
- Migración V35 vuelve a separar salud de credencial y catálogo: reactiva Groq y añade
  de forma idempotente los fallbacks que falten solo para modelos habilitados.
- Un HTTP 400 genérico deja de recorrer toda la cadena; la incompatibilidad conocida
  de schema de tools conserva su clasificador específico.
- Analytics compara timestamps en el formato UTC real de SQLite
  (`YYYY-MM-DD HH:MM:SS`).
- La clave unificada generada no se imprime.
- Los fixtures eliminan primero `requests`, luego `api_keys`, y limpian
  `provider_health` cuando corresponde, respetando las FK y el aislamiento.

### Bridge

- Claves embebidas eliminadas; autenticación ausente devuelve 401.
- `/health` identifica servicio, versión y modelo sin revelar upstream. `/ready` y
  `/capabilities` requieren el token local, validan contrato/versiones/credenciales y
  solo devuelven estado y capabilities sanitizadas.
- Sin CORS wildcard; cuerpo limitado a 8 MiB; errores remotos y logs se reducen a
  metadata por defecto. Cada
  request Responses recibe o genera un `X-Glory-Request-Id` acotado, que se
  conserva en tool loops y se propaga al gateway sin incluir prompts ni secretos.
- El log completo de prompts es opt-in mediante `BRIDGE_REQUEST_LOG_FULL=1`.
- La búsqueda limita cada intento a 8 s, el total a 12 s y cada respuesta a 1 MiB;
  URL directa deshabilitada.
- El resultado web vuelve al modelo como `role=tool` en una segunda llamada upstream;
  Desktop recibe la respuesta final y nunca un `function_call_output` fabricado.
- El upstream no streaming del bucle tiene timeout de 180 s, respuesta máxima de 32 MiB
  y máximo de tres rondas web.
- La autenticación está separada: `BRIDGE_CLIENT_TOKEN` protege Codex→sidecar y
  `GLORY_API_KEY`/`FREEL_API_KEY` protege sidecar→GloryAPI. El bridge falla cerrado
  si falta una credencial y nunca reenvía el bearer del cliente al upstream.
- La única fuente está en `integrations/codex-bridge/bridge/`. No existe copia
  operativa ni `sync-to-codex.ps1`: `.codex\bridge` resuelve al mismo directorio por
  medio de un junction.
- El baseline Responses está versionado en `integrations/codex-bridge/fixtures/` y
  cubre texto, reasoning/tools, error upstream y cancelación con invariantes de
  terminación, custom tools, namespaces y visión declarativa. `bridge/responses-sse.js`
  implementa el parser incremental integrado al stream, con UTF-8 fragmentado, límites,
  truncamiento y cancelación; la decisión
  de sidecar, lifecycle, rollback y límites E2E está en
  `Agente/documentacion/adr/ADR-001-codex-responses-sidecar.md`.

### Scripts de modo

- `codex-mode.ps1` resuelve `.codex` desde el perfil del usuario, detecta DeepSeek por `model_provider`, valida
  la identidad de `/health` y aplica configuraciones con un temporal.
- `switch-chatgpt.ps1` y `switch-deepseek.ps1` son wrappers de una sola fuente de verdad.
- El arranque rechaza un puerto ocupado por otro servicio y limpia su propio PID/proceso
  si el health check no confirma la identidad.
- El apagado nunca usa el puerto como autorización suficiente para matar un proceso.

## Checklist de trabajo

- [x] Mover `freellmapi` al área de trabajo.
- [x] Verificar Git y preservar cambios preexistentes.
- [x] Confirmar que bridge y servicio estaban detenidos.
- [x] Registrar hashes de baseline.
- [x] Reparar los enlaces de npm workspaces tras la mudanza.
- [x] Repetir build y tests de `freellmapi` con el workspace reparado.
- [x] Auditar y probar el bridge con un upstream HTTP simulado.
- [x] Corregir búsqueda web y sus límites de seguridad.
- [x] Auditar/corregir scripts de modo sin cambiar el modo activo.
- [x] Definir una fuente física única, preparada para versionarse al crear el fork.
- [x] Congelar el baseline sanitizado Responses y registrar el ADR de sidecar/lifecycle.
- [x] Separar autenticación cliente→sidecar de sidecar→GloryAPI y probar que no se reenvía el bearer recibido.
- [x] Añadir readiness/capabilities autenticados y bloquear contratos incompatibles antes del primer request.
- [x] Publicar una matriz fail-closed por cliente/adapter/modelo en `/capabilities`, con estados
  `supported`, `adapted`, `unsupported` y `unverified`; la matriz no anuncia Codex Desktop E2E
  ni inferencia de proveedor real sin evidencia.
- [x] Versionar la matriz como `glory-codex-capabilities-v2` y exponer `/lifecycle` con
  `glory-codex-lifecycle-v1`: `starting`, `ready`, `blocked`, `draining` y `stopped`.
  Solo `ready` acepta `/v1/responses`; SIGINT/SIGTERM rechaza requests nuevas, drena las
  activas y fuerza cierre tras 5 s. El estado `blocked` y sus causas siguen siendo metadata-only.
- [x] Ejecutar canary determinista Codex CLI `0.146.1` con `auth.command`, SQLite temporal,
  upstream OpenAI-compatible sanitizado y recorrido completo Codex→sidecar→GloryAPI→mock;
  el smoke obtuvo `CANARY_OK` por SSE, verificó `CANARY_TOOL_OK`, fallback Andoryyu→Zen,
  Unicode fragmentado, truncamiento y cancelación, y limpió procesos/temporales.
- [x] Añadir correlación bounded `X-Glory-Request-Id` desde el bridge por cada request, conservar
  el mismo ID durante tool loops y propagarlo por el gateway a los adapters registrados; el ID
  queda fuera del payload y de secretos. Las suites de bridge, proxy y adapters cubren generación,
  rechazo de valores inválidos y variantes stream/no-stream.
- [x] Ejecutar revisión final y registrar su veredicto.
- [ ] Ejecutar E2E real desde Codex Desktop cuando se active el modo DeepSeek; el canary
  determinista no declara compatibilidad Desktop ni sustituye la prueba contra proveedor real.
- [ ] Ejecutar el preflight de activación (`mode/codex-activation-preflight.ps1`) antes de cualquier
  cutover. La comprobación es de solo lectura: la ejecución corregida del 2026-08-10 detecta que los
  cuatro enlaces reales bajo `%USERPROFILE%\\.codex` todavía apuntan a `freellmapi`; además, el perfil
  DeepSeek falla por puerto 4000/bearer legado sin `auth.command`, falta la credencial upstream de runtime
  y el health falla porque el bridge está detenido. El helper DPAPI compilado sí está presente.
- [x] Hacer que `codex-mode.ps1 -Mode deepseek` ejecute el preflight fail-closed antes de
  arrancar el bridge o reemplazar `config.toml`; `-Preview` permite revisar la transición sin mutar
  el perfil real.
- [x] Documentar que el controlador debe invocarse desde la fuente GloryAPI mientras los enlaces
  `.codex` sigan apuntando a `freellmapi`; el enlace legacy no conoce `-Preview` y no es una ruta segura.
- [x] Dejar un runbook reversible de cutover en `integrations/codex-bridge/README.md`, con hashes
  antes/después, canary, E2E Desktop y rollback; permanece documental y no ejecutado.

## Evidencia y resultados

### Pruebas locales

- `npm run build`: PASS. TypeScript servidor/cliente y Vite completan. Queda un warning
  no bloqueante por un chunk JS de 889.67 kB.
- `npm test`: PASS, 44 archivos y 255 pruebas del servidor; el build compartido y
  cliente también completan. El smoke nominalmente live de OpenCode Zen recibió 401 y
  se auto-omitió; no aporta cobertura real del proveedor en esta ejecución.
- `node --test integrations/codex-bridge/test/*.cjs`: PASS, 31/31. Incluye upstream
  local simulado con dos llamadas por flujo, `role=tool` y respuesta final tanto en SSE
  como en no streaming; además Unicode UTF-8 fragmentado, truncamiento sin `[DONE]`,
  cancelación observada, identidad health, falta de auth, límite 413, URL directa
  bloqueada, ausencia de credenciales literales y seguridad del apagado.
- `node --check` del bridge: PASS.
- Parser de PowerShell para los tres scripts de modo en `mode/` y los dos scripts del
  bridge único: PASS. Las rutas equivalentes en `.codex` son enlaces, no copias.
- E2E de Codex Desktop: no ejecutado; modo ChatGPT confirmado y puerto 4000 detenido.

### Hashes de la fuente única (SHA-256)

- `bridge/server.js`: `4BB1105A9A9B1FEBBE9BDC15344DB8CAAD019C103FE6F8D8763BD925E97BB19E`.
- `bridge/start-bridge.ps1`: `8C2208038859B1D3E8E6B639C1F8F1671E2C3DF81586A3B2B621CF77C5856A0A`.
- `bridge/stop-bridge.ps1`: `B556B6F7260A51A883BF5E462FB1C0E4B568548D556303F04584B4B2C03CE75D`.
- `codex-mode.ps1`: `52031F02C476B8DA765A9C9FC452A4A459AB5F605A0F168A1E71C3DD30E86075`.
- `switch-chatgpt.ps1`: `544CE4C068F87DFCC7F804EA871F0CE60E4DCAD5DF268BA05968101174E39E3C`.
- `switch-deepseek.ps1`: `A26FC5E22E5EE967C161F49F8E8B721D4F37AE10CC8F27AE632C9D2993EF37C6`.

La revalidación del contrato de lifecycle añadió una prueba determinista para el estado `blocked`,
rechazo fail-closed de inferencia sin credencial upstream y la matriz versionada de transiciones.

Un PASS local no sustituye la prueba E2E del cliente mientras el bridge esté
 desactivado. Este bloque queda listo para commit local; no se hará push ni publicación externa.


### Revisión de supervisor

- Primera pasada: `RECHAZADO` porque B' fabricaba `function_call_output` dentro de la
  misma respuesta. Se sustituyó por el bucle interno upstream.
- Segunda pasada: `RECHAZADO` porque el timeout terminaba al recibir headers y no
  cubría un body colgante. Se extendió hasta consumir/cancelar el body y se añadió el
  test de JSON parcial que no cierra.
- Tercera pasada: `APROBADO CON RESERVAS`, sin hallazgos materiales. La reserva es
  únicamente el E2E real de Codex Desktop al activar DeepSeek.

Estado final comprobado: `model = "gpt-5.6-luna"`, sin `bridge.pid` y sin listener en
el puerto 4000. La referencia local `origin/main` avanzó de 413 a 459 commits por delante
durante la tarea; no se hizo pull, rebase, reset, push ni integración para no mezclar el
árbol local recibido.

## Consolidación a una sola fuente

- Se eliminaron la antigua carpeta operativa física, nueve `server.js.bak-*`, el backup
  completo de `.archivado`, logs y artefactos de investigación: 87 archivos redundantes.
- También se eliminaron la réplica `codex/` y `sync-to-codex.ps1` del repositorio.
- `C:\Users\Owner\.codex\bridge` es ahora un junction, no una segunda copia.
- Los tres scripts de modo importantes se conservaron en `integrations/codex-bridge/mode/`;
  sus nombres originales en `.codex` son enlaces simbólicos hacia esa fuente única.
- La fuente única está preparada para versionarse cuando exista el fork personal, pero
  por ahora permanece como cambio local no confirmado. No se conservan backups sueltos
  que puedan divergir o retener credenciales antiguas.
- Validación posterior: junction correcto, fuente con `server.js`, `responses-sse.js`,
  `start-bridge.ps1` y `stop-bridge.ps1`; fixture Responses y ADR versionados; 31/31 tests;
  sintaxis PowerShell de los scripts activos; modo ChatGPT y puerto 4000 detenido.
