# Roadmap GloryAPI

GloryAPI se construye como workspace hermano aislado de FreeLLMAPI. El legado permanece intacto como rollback
durante la validación posterior al cutover reversible.

## Siguiente bloque

1. Mantener el snapshot real externo y protegido durante la ventana de rollback; ya fue verificado con `integrity_check=ok` y el importador versionado e idempotente migró 22/22 credenciales.
2. Ejecutar `npm run task:check:local -- <ID>` como preflight de cada bloque y repetir `npm run task:check -- GLORY-BASELINE` después de cada bloque de cambios; el cierre conserva el perfil full/CI.
3. Mantener la política de cambios del legado: sin modificaciones durante la migración; cualquier corrección operativa futura debe quedar registrada, probada y evaluada para portabilidad.
4. Conservar el bootstrap sanitizado por `git archive` + overlay: el escaneo histórico de 518 commits/4.018 blobs y del overlay quedó documentado sin exponer valores.
5. Mantener la revisión periódica de Sentinel; el gate local actual pasa con 0 errores y 4 warnings de directorios
   abarrotados (bridge, tests y rutas), además del aviso operativo de lease legacy. No son fallos del bloque, pero
   permanecen visibles hasta reorganizar esos directorios o registrar una excepción explícita.
6. Probar ACL/recuperación del bundle portable bajo otro perfil; `portable-bundle-file.ts` ya escribe con fsync/rename, límite de 16 MiB y ACL sin herencia para el usuario actual, y `recover:bundle` re-protege 22/22 filas de forma idempotente sin health externo. `--dry-run` valida sin escribir; `--health-check` es opt-in explícito; `recover:profile` deja el ensayo sintético reproducible y queda probar otro perfil Windows con ventana administrativa controlada.
7. Cerrar el bloque local de Fase 6: el ciclo draft → discovery acotado → verificación real de health/chat/capabilities → active ya es fail-closed y no activa catálogos remotos completos; el wizard visual ahora cubre proveedor → endpoint/auth para drafts nuevos → credencial → health check opcional, y la API solo acepta credenciales de proveedores activos o drafts explícitos. El smoke DOM comprobó el orden sin transmitir secreto antes del draft; queda automatizarlo y extenderlo a modelos, revisión y activación. Prevención: `Agente/prevencion/prevencion-provider-wizard-order-2026-08-10.md`.
8. Fase 8 queda cerrada en su bloque local: el contrato de orden, autosave, revisión, cola local, SSE autenticado,
   separación entre política configurada y runtime de modelos, y conflicto concurrente ya están cubiertos.
9. Fase 9 local queda cerrada en su bloque de compatibilidad Chat Completions: el request se normaliza a un contrato
   canónico, las capacidades efectivas se validan antes del transporte, el retry tiene presupuesto, las trazas y
   respuestas usan códigos de error sanitizados, el stream incremental valida UTF-8/terminación/truncamiento/cancelación
   y el fixture `glory-andoryyu-regression-v1` cubre ChatGPT/VS Code con fallback determinista a Zen. Los overrides
   llegan con HTTPS, timeout y alias.

10. Fase 10.1 ya tiene baseline Responses sanitizado `glory-codex-responses-fixture-v1`, ADR del sidecar y parser
    incremental `responses-sse.js` integrado en el stream del bridge. El contrato cubre UTF-8 fragmentado,
    terminación `[DONE]`, truncamiento, cancelación de upstream, custom tools, namespaces y adaptación visual con
    pérdida explícita. La auth cliente→sidecar ya está separada de sidecar→GloryAPI con fail-closed y `/ready` más
    `/capabilities` autenticados validan contrato, versión y límites declarados. `bridge-auth` crea/rota el token local
    con DPAPI `CurrentUser` y `get-codex-auth.ps1` lo expone token-only. `prepare-canary-profile.ps1` genera un perfil
    temporal `gloryapi-canary` con `model_providers.<id>.auth.command`, sin `experimental_bearer_token` y sin tocar
    `config.toml`. El sidecar y el gateway publican discovery compatible bajo `data`/`models` y `slug`, detectado
    con Codex CLI `0.146.1`. El canary determinista `npm run canary:codex` ya completó Codex→sidecar→GloryAPI→mock
    con readiness autenticada, lifecycle `ready`, capabilities v2, respuesta no-stream `CANARY_OK`, bucle interno `CANARY_TOOL_OK` sin
    `function_call_output`, fallo trazable de Andoryyu con fallback a Zen y respuesta SSE `CANARY_OK`, usando SQLite
    temporal, puertos loopback y cleanup; una segunda ejecución temporal de Codex hizo también `shell_command` y
    recibió `CANARY_CODEX_TOOL_OK`; la matriz del endpoint `/capabilities` ahora marca explícitamente
    `supported`/`adapted`/`unsupported`/`unverified` por cliente/adapter/modelo sin sobreanunciar Desktop o proveedor
    real. `/health` queda limitado a identidad/liveness sin auth y readiness/capabilities mantienen auth; la matriz explicita también
    tool-only, standalone web search, MCP, browser, computer use, automation,
    multi-agent y long-context con estados fail-closed. El contrato se versionó a `glory-codex-capabilities-v2` y añade
    `glory-codex-lifecycle-v1`: `starting`/`ready`/`blocked`/`draining`/`stopped`,
    inferencia solo en `ready` y shutdown con drenaje acotado. El proveedor real Andoryyu,
    el runtime local y el bridge pasan readiness dentro del canary aislado; ChatGPT normal permanece
    activo y el bridge queda detenido fuera de esa prueba. Una E2E HTTP adicional contra el GloryAPI
    autenticado pasó texto, `function_call` y SSE en un puerto temporal. La matriz completa, bandeja,
    E2E Desktop y atribución individual del proveedor siguen abiertos.
11. La investigación de OpenCodex se incorporó aditivamente a Fase 10.7: control-plane/data-plane separados,
    catálogo distinto de routing, afinidad de hilo, límites HTTP explícitos y recuperación/journal como trabajo
    aplicado selectivamente a `codex-mode.ps1` con lock, journal y hashes; no se copió código ni se instaló OpenCodex.
12. El bridge ahora reduce errores remotos a metadata, evita hashes deterministas de consultas y rota
    `bridge.requests.log` con límite/retención configurables; faltan todavía headers/tool args/SSE/dumps y el bundle
    de diagnóstico revisable. La cola de escritura tiene capacidad bounded y drops contabilizados; una entrada
    sobredimensionada se degrada a metadata. La evidencia local es 31/31 tests del bridge y Sentinel local 0/0.
13. El preflight de activación de Codex/ChatGPT quedó preparado como comprobación de solo lectura:
    `integrations/codex-bridge/mode/codex-activation-preflight.ps1`. Verifica que los enlaces reales de
    `%USERPROFILE%\\.codex` apunten a GloryAPI, que el perfil DeepSeek use Responses en 4100 sin bearer literal,
    y que el health corresponda al bridge nuevo. El preflight no modifica el perfil ni repunta enlaces por sí mismo;
    la operación reversible separada del 2026-08-10 repuntó los cuatro enlaces a GloryAPI y dejó el perfil activo
    en Responses 4100.
    `codex-mode.ps1` ahora bloquea el arranque/copia si ese contrato falla y ofrece `-Preview` sin mutación.
14. Prevención registrada en `Agente/prevencion/prevencion-codex-legacy-link-2026-08-10.md`:
    mientras los enlaces `.codex` sean legacy, solo se invoca la fuente GloryAPI y se bloquea cualquier
    canary/cutover; no se modifica `freellmapi` para corregirlo. El registro de recuperación conserva
    fingerprints del perfil restaurado y deja revisión manual pendiente porque el hash previo no tiene
    copia local recuperable.
15. El preflight de activación ahora valida también, sin revelar valores, que exista el helper compilado
    `server/dist/scripts/bridge-auth.js` y que exista una credencial upstream en el proceso o en la bóveda
    local mediante `bridge-upstream-auth.js`; así el `-SkipHealth` previo al arranque no permite avanzar con
    un runtime incompleto.
    El caso repetible queda documentado en `Agente/prevencion/prevencion-codex-runtime-incompleto-2026-08-10.md`.
16. `start-bridge.ps1` ya inicia de forma acotada el runtime local en 3101 (`start-gloryapi.ps1`) si no está
    listo; el PID/log son propios de GloryAPI y el bridge sigue separado del perfil ChatGPT. El runtime
    arranca con entorno aislado y el bridge con allowlist explícita de variables; `environment-isolation.test.cjs`
    captura el proceso hijo y confirma que no hereda ningún token.
17. El estado operativo de esta auditoría conserva ChatGPT normal y el bridge detenido fuera del canary;
    no se modificó `C:\Users\Owner\.codex\config.toml`. El canary local Node → bridge → GloryAPI cubre
    Andoryyu, OpenCode Zen, OpenCode Go y fallback con HTTP 200, y la E2E HTTP autenticada temporal
    pasó texto, `function_call` y SSE sin `FALLBACK_REASONING`; el payload fiel de Browser/plugin también
    completó la ronda `function_call(js)` → `function_call_output` sintético → `message`. Falta E2E desde
    la aplicación Desktop y atribuir cada inferencia a un proveedor individual en una ventana reversible.
    La matriz real aislada observó `429`/`response.failed` en Andoryyu y Zen, y `200`/`response.completed`
    en Go; el fallback normal adicional confirmó dos intentos hasta Go y `[DONE]` en SSE. Queda como evidencia
    de disponibilidad/fallback de esa ventana, no como PASS simultáneo estable de proveedores. Prevención abierta:
    `Agente/prevencion/prevencion-live-fallback-attribution-2026-08-11.md` evita atribuir la cadena intermedia
    solo a partir del contador de intentos.
18. `unified_api_key` migrada a `local_auth_tokens` con DPAPI `CurrentUser`; `settings` ya no conserva el
    plaintext. El helper upstream solo resuelve la fila DPAPI en readonly y falla cerrado si falta. Se mantiene
    además ACL sin herencia para Owner, SYSTEM y Administrators como defensa en profundidad.
19. Bloque de continuidad de conversación (429 `request_timeout` recurrente): corregido el timeout efectivo del
    upstream (15 s → 120 s, `ProviderDefinition.timeoutMs`), el sticky de proveedor ahora aplica también a
    cadenas explícitas (`model:"deepseek-v4-flash"`) con `routing.stickyRotationMs=5 min`, opencode-zen escala su
    cooldown a 4 h en 429 (cuota diaria 4M tokens) y `routing.maxDurationMs=240 s` deja margen de reintento.
    Evidencia: ADR-004 en `Agente/documentacion/adr/`, 267/267 tests, build OK. Pendiente: validación E2E con
    sesión larga de Codex Desktop contra el runtime reiniciado e idle-timeout de streams pos-headers.

## Estado verificado

- GloryAPI ya tiene `POST /api/settings/backup`, autenticado con la clave unificada y con destino externo por
  `GLORYAPI_BACKUP_DIR`. El snapshot real del legado fue creado fuera del workspace, verificado con
  `integrity_check=ok` y protegido con ACL del usuario actual.
- GloryAPI incorpora un bundle portable v1 en `server/src/lib/vault-bundle.ts`, con Argon2id + AES-256-GCM,
  y `server/src/lib/portable-bundle-file.ts` lo persiste atómicamente con límite de tamaño y ACL local fail-closed;
  fingerprints SHA-256 y pruebas de round-trip/tampering para 22 credenciales sintéticas. El importador específico
  `server/src/lib/credential-import.ts` y `server/src/scripts/import-legacy-snapshot.ts` ya cubren idempotencia,
  incluida la recuperación desde archivo portable y re-protección DPAPI sin health externo; `recover:bundle`
  solo ejecuta `checkKeyHealth` cuando recibe `--health-check` explícito; `--dry-run` descifra y valida sin escribir ni
  ejecutar health, y no puede combinarse con `--health-check`;
  snapshot externo y migración 22/22. El adapter DPAPI `CurrentUser` fail-closed está integrado en nuevas altas;
  el target real tiene 22 filas DPAPI y ninguna `settings.encryption_key`.
- La fixture `recover:profile` se ejecutó con datos sintéticos fuera del repositorio: dry-run dejó 0 filas,
  importó 22/22, repitió 22 sin cambios y confirmó `dpapiRoundTrip=true`; se limpiaron bundle y SQLite temporales.
- `backup.test.ts` restaura 22/22 credenciales cifradas sintéticas, comprueba `integrity_check`, SHA-256 y ausencia
  de plaintext; la migración real verificó 22/22 resoluciones DPAPI y fingerprint-set coincidente.
- Sentinel 0.7.1 está fijado en `quality-tools.json` y `sentinel.lock.json`; el runtime
  local/global está provisionado y compile + suite del checkout externo pasaron (**557 passing, 1 pending**).
  `quality:doctor` ahora devuelve `ready: true`, con commit `7d18a755...`, release `v0.7.1`, evidencia limpia y
  artefacto `18611cda...`; la herramienta externa permanece limpia.
- El adaptador `scripts/quality/sentinel-stage.mjs` convierte el análisis en reporte estructurado. El análisis directo y
  `task:check:local` quedan sin errores, con 4 warnings de directorios abarrotados heredados del workspace; no se
  añadieron exclusiones Sentinel.
  Tras extraer las migraciones V1–V35, componentes
  de UI, hooks, helpers de providers, contratos del proxy, rutas de Analytics y suites grandes de tests, además de
  tipar respuestas nuevas, producción, UI, tests y contratos compartidos ya no tienen avisos explícitos de `any` ni
  hints pendientes. Los selectores existentes se conservaron mediante el alias semántico `SelectDropdown`, sin
  introducir un componente duplicado ni cambiar su comportamiento.
- El escaneo histórico/overlay y el guard de independencia de Git quedaron completados; el historial completo no se reutiliza porque el inventario contiene artefactos sensibles excluidos. La política del legado queda fijada: no modificar `freellmapi` durante la migración.
- El preflight coordinado conserva `task:check:local -- GLORY-BASELINE` en PASS, con 0 errores y 4 warnings de
  directorios abarrotados; `quality:doctor` confirma Sentinel 0.7.1, política `enforce`, lock/provisionado alineados y
  `readyForGate: true`.
  El informe completo ya conserva `policyIdentity` y `npm run task:check -- GLORY-REQUEST-ID-ALL` pasa con política
  `enforce`, hash y ruta verificables. La reparación está fijada al commit Sentinel
  `7d18a755f12751ae9fd1ac67827f5a6dad8be631`, con tag local `v0.7.1`, lock y artefacto provisionado alineados.
  La publicación del tag en el remoto upstream queda fuera de esta sesión, pero el checkout y la evidencia local son reproducibles.
- Fase 5 ya tiene un bootstrap de catálogo operativo: una base nueva usa el schema compacto sin ejecutar las 35
  migraciones históricas; una base existente se actualiza y queda normalizada a exactamente tres modelos, con fallback
  1–3 y credenciales archivadas preservadas. El contrato está cubierto por `catalog-clean.test.ts`.
- La superficie obsoleta de Fase 5 ya fue retirada: dashboard sin Playground, presupuesto mensual ni presets de orden;
  el schema nuevo no contiene `monthly_token_budget`, y el registry de producción solo expone Andoryyu, OpenCode Zen
  y OpenCode Go. Los adapters heredados quedan disponibles únicamente para tests/upgrades aislados.
- Fase 6 ya tiene contratos compartidos versionados (`glory-registry-v1`), snapshot sanitizado en `GET /api/registry`
  y Keys consume el backend en lugar de duplicar la lista de providers. Todo `/api/registry/**` exige ahora la clave
  administrativa local; `registry.test.ts` cubre catálogo activo,
  credenciales archivadas, drafts, rechazo de endpoints inseguros, activación sin verificación y ausencia de material
  secreto. El draft se guarda en SQLite y nunca pasa a active automáticamente. El endpoint de verificación ejecuta
  health mediante `validateKey`, chat mediante un ping mínimo y capabilities mediante el contrato declarativo; los
  errores upstream se reducen a respuestas sanitizadas y la activación requiere las tres marcas más un adapter
  operativo coincidente.
- `GET /api/registry/templates` publica plantillas declarativas versionadas para Chat Completions, reasoning y Gemini;
  los drafts aceptan slugs nuevos como estado inerte, pero la activación continúa exigiendo un adapter registrado.
- La selección explícita de modelos se guarda en `provider_model_drafts` mediante un reemplazo transaccional y
  permanece separada del catálogo operativo de tres modelos. El discovery remoto `/models` ya está acotado,
  exige credencial elegida, usa cache TTL de 30 s con stale diagnóstico acotado y devuelve solo drafts; el wizard
  visual y la prueba contra proveedor real siguen pendientes.
- `integrations/glory-tray/GloryApiTray.ps1` ya ofrece un prototipo de bandeja que muestra el último modelo, abre
  el dashboard y permite activar/desactivar o reordenar entradas mediante la Control API autenticada con revisión
  esperada; usa solo loopback y no toca perfiles Codex, bridge ni FreeLLMAPI. La decisión Tauri/Electron, startup
  policy y E2E Windows siguen pendientes.
- El guard `endpoint-security.ts` bloquea HTTPS con credenciales, hosts locales y rangos privados antes de los
  fetch de proveedores; los transportes y el bridge rechazan redirects automáticos. En tests cubre IPv4/IPv6 privados
  y URLs inseguras; el anclaje de IP frente a DNS rebinding E2E sigue pendiente.
- El data-plane exige ahora el mismo token de admisión para `POST /v1/chat/completions` y `GET /v1/models`; la
  prueba de descubrimiento confirma `401` sin credencial y conserva el contrato dual `data`/`models` con credencial válida.
- `/api/control/status` ofrece un plano de gestión mínimo autenticado para la bandeja, con routing/runtime/modelos
  sin secretos. El resto de la Control API exige la credencial administrativa local; el dashboard obtiene una sesión
  efímera loopback ligada a origen y CSRF, sin guardar la clave unificada en el navegador.
- El bridge aplica un límite fijo de 32 solicitudes activas y responde `429 bridge_busy` sin aceptar una cola ilimitada;
  además rechaza paths largos, métodos no permitidos, content types no JSON y referencias de imagen con MIME/magic
  inválidos antes de traducir. Los tests HTTP/contrato y fuzz SSE pasan en la suite actual. El guard de versión invoca el intérprete fijo de Windows con un launcher
  allowlisted (sin `shell:true` ni concatenación de `CODEX_BIN`), valida Codex CLI `0.146.1` y permanece fail-closed.
- Fase 7 tiene un registro tipado y versionado como `glory-settings-v1`, con defaults/rangos/alcance/
  `requiresRestart`, revisión optimista y escritura SQLite transaccional en `GET/PATCH /api/settings`. La UI ya
  expone `Settings` en pestañas por alcance, reset por sección y auditoría sanitizada. `GET/PATCH /api/settings/providers` y el endpoint de modelos muestran y
  persisten overrides validados de base URL HTTPS, timeout, auth, alias y capabilities, indicando herencia
  default/provider/model. Los tests cubren autenticación, valores desconocidos, rangos, atomicidad, conflictos,
  herencia y rechazo de URLs inseguras; los límites absolutos y la criptografía siguen en código.
- La verificación de este bloque terminó con `npm test` en 44 archivos/255 tests PASS, build de shared/client/server,
  bridge 31/31 PASS, `npm run bench:routing` con 128/128 requests, p95 68.87 ms y presupuesto de 100 ms aprobado,
  y canary Codex aislado PASS.
  `task:check:local` y el gate full pasan con 0 errores y 0 warnings; el gate full además conserva identidad/hash de
  política `enforce`. La publicación del tag en el remoto upstream queda como pendiente de distribución,
  no como fallo oculto del consumidor.
- Fase 8 tiene `glory-routing-v1`, snapshots con revisión, escritura atómica del conjunto completo y validación de
  prioridades/IDs. Routing guarda automáticamente tras drag/toggle, muestra estado de guardado y revierte ante error;
  la UI encola la última intención mientras una escritura está en vuelo y el backend rechaza conflictos obsoletos.
  `/api/fallback/events` publica únicamente revisiones/listas y runtime sanitizados mediante SSE autenticado, heartbeat
  y cleanup de sockets; el shutdown del servidor cierra los subscribers de forma explícita. El runtime efímero separa
  política configurada, intentos en vuelo y último modelo completado; `fallback.test.ts` cubre dos writes concurrentes
  con una sola revisión ganadora y `routing-runtime.test.ts` cubre concurrencia, rollback y reset.
- Fase 9 local tiene la taxonomía `ProxyErrorCategory/ProxyErrorCode`, respuestas y logs de metadata sin mensajes
  upstream, y trazas con códigos bounded. `proxy-errors.test.ts` cubre request/auth/schema/rate-limit/timeout/cold-start/
  stream/provider, además del fixture sanitizado ChatGPT/VS Code de Andoryyu: stream truncado => `stream_truncated`,
  fallbackable y siguiente candidato OpenCode Zen; stream completado => sin fallback. El nuevo contrato de identidad
  exige que respuestas y chunks declaren el modelo efectivo; un downgrade se clasifica como `model_downgrade` o
  `foreign_toolset`, no aplica cooldown ni penalidad y el canary repite el caso 429 determinista para probarlo.
- El runtime compilado ya incluye `@gloryapi/shared/dist/types.js`: `build:shared` se ejecuta antes del build del
  servidor y un smoke real en loopback confirmó que `server/dist/index.js` arranca sin `ERR_MODULE_NOT_FOUND`.
- El bloque actual de compatibilidad añadió `server/src/providers/compat/model-identity.ts`, fixture
  `foreign_toolset`/`model_downgrade`, trazas bounded y canary determinista con retry sin cooldown.
- El bloque anterior de UI/control separó hooks de `FallbackPage` y `SettingsPage`, movió Analytics y los contratos de
  backup/registry a límites explícitos sin cambiar las rutas públicas; build, suite y bridge siguen verdes.
- Fase 10.1 tiene el fixture `integrations/codex-bridge/fixtures/responses-contract-v1.json`, probado por el contrato
  estructural del bridge (texto, reasoning/tools, error, cancelación, custom tool, namespace y visión),
  `ADR-001-codex-responses-sidecar.md` y el parser incremental `bridge/responses-sse.js`; además el sidecar separa `BRIDGE_CLIENT_TOKEN` de
  `GLORY_API_KEY`/`FREEL_API_KEY`, verifica que nunca reenvía el bearer del cliente, expone `/ready`/
  `/capabilities` autenticados sin URL upstream y obtiene el token local mediante DPAPI con `bridge-auth`.
  `prepare-canary-profile.ps1` prepara un perfil Codex temporal con `auth.command`, sin `experimental_bearer_token` y
  sin modificar `config.toml`. El mock determinista y `npm run canary:codex` ya validan Codex CLI `0.146.1` → sidecar
  → GloryAPI → SSE `CANARY_OK` con SQLite temporal, puertos loopback y cleanup. La prueba HTTP real del sidecar cubre
  UTF-8 fragmentado, stream sin `[DONE]`, abort al cerrar el cliente y readiness/capabilities; el contrato HTTP
  también verifica `/lifecycle`, estado `blocked` fail-closed y la transición documentada de shutdown; el bridge continúa
  detenido y no se anuncia compatibilidad completa de Codex Desktop ni atribución individual de proveedores reales.
- El nudge anti-falso-complete quedó limitado al turno actual (`currentTurnHasToolMessages`) y el
  refactor posterior del bridge centralizó la salida de tools en streaming/non-streaming. Las respuestas
  tool-only ahora emiten `function_call` con `end_turn=false`, el `FALLBACK_REASONING` sintético se filtra
  también de la caché persistida y reasoning-only/vacío tiene una recuperación única y bounded antes de
  `response.failed`. El bloque 11826-5 dividió `server.js` en adapters/handlers por responsabilidad
  y centralizó la configuración agnóstica (`BRIDGE_*`, con aliases legacy); `server.js` quedó en 276 líneas.
  La auditoría 2026-08-11 añadió timeout total/idle al streaming, perfiles de tools `codex-desktop|generic`,
  selección canary autenticada y restringida a overrides declarados para las tres rutas activas, y un auditor live
  aislado con proyección de trazas metadata-only. Evidencia actual: 96/96 tests del bridge + 2/2 de seguridad,
  `npm run build:server` PASS, quality gate PASS y `npm run canary:codex` PASS con cobertura directa Andoryyu/Zen/Go,
  fallback, stream, tool loop, plugins/MCP, agentes, ejecución real de `shell_command`, Codex CLI aislado y un
  `codex app-server` aislado con dos turnos, `turn/completed` y compaction observable.
  Una ventana real separada observó `429` en Andoryyu/Zen, `200` en Go y fallback normal hasta Go; eso no equivale
  a salud estable simultánea. El bridge permanece detenido y ChatGPT normal es la ruta activa; el E2E real de Desktop
  sigue siendo una validación operativa pendiente y no se declara PASS por inferencia.


## Bloqueos y decisiones pendientes

- El snapshot externo del legado y sus credenciales de cifrado deben conservarse durante la ventana de rollback;
  no se copia al workspace ni se modifica `freellmapi`.
- La fuente de Sentinel sigue siendo el checkout hermano `../glory-rs-rest/tools/sentinel`, pero ya quedó alineada
  y validada como release `0.7.1`: compile, suite y evidencia de staging limpio pasan; `quality:doctor` está en
  `ready: true` y no hay drift entre source, provisionado, lock y config. La independencia para un clon limpio
  sigue siendo una mejora futura de distribución, no un bloqueo del checkout actual.
- El nuevo workspace aún no tiene remoto externo; no se crea ni se publica como parte de esta fase.
- La revalidación del 2026-08-10 ejecutó `npm run canary:codex` con PASS para texto, tool loop,
  fallback Andoryyu→Zen, `foreign_toolset`/downgrade repetible sin cooldown, SSE y el upstream determinista de Unicode
  fragmentado, truncamiento y cancelación.
  La suite del bridge terminó 31/31, `npm test` terminó con 44 archivos y 255 tests PASS, `npm run build:server`
  y el build del cliente terminaron PASS, y no quedaron temporales
  propios. La compatibilidad E2E completa de Codex Desktop sigue pendiente: el canary validado es Codex CLI `0.146.1` aislado
  contra un upstream determinista sanitizado. La prueba local real Node → bridge → Andoryyu pasó HTTP 200;
  falta probar Desktop real, control VS Code, capabilities completas y rollback desde la aplicación.

- Distribución de Sentinel: el gate full ya fue verificado con el commit fijado `7d18a755...`, tag `v0.7.1`, lock,
  evidencia de release y artefacto `85ba836d...`; devuelve identidad/hash `enforce`. Falta publicar el tag en upstream.
  El caso reproducible y la detección esperada están en `Agente/prevencion/prevencion-sentinel-policy-identity-2026-08-10.md`.

## Planes activos

- `Agente/planes/plan-codex-bridge-audit-2026-08-11.md` — auditoría, refuerzo y cobertura canary del bridge.
- `PLAN-GLORYAPI.md` — derivación, aislamiento y migración por fases.
- `Agente/documentacion/migracion/fase-0-1-2026-08-10.md` — evidencia de Fase 0/1, overlay, backup y gate.
- `server/src/__tests__/routes/backup.test.ts` — contrato de integridad/restauración del backup.
