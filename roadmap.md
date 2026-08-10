# Roadmap GloryAPI

GloryAPI se construye como workspace hermano aislado de FreeLLMAPI. El legado permanece operativo hasta un
canary y cutover reversible posteriores.

## Siguiente bloque

1. Mantener el snapshot real externo y protegido durante la ventana de rollback; ya fue verificado con `integrity_check=ok` y el importador versionado e idempotente migró 22/22 credenciales.
2. Mantener el baseline `0a14649` y repetir `npm run task:check -- GLORY-BASELINE` después de cada bloque de cambios.
3. Mantener la política de cambios del legado: sin modificaciones durante la migración; cualquier corrección operativa futura debe quedar registrada, probada y evaluada para portabilidad.
4. Conservar el bootstrap sanitizado por `git archive` + overlay: el escaneo histórico de 518 commits/4.018 blobs y del overlay quedó documentado sin exponer valores.
5. Mantener la revisión periódica de warnings informativos de Sentinel; el gate full actual pasa con 0 errores y 5 warnings
   de mantenimiento (transformación dinámica de dnd-kit y límites de tamaño en módulos heredados). Ya se extrajeron
   snapshots, V1–V35 y `server/src/db/index.ts` quedó como orquestador de inicialización y backup.
6. Probar ACL/recuperación del bundle portable bajo otro perfil; las 22 filas operativas ya usan ciphertext DPAPI `CurrentUser`, fingerprints y metadatos, y el bundle Argon2id + AES-256-GCM está probado con fixtures sintéticos.
7. Cerrar el bloque local de Fase 6: el ciclo draft → verificación real de health/chat/capabilities → active ya es fail-closed y no activa catálogos remotos completos.
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
    con readiness autenticada, respuesta no-stream `CANARY_OK`, bucle interno `CANARY_TOOL_OK` sin
    `function_call_output`, fallo trazable de Andoryyu con fallback a Zen y respuesta SSE `CANARY_OK`, usando SQLite
    temporal, puertos loopback y cleanup; la matriz del endpoint `/capabilities` ahora marca explícitamente
    `supported`/`adapted`/`unsupported`/`unverified` por cliente/adapter/modelo sin sobreanunciar Desktop o proveedor
    real. El proveedor real, la matriz completa, bandeja y cutover siguen abiertos;
    el bridge permanece detenido.

## Estado verificado

- GloryAPI ya tiene `POST /api/settings/backup`, autenticado con la clave unificada y con destino externo por
  `GLORYAPI_BACKUP_DIR`. El snapshot real del legado fue creado fuera del workspace, verificado con
  `integrity_check=ok` y protegido con ACL del usuario actual.
- GloryAPI incorpora un bundle portable v1 en `server/src/lib/vault-bundle.ts`, con Argon2id + AES-256-GCM,
  fingerprints SHA-256 y pruebas de round-trip/tampering para 22 credenciales sintéticas. El importador específico
  `server/src/lib/credential-import.ts` y `server/src/scripts/import-legacy-snapshot.ts` ya cubren idempotencia,
  snapshot externo y migración 22/22. El adapter DPAPI `CurrentUser` fail-closed está integrado en nuevas altas;
  el target real tiene 22 filas DPAPI y ninguna `settings.encryption_key`.
- `backup.test.ts` restaura 22/22 credenciales cifradas sintéticas, comprueba `integrity_check`, SHA-256 y ausencia
  de plaintext; la migración real verificó 22/22 resoluciones DPAPI y fingerprint-set coincidente.
- Sentinel 0.7.0 está fijado en `sentinel.config.json`, `quality-tools.json` y `sentinel.lock.json`; el runtime
  local/global está provisionado y compile + suite del checkout externo pasaron (**557 passing, 1 pending**).
  `quality:doctor` ahora devuelve `ready: true`, con commit `a804c0d8...`, release `v0.7.0`, evidencia limpia y
  artefacto `18611cda...`; la herramienta externa permanece limpia.
- El adaptador `scripts/quality/sentinel-stage.mjs` convierte el análisis en reporte estructurado. El análisis directo
  queda sin findings accionables; el aviso de `_generated` ausente es informativo. El gate full `task:check` pasa con
  0 errores y 5 warnings de mantenimiento: la transformación dinámica recomendada por dnd-kit y cuatro límites de
  tamaño en módulos heredados. No se añadieron exclusiones Sentinel. Tras extraer las migraciones V1–V35, componentes
  de UI, hooks, helpers de providers, contratos del proxy, rutas de Analytics y suites grandes de tests, además de
  tipar respuestas nuevas, producción, UI, tests y contratos compartidos ya no tienen avisos explícitos de `any` ni
  hints pendientes. Los selectores existentes se conservaron mediante el alias semántico `SelectDropdown`, sin
  introducir un componente duplicado ni cambiar su comportamiento.
- El escaneo histórico/overlay y el guard de independencia de Git quedaron completados; el historial completo no se reutiliza porque el inventario contiene artefactos sensibles excluidos. La política del legado queda fijada: no modificar `freellmapi` durante la migración.
- El gate coordinado ya cierra contra el `HEAD` propio `0a14649`: `task:check -- GLORY-BASELINE` devuelve PASS.
  Sentinel conserva 0 errores y 5 warnings no bloqueantes; un checkout sin historia seguiría fallando cerrado.
- Fase 5 ya tiene un bootstrap de catálogo operativo: una base nueva usa el schema compacto sin ejecutar las 35
  migraciones históricas; una base existente se actualiza y queda normalizada a exactamente tres modelos, con fallback
  1–3 y credenciales archivadas preservadas. El contrato está cubierto por `catalog-clean.test.ts`.
- La superficie obsoleta de Fase 5 ya fue retirada: dashboard sin Playground, presupuesto mensual ni presets de orden;
  el schema nuevo no contiene `monthly_token_budget`, y el registry de producción solo expone Andoryyu, OpenCode Zen
  y OpenCode Go. Los adapters heredados quedan disponibles únicamente para tests/upgrades aislados.
- Fase 6 ya tiene contratos compartidos versionados (`glory-registry-v1`), snapshot sanitizado en `GET /api/registry`
  y Keys consume el backend en lugar de duplicar la lista de providers. `registry.test.ts` cubre catálogo activo,
  credenciales archivadas, drafts, rechazo de endpoints inseguros, activación sin verificación y ausencia de material
  secreto. El draft se guarda en SQLite y nunca pasa a active automáticamente. El endpoint de verificación ejecuta
  health mediante `validateKey`, chat mediante un ping mínimo y capabilities mediante el contrato declarativo; los
  errores upstream se reducen a respuestas sanitizadas y la activación requiere las tres marcas más un adapter
  operativo coincidente.
- Fase 7 tiene un registro tipado y versionado como `glory-settings-v1`, con defaults/rangos/alcance/
  `requiresRestart`, revisión optimista y escritura SQLite transaccional en `GET/PATCH /api/settings`. La UI ya
  expone `Settings` agrupado por alcance. `GET/PATCH /api/settings/providers` y el endpoint de modelos muestran y
  persisten overrides validados de base URL HTTPS, timeout, auth, alias y capabilities, indicando herencia
  default/provider/model. Los tests cubren autenticación, valores desconocidos, rangos, atomicidad, conflictos,
  herencia y rechazo de URLs inseguras; los límites absolutos y la criptografía siguen en código.
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
  UTF-8 fragmentado, stream sin `[DONE]`, abort al cerrar el cliente y readiness/capabilities; el bridge continúa
  detenido y no se anuncia compatibilidad completa de Codex Desktop ni de proveedores reales.


## Bloqueos y decisiones pendientes

- El snapshot externo del legado y sus credenciales de cifrado deben conservarse durante la ventana de rollback;
  no se copia al workspace ni se modifica `freellmapi`.
- La fuente de Sentinel sigue siendo el checkout hermano `../glory-rs-rest/tools/sentinel`, pero ya quedó alineada
  y validada como release `0.7.0`: compile, suite y evidencia de staging limpio pasan; `quality:doctor` está en
  `ready: true` y no hay drift entre source, provisionado, lock y config. La independencia para un clon limpio
  sigue siendo una mejora futura de distribución, no un bloqueo del checkout actual.
- El nuevo workspace aún no tiene remoto externo; no se crea ni se publica como parte de esta fase.
- La revalidación del 2026-08-10 ejecutó `npm run canary:codex` con PASS para texto, tool loop,
  fallback Andoryyu→Zen, `foreign_toolset`/downgrade repetible sin cooldown, SSE y el upstream determinista de Unicode
  fragmentado, truncamiento y cancelación.
  La suite del bridge terminó 16/16, `npm run build` y `npm test` terminaron PASS, y no quedaron temporales
  propios. La compatibilidad E2E completa de Codex Desktop sigue pendiente: el canary validado es Codex CLI `0.146.1` aislado
  contra un upstream determinista sanitizado. Falta probar Desktop real, control VS Code, capabilities completas y
  proveedor real; el perfil principal y el bridge operativo no se activaron.

## Planes activos

- `PLAN-GLORYAPI.md` — derivación, aislamiento y migración por fases.
- `Agente/documentacion/migracion/fase-0-1-2026-08-10.md` — evidencia de Fase 0/1, overlay, backup y gate.
- `server/src/__tests__/routes/backup.test.ts` — contrato de integridad/restauración del backup.
