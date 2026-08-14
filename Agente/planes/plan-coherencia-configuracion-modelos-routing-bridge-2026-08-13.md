# Plan de coherencia: configuración, modelos, routing y Codex Bridge

Estado: implementación V2 completada localmente; checklist funcional PASS; validación de gate Sentinel bloqueada por `tool-source-missing`; E2E Desktop live pendiente

Fecha: 2026-08-13

Alcance: GloryAPI local, panel web, API de control, CLI local, telemetría y proyección del selector de Codex Desktop
No alcance de este bloque: deploy, push, cambios en ChatGPT normal o llamadas externas de producción

## Resultado de la ejecución

La arquitectura propuesta ya está implementada en el checkout local. La SQLite
operativa conserva la configuración V2 y es la fuente de verdad para Auto, las
rutas pinned y el catálogo que consume el bridge. La UI, la API administrativa
y `npm run config -w server -- ...` usan el mismo servicio transaccional con
revisión CAS y auditoría.

Cambios relevantes:

- `route:auto` es la única fuente de Auto; se eliminaron las cadenas de modelo
  hardcodeadas del camino de selección.
- El bridge recibe una proyección versionada/hashada de GloryAPI y conserva
  `auto` como identidad canónica. DeepSeek V4 Pro no aparece en DB V2, routing,
  selector ni proyección activa.
- El catálogo inicial dejó de reconciliarse destructivamente en cada reinicio:
  el bootstrap normaliza una base nueva una vez y después conserva modelos y
  prioridades gestionados por el usuario.
- El panel tiene modal por modelo; el CLI permite `snapshot`, `model-add`,
  `model-set` y `route-set` sin editar frontend/backend.
- Analytics registra modelo solicitado, ruta, revisión, motivo y confianza de
  selección para distinguir Auto, pinned y compatibilidad legacy.
- `integrations/codex-bridge/test/_e2e_apply_patch.cjs` quedó opt-in, sin
  secretos en disco fijo, con directorio temporal acotado y fuera de la suite
  automática; está listo para commit y ejecución solo con `BRIDGE_CLIENT_TOKEN`.

Validación local actual (13-ago-2026):

- `npm run build:server`: PASS.
- `npm run build -w client`: PASS; Vite conserva únicamente el warning existente
  del chunk grande.
- `npm test -w server -- --reporter=dot`: 54 archivos / 305 tests PASS.
- Suite bridge secuencial: 33 archivos / 168 tests PASS.
- `npm run bench:routing`: 128/128, p95 37.8 ms con concurrencia 32,
  presupuesto 100 ms PASS.
- CLI temporal: `snapshot`, `bridge sync` y `bridge diagnose` PASS con
  revisión/hash iguales; la prueba no expuso credenciales.
- `npm run config -w server -- snapshot`: 4 miembros activos en Auto, 6
  modelos operativos, cero DeepSeek V4 Pro y todas las ventanas anunciadas al
  bridge dentro de 150000.
- `npm run quality:doctor`, `npm run task:check` y `npm run task:check:local`:
  BLOCKED por `tool-source-missing`; el gate Sentinel no se declara PASS.

## Checklist de cierre

Este checklist es la autoridad operativa del plan. Una casilla solo se marca
cuando el comando, fixture o comportamiento indicado aporta evidencia directa.

### Fuente de verdad y persistencia

- [x] SQLite V2 conserva rutas Auto/pinned, membresías, catálogo del bridge,
  revisión global y auditoría.
- [x] UI, API y CLI llaman al mismo servicio transaccional de configuración.
- [x] CAS rechaza revisiones obsoletas sin escritura parcial.
- [x] Reiniciar una base operativa conserva un modelo añadido por el usuario.
- [x] Existe rollback de configuración por revisión validada y probado.
- [x] Existe export/import/diff/validate redactado y estable como contrato CLI.

### Routing

- [x] `model: auto` y ausencia de `model` usan solamente `route:auto`.
- [x] Un miembro Auto desactivado queda fuera de todos los candidatos Auto.
- [x] Muse y CommandCode son pinned y no entran en Auto por alias.
- [x] DeepSeek V4 Pro no aparece en catálogo V2 ni bridge activo.
- [x] El hot path de producción usa un snapshot inmutable en memoria y no
  consulta SQLite por cada request/chunk; los fixtures de test fuerzan refresh.
- [x] Cooldowns y política de fallo provienen de configuración persistida; la
  vista `PROVIDER_FAILURE_POLICY` queda solo como compatibilidad de lectura.
- [x] Proveedor activo, credencial utilizable, capacidades y lifecycle se
  validan juntos antes de seleccionar un candidato.

### Providers y modelos configurables

- [x] Un proveedor OpenAI-compatible nuevo puede agregarse, activarse,
  desactivarse y retirarse desde CLI sin editar código.
- [x] Sus endpoint, timeout, adapter y capacidades declarativas se almacenan
  con esquema tipado y consumidor runtime.
- [x] Un modelo existente puede añadirse/configurarse desde el servicio y no
  se borra al reiniciar.
- [ ] El CLI ofrece `--dry-run`, salida JSON estable, códigos documentados y
  claves de idempotencia.

### Bridge y propósito

- [x] La proyección del selector contiene revisión/hash y conserva `auto` como
  identidad canónica.
- [x] El launcher sincroniza el catálogo desde GloryAPI y escribe archivos de
  forma atómica.
- [x] Un catálogo stale se marca explícitamente y no cae silenciosamente a un
  catálogo compilado distinto.
- [ ] Auditoría, continuación, recuperación y síntesis heredan route/revisión
  del request padre.
- [x] El diagnóstico read-only compara DB, proyección, selector y router.
- [x] `_e2e_apply_patch.cjs` es opt-in, acotado y no guarda secretos en rutas
  fijas.

### UI schema-driven

- [x] El backend expone un esquema de campos tipados, etiquetas en español,
  límites, origen, reinicio y consumidor.
- [x] El modal se genera desde ese esquema y no contiene allowlists de dominio.
- [x] La UI permite editar rutas y membresías, no solo metadatos de modelo.
- [ ] El estado de sincronización del selector/stale se muestra en el panel.

### Endurecimiento y validación

- [x] Build completo, suite server y suite bridge pasan localmente.
- [x] Benchmark de routing y límites de escala del plan están versionados y
  pasan con evidencia reproducible.
- [ ] Reinicios repetidos, rollback y E2E Desktop aislado cubren Auto, pinned,
  auxiliares, tools, visión, auditoría, continuación y compactación.
- [ ] `task:check` de Sentinel pasa con el source fijado disponible.

## Respuesta directa

Existe un problema de arquitectura, no un fallo aislado del selector.

Hoy hay varias fuentes de verdad que se superponen:

- el catálogo hardcodeado del bridge;
- los alias artificiales que Codex Desktop acepta en su selector;
- el modelo por defecto del bridge;
- las cadenas hardcodeadas de `MODEL_FALLBACK_OVERRIDES`;
- `models` y `fallback_config` en SQLite;
- las listas estáticas de proveedores activos;
- los constructores de adapters;
- overrides guardados como JSON en `settings`;
- metadatos y traducciones repetidos en el frontend.

La SQLite operativa ya es una base real y persistente, pero todavía **no es la
fuente de verdad del catálogo**: durante el arranque, `normalizeGloryCatalog`
conserva preferencias de filas conocidas, elimina modelos fuera de una lista
compilada y vuelve a insertar los objetivos hardcodeados. El router también
mantiene cadenas especiales fuera de la base.

La decisión recomendada es:

> GloryAPI debe poseer una única configuración relacional, revisionada y
> transaccional. La UI y el CLI deben invocar el mismo servicio de aplicación.
> El bridge no debe decidir qué modelos existen ni qué integra Auto: solo debe
> traducir Responses y publicar una proyección del catálogo canónico al formato
> limitado de Codex Desktop.

No se recomienda una segunda base para el bridge. Se recomienda ampliar la
SQLite operativa de GloryAPI y mantener fuera de ella únicamente el sobre
mínimo de arranque: ruta de la DB, loopback/puertos, ubicación del home aislado
y referencias a secretos protegidos.

## Resultado deseado

Al terminar la ejecución futura de este plan:

1. `Auto` elegirá exclusivamente miembros activos de la ruta `auto` persistida.
2. Desactivar un miembro en Enrutamiento impedirá que cualquier request Auto lo
   use, incluidas cadenas con alias históricos.
3. Muse solo se usará si la ruta elegida lo contiene; una tarea interna de
   Codex que use un slug parecido no podrá seleccionarlo accidentalmente.
4. Un modelo retirado no podrá reaparecer por una lista, migración, caché o
   catálogo del bridge.
5. Agregar, retirar o configurar un modelo OpenAI-compatible no requerirá
   editar backend ni frontend.
6. Un agente podrá hacer los mismos cambios que la UI mediante un CLI estable,
   con `--dry-run`, validación, revisión esperada, JSON y rollback.
7. Cada solicitud explicará qué pidió el cliente, qué ruta se resolvió, qué
   modelo se eligió, por qué se eligió y con qué revisión de configuración.
8. Las capacidades, timeouts, alias, cooldowns y exposición al bridge serán
   editables en un modal por modelo, con campos generados desde esquemas del
   backend y sin allowlists duplicadas en React.

## No objetivos

- No convertir SQLite en un almacén sin tipos de JSON arbitrario.
- No permitir código, expresiones, headers o transformaciones ejecutables desde
  la base (`eval`, snippets o plugins sin firma quedan prohibidos).
- No hacer dinámico un protocolo nuevo que realmente necesita código. Añadir un
  proveedor de un adapter existente debe ser configuración; añadir un protocolo
  nuevo seguirá requiriendo implementar y probar un adapter.
- No mezclar la bóveda DPAPI con el catálogo o las exportaciones de configuración.
- No perder las defensas construidas en el bridge: traducción Responses,
  herramientas, visión, recuperación, auditoría compacta, límites, redacción,
  historiales separados y ventana anunciada de 150k para que Codex Desktop
  gestione su compactación.
- No modificar el home normal de ChatGPT.

## Flujo actual comprobado

```text
Codex Desktop
  -> lee .codex-gloryapi/models.json generado
  -> envía body.model con un slug permitido de Codex (gpt-5.x)
  -> bridge/model-catalog.js transforma pickerId -> model id de GloryAPI
  -> request-translator.js escribe chat.model
  -> GloryAPI resolveProxyModelSelection()
     -> auto/missing: cadena global de fallback
     -> id con override: MODEL_FALLBACK_OVERRIDES hardcodeado
     -> otro id: búsqueda por models.model_id
  -> router.ts elige modelo, clave y proveedor
  -> adapter OpenAI-compatible aplica endpoint, alias y quirks
```

El clasificador de propósito corre antes de la traducción, pero solo reconoce de
forma especial el contrato estructurado de título asociado a
`gpt-5.6-luna`. El resto de los slugs se interpreta como selección de modelo en
todas las solicitudes que no coincidan con esa firma.

## Hallazgos

### P0 — Auto ignora desactivaciones del panel en una ruta importante

`fallback_config.enabled` es lo que modifica la pestaña Enrutamiento. Sin
embargo, cuando el bridge envía `deepseek-v4-flash`, GloryAPI no usa esa cadena
global: `MODEL_FALLBACK_OVERRIDES['deepseek-v4-flash']` construye una cadena
desde código y solo comprueba `models.enabled = 1`.

Estado observado en la DB real:

- Andoryyu: modelo activo, miembro Auto desactivado.
- OpenCode Zen: modelo activo, miembro Auto activado.
- TokenHarbor: modelo activo, miembro Auto desactivado.
- OpenCode Go: modelo activo, miembro Auto activado.
- CommandCode Flash y Muse: modelos activos, sin fila de fallback.

A pesar de ello, la telemetría reciente contiene intentos Auto a TokenHarbor y
Andoryyu. Por tanto, el panel guarda correctamente la preferencia, pero la ruta
hardcodeada la omite. Esta es también la causa de que un modelo aparentemente
“se vuelva a activar”: no necesariamente cambia el bit; otro camino deja de
consultarlo.

### P0 — Los alias del selector mezclan presentación con identidad de routing

Codex Desktop filtra slugs personalizados, por lo que el bridge publica alias
como `gpt-5.4`, `gpt-5.6-sol` o `gpt-5.6-terra` y luego los convierte a modelos
reales. Esos slugs también pueden ser usados por tareas internas del propio
Desktop.

Consecuencia: una solicitud auxiliar que trae `gpt-5.6-terra` se interpreta
como Muse si no fue clasificada antes como otro propósito. Antes de retirarlo,
`gpt-5.6-luna` apuntaba a DeepSeek V4 Pro y coincidía con generación de títulos.

La DB histórica confirma el impacto, aunque el esquema actual no permite
atribuir cada fila a una selección visible del usuario:

- DeepSeek V4 Pro: 13 principales, 3 auditorías y 7 continuaciones; más de
  1,25M tokens de entrada acumulados.
- Muse: 33 principales, 6 auditorías y 14 continuaciones; más de 2,84M tokens
  de entrada acumulados.

El punto arquitectónico confirmado no es que el router Auto haya incluido
Muse. Muse no está en `fallback_config`. El bridge pudo convertir un slug
interno de Codex en Muse **antes** de llegar al router; después, auditorías y
continuaciones heredaron ese modelo.

### P0 — No hay trazabilidad suficiente para demostrar la intención

`requests` conserva proveedor, modelo final, tipo de request y relación padre,
pero no conserva:

- slug recibido del cliente;
- ruta solicitada;
- ruta resuelta;
- razón de selección;
- revisión/hash de configuración;
- propósito detectado y confianza de la clasificación;
- secuencia completa de exclusiones antes del resultado.

Por eso una fila de Muse no permite distinguir retrospectivamente “Muse elegido
por el usuario” de “slug interno convertido por el bridge”. La arquitectura
debe hacer esa diferencia observable, no inferirla por hora o por nombre.

### P1 — La base existe, pero el código sigue mandando sobre ella

- `normalizeGloryCatalog` contiene la lista final de modelos y elimina los
  demás durante el arranque.
- `ACTIVE_PROVIDER_PLATFORMS` y `ACTIVE_PROVIDER_DEFINITIONS` contienen la lista
  operativa de proveedores, endpoints, capacidades y timeouts.
- `providers/index.ts` vuelve a construir adapters y quirks por plataforma.
- `activateProviderDraft` rechaza un proveedor que no esté previamente en la
  lista compilada y exige coincidencia exacta con esa definición.
- `MODEL_FALLBACK_OVERRIDES` define rutas adicionales fuera de SQLite.
- `PROVIDER_FAILURE_POLICY` define cooldowns fuera de Settings.

La UI puede crear drafts y descubrir modelos, pero hoy no puede convertir un
proveedor OpenAI-compatible nuevo en proveedor operativo sin editar código.

### P1 — “Auto” representa dos conceptos distintos

El selector publica:

- `Auto (router de GloryAPI)`;
- `DeepSeek V4 Flash (Auto)`.

Ambos acaban enviando normalmente `deepseek-v4-flash`, porque el `auto` del
bridge se sustituye por `config.upstream.model`. GloryAPI recibe entonces una
ruta con nombre de modelo y aplica el override hardcodeado. El servidor ya
acepta `model: auto`, pero el bridge no conserva ese identificador.

Debe existir un único concepto canónico:

- `route:auto` es una política de routing;
- `provider/model` es una identidad de ejecución;
- una entrada del selector es una presentación que referencia una ruta.

### P1 — Hay tres flags de activación con semántica parcialmente solapada

- `models.enabled` habilita la identidad de modelo.
- `fallback_config.enabled` habilita su pertenencia a la única cadena global.
- `provider_runtime_state.enabled` habilita el proveedor; si no existe fila,
  el registro asume `true`.

Una ruta hardcodeada consulta solo una parte de esos estados. El nuevo contrato
debe exigir simultáneamente proveedor activo, modelo activo, miembro de ruta
activo, credencial utilizable y capacidades compatibles.

### P1 — El bridge mantiene otro catálogo y otra configuración

`DEFAULT_MODEL_CATALOG`, `PICKER_IDS`, `DESCRIPTIONS`, `BRIDGE_MODEL`, el modelo
escrito por `prepare-isolated-home.ps1`, `models.json` y `models_cache.json`
pueden divergir. Los artefactos generados no incluyen una revisión/hash de la
configuración de GloryAPI que permita detectar obsolescencia.

Además, un JSON inválido en `BRIDGE_MODEL_CATALOG_JSON` vuelve silenciosamente
al catálogo compilado. Para routing y facturación, ese fallback silencioso no
es aceptable.

### P1 — El retiro operativo de Pro dejó referencias semánticas y tests obsoletos

El catálogo activo ya contiene seis entradas y GloryAPI rechaza
`deepseek/deepseek-v4-pro`, pero el repositorio todavía conserva
`gpt-5.6-luna` como alias interno de título y tres tests del generador esperan
un séptimo modelo. Por eso la suite específica del bridge falla aunque Pro ya
no sea seleccionable.

No se debe reintroducir Pro para hacer verdes esos tests. La corrección futura
es separar propósito de alias, actualizar las fixtures al catálogo canónico y
añadir una búsqueda negativa que impida que el modelo retirado reaparezca como
entrada activa. Las referencias históricas en analytics/documentación podrán
conservarse cuando estén claramente marcadas como historia.

### P1 — Parte de la configuración visible no tiene una ruta efectiva clara

La pantalla de Configuración guarda overrides de capacidades por proveedor y
modelo. El transporte efectivo consume URL, timeout, auth y alias; la evidencia
auditada no demuestra que las capacidades sobrescritas se usen de manera
uniforme en todos los gates de routing. Antes de conservar esos campos como
controles operativos, la ejecución debe probar qué consumidor aplica cada uno.

### P2 — El frontend conoce demasiado del dominio

React mantiene traducciones por clave, límites de inputs y formularios
específicos para URL, timeout y alias. Esto obliga a tocar frontend al añadir
campos y permite que la UI prometa controles que el runtime no consume.

La UI debe recibir un esquema de formulario en español desde el backend y usar
componentes genéricos por tipo. El frontend seguirá teniendo diseño y UX, pero
no listas de modelos, providers, claves de settings ni reglas de negocio.

## Evidencia reproducible de la auditoría

Esta evidencia se capturó el 2026-08-13 (America/Caracas), contra el commit
`b669269c0413f61c9fd6e340d862f1bbeaaecf6a`. Las fechas almacenadas por SQLite
se muestran en UTC. No se leyeron ni imprimieron credenciales.

### Código y contratos

- `server/src/routes/proxy-routing.ts:9` declara
  `MODEL_FALLBACK_OVERRIDES` fuera de la DB.
- `server/src/routes/routing/proxy-selection.ts:28-58` toma esa cadena y busca
  sus modelos sin requerir que `fallback_config.enabled` esté activo; la unión
  con `fallback_config` pertenece al camino posterior de selección normal.
- `integrations/codex-bridge/bridge/model-catalog.js:42-87` asigna aliases
  `gpt-5.x`, y `resolveModelSelection` en la línea 176 acepta indistintamente
  el ID real o el `pickerId`.
- `integrations/codex-bridge/bridge/request-classifier.js:3` conserva
  `gpt-5.6-luna` como alias de título por defecto, lo que demuestra que los
  slugs también tienen semántica interna independiente del selector visible.
- `server/src/db/catalog/normalize.ts:4-151` define `targetModels`, elimina
  modelos/fallbacks fuera de esa lista y vuelve a sembrar el catálogo.
- `server/src/providers/registry.ts:12-185` y
  `server/src/providers/index.ts:7-324` repiten plataformas, definiciones e
  instancias en código.

### Consulta read-only de la DB operativa

La DB se abrió con `better-sqlite3` usando `{ readonly: true,
fileMustExist: true }` en `%USERPROFILE%\.gloryapi\gloryapi.db`. Consulta
reproducible del estado de routing:

```sql
SELECT m.platform, m.model_id, m.enabled AS model_enabled,
       fc.priority, fc.enabled AS route_enabled
FROM models m
LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
ORDER BY COALESCE(fc.priority, 999), m.platform, m.model_id;
```

Resultado relevante:

- Andoryyu y TokenHarbor: `model_enabled = 1`, `route_enabled = 0`.
- OpenCode Zen y OpenCode Go: `model_enabled = 1`, `route_enabled = 1`.
- CommandCode Flash y Muse: `model_enabled = 1`, sin membresía de fallback.
- `provider_runtime_state` no tenía filas y `settings` solo aportaba
  `routing_revision = 7` entre las claves de routing/provider/model consultadas.

Consulta agregada de los modelos inesperados:

```sql
SELECT platform, model_id, request_kind, status,
       COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
       MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
FROM requests
WHERE model_id IN (
  'deepseek/deepseek-v4-pro',
  'meta/muse-spark-1.2-contributor'
)
GROUP BY platform, model_id, request_kind, status;
```

La suma observada fue 23 requests de Pro entre principal, auditoría y
continuación, y 53 de Muse. Las entradas acumuladas superan respectivamente
1,25M y 2,84M tokens. También existen requests de Andoryyu y TokenHarbor hasta
el 2026-08-14 00:03:57Z y 00:02:39Z.

### Límite de esta evidencia

Las filas de `requests` demuestran ejecución, no la intención del selector ni
el instante exacto en que se desactivó cada miembro: `settings_audit` estaba
vacío y el esquema no guarda el slug recibido. La conclusión demostrada es más
acotada: existe un camino de código capaz de ignorar `route_enabled`, existen
ejecuciones de esos providers y existe un mapping capaz de convertir aliases
internos en modelos pinned. La Fase 0 debe aportar la correlación por request
antes de atribuir causalidad a cada fila histórica.

### Baseline de validación

- `npm run build`: PASS en shared, server y client; warning informativo de chunk
  Vite mayor de 500 kB.
- `npm test`: PASS, 53 archivos y 296 tests de server; shared/client compilan.
- `node --test --test-concurrency=1
  integrations/codex-bridge/test/*.test.cjs
  integrations/codex-bridge/test/security/*.test.cjs`: 167/170 PASS. Los tres
  fallos están en `model-catalog-build.test.cjs` y esperan siete entradas,
  incluida `gpt-5.6-luna`, mientras el catálogo retirado correctamente devuelve
  seis. Se registra como defecto preexistente y parte directa de este plan, no
  como PASS.
- `npm run task:check -- GLORY-BASELINE`: bloqueado antes del análisis por
  `tool-source-missing`; el `sourcePath` fijado de Sentinel no existe. No se
  sustituye por otro binario ni se declara gate PASS.

## Decisión de arquitectura

### 1. Una fuente de verdad relacional

La SQLite operativa será la autoridad para configuración efectiva. No se
creará una DB paralela del bridge.

Entidades mínimas:

- `config_revisions`: revisión, hash, actor, origen, fecha y resumen redacted.
- `providers`: identidad, lifecycle, adapter, endpoint, auth, enabled y
  configuración declarativa del transporte.
- `models`: proveedor, wire id, alias upstream, nombre, lifecycle, enabled,
  capacidades y límites.
- `routes`: id estable, nombre, tipo (`auto`, `pinned`, `policy`), enabled,
  visibilidad y reglas generales.
- `route_members`: ruta, modelo, prioridad, enabled y política de fallo.
- `client_catalog_entries`: integración, slug externo, ruta, etiqueta,
  visibilidad, orden y capacidades anunciadas.
- `integration_settings`: valores tipados del bridge y otras integraciones.
- `configuration_audit`: diff redacted y resultado de validación/aplicación.

Las tablas actuales se migrarán de forma aditiva. No se borrarán al crear V2.
Los IDs analíticos históricos se conservarán mediante lifecycle `retired`; no
se hará borrado físico de modelos referenciados por solicitudes.

### 2. Esquemas tipados, no JSON libre

Los valores viven en DB; el contrato de campos soportados vive en módulos de
dominio del backend porque cada setting necesita un consumidor real.

Cada definición expondrá:

- clave estable;
- tipo, enum, mínimo/máximo y valor predeterminado;
- etiqueta y descripción en español;
- scope y nivel de herencia;
- si requiere reinicio;
- si es sensible;
- consumidor runtime responsable;
- evidencia o capability necesaria.

Esto elimina hardcodeo del frontend sin fingir que una funcionalidad nueva
puede existir solo por guardar un JSON.

### 3. Routing basado únicamente en rutas persistidas

El router recibirá un `RoutingSnapshot` inmutable al empezar cada request. No
consultará listas especiales por modelo.

Para resolver un miembro se deben cumplir todas estas invariantes:

1. ruta activa;
2. miembro de ruta activo;
3. modelo activo y no retirado;
4. proveedor activo;
5. adapter registrado para el tipo declarado;
6. credencial utilizable o acceso anónimo declarado;
7. capacidades suficientes para la solicitud;
8. health/cooldown dentro de la política del miembro.

Una ruta pinned tendrá normalmente un miembro. Si se desea fallback explícito,
se configurará visiblemente como miembros adicionales; nunca caerá por accidente
en una cadena global.

### 4. Auto significa solo `route:auto`

El bridge enviará el identificador canónico `auto`, no el modelo predeterminado
`deepseek-v4-flash`. GloryAPI resolverá únicamente los miembros de esa ruta.

Con el estado actual de la DB, la migración inicial de Auto debe contener
OpenCode Zen y OpenCode Go porque son los miembros habilitados. Andoryyu y
TokenHarbor se conservarán como modelos disponibles pero fuera de Auto mientras
sus flags actuales estén apagados. CommandCode Flash y Muse seguirán pinned.

No se incluirá DeepSeek V4 Pro en ninguna tabla V2, proyección o bootstrap.

### 5. Presentación de cliente separada de identidad

Los slugs `gpt-5.x` serán aliases de presentación limitados al adapter de Codex
Desktop. No serán IDs de modelos ni claves de rutas.

La resolución seguirá este orden:

```text
clasificar propósito
  -> resolver o heredar ruta
  -> validar revisión de catálogo
  -> resolver miembros de la ruta
  -> elegir proveedor/modelo
  -> ejecutar
```

Nunca se resolverá primero `pickerId -> provider/model` y después se intentará
adivinar el propósito.

### 6. Política para solicitudes auxiliares

- Títulos inequívocos seguirán resolviéndose localmente.
- Auditoría, continuación, recuperación y síntesis heredarán `routeId` y
  `configRevision` de la solicitud padre.
- Una solicitud auxiliar iniciada por Desktop usará una ruta de sistema
  configurable, por defecto `auto`; su slug interno no podrá seleccionar una
  ruta pinned o de pago.
- Una clasificación ambigua será fail-closed: Auto o error estructurado según
  la política, nunca un modelo pinned inferido por alias.
- Si Codex Desktop no entrega un identificador estable de conversación, se
  definirá una correlación bounded basada en los campos estructurales
  disponibles; la fase de observabilidad debe demostrarla antes del cutover.

### 7. Proyección del bridge, no catálogo propio

GloryAPI expondrá una proyección versionada, por ejemplo:

```text
GET /api/integrations/codex-bridge/catalog
```

La respuesta contendrá revisión, hash, rutas visibles y mapping de aliases. El
launcher generará `models.json` y `models_cache.json` atómicamente desde esa
proyección. El bridge validará al arrancar que la revisión local coincide con
GloryAPI.

Si GloryAPI no está disponible:

- se puede usar el último artefacto válido firmado con revisión/hash;
- el estado será `stale` y visible;
- nunca se volverá a un catálogo compilado distinto;
- un cambio que retire un modelo invalidará la publicación anterior y exigirá
  regeneración antes de aceptar requests.

El selector puede necesitar reiniciar la ventana de Codex para reflejar nuevas
entradas, pero el launcher hará la sincronización automáticamente. La UI podrá
mostrar “selector sincronizado / actualización pendiente”; no pedirá editar
archivos manualmente.

### 8. Providers dinámicos dentro de adapters permitidos

El registro de código conservará factories por protocolo/adapter, no instancias
por plataforma:

- `openai-compatible`;
- `google-gemini`;
- adapters especiales que realmente tengan otro contrato.

Endpoint, timeout, aliases, reasoning máximo, inclusión de usage, buffering y
normalizadores se expresarán mediante opciones declarativas validadas y enums
permitidos. No se permitirán funciones almacenadas en DB.

Agregar un proveedor OpenAI-compatible será una transacción de configuración.
Agregar un protocolo nuevo seguirá requiriendo código y contract tests.

### 9. Un servicio para UI y CLI

Se creará un `ConfigurationService` con repositorios e interfaces claras. Tanto
las rutas HTTP como el CLI llamarán ese servicio; ninguno escribirá SQL por su
cuenta.

Operaciones mínimas del CLI:

```text
gloryctl config snapshot --json
gloryctl config export --redact --output glory-config.json
gloryctl config validate glory-config.json
gloryctl config diff glory-config.json
gloryctl config apply glory-config.json --expected-revision <n>
gloryctl provider add|edit|enable|disable|retire ...
gloryctl model add|edit|enable|disable|retire ...
gloryctl route list|show|add|edit ...
gloryctl route member add|remove|enable|disable|move ...
gloryctl bridge catalog|status|sync ...
gloryctl config rollback --to-revision <n>
```

Requisitos del CLI:

- salida humana en español y `--json` estable;
- códigos de salida documentados;
- `--dry-run` en operaciones compuestas;
- control optimista con revisión esperada;
- auth local obtenida sin imprimir la clave;
- ninguna escritura directa de secretos en archivos o argumentos de proceso;
- idempotencia para que un agente pueda repetir comandos con seguridad.

Contrato de concurrencia para UI, API y CLI:

1. Validar y compilar la propuesta fuera de la transacción cuando sea posible.
2. Abrir `BEGIN IMMEDIATE` con `busy_timeout` acotado a 2 segundos.
3. Leer la revisión global dentro de la transacción y compararla con
   `expectedRevision`.
4. Ante divergencia, hacer rollback y devolver 409 con revisión actual y diff
   redacted; no sobrescribir ni fusionar implícitamente.
5. Escribir todas las entidades, el audit y el incremento único de revisión en
   la misma transacción; publicar el snapshot solo después de `COMMIT`.
6. Ante `SQLITE_BUSY`, devolver 503 `configuration_write_busy` con
   `retryAfterMs`; no ocultar el fallo mediante reintentos indefinidos.

El servicio tendrá una cola de escritura bounded de máximo 8 operaciones. Una
novena operación pendiente recibe 429. Los límites seleccionables serán
configuración tipada; los techos de seguridad seguirán siendo invariantes del
dominio. Una prueba con dos procesos escritores debe demostrar exactamente un
commit, un 409 determinista y ninguna revisión parcial.

### 10. Modal de configuración por modelo

La fila reutilizable de Enrutamiento conservará drag-and-drop y switch. Añadirá
una acción `Configurar` que abre un modal generado desde el esquema del backend.

Secciones previstas:

- Identidad: proveedor, wire id, alias upstream, nombre y lifecycle.
- Routing: rutas a las que pertenece, prioridad, enabled y política de fallo.
- Capacidades: texto, visión, tools, streaming, reasoning y contexto anunciado.
- Transporte: timeout y flags declarativos permitidos.
- Bridge: visible en selector, etiqueta, orden, alias de presentación y límite
  anunciado de 150k.
- Diagnóstico: revisión efectiva, origen heredado de cada valor, última prueba y
  requests recientes.

El frontend no conocerá slugs de provider/model ni claves concretas de setting.
Solo mapeará tipos de campo a componentes existentes del sistema de diseño.

## SOLID

### Responsabilidad única

- `ConfigurationRepository`: persistencia y transacciones.
- `ConfigurationService`: invariantes y casos de uso.
- `RoutingSnapshotBuilder`: compila configuración a una vista inmutable.
- `RouteResolver`: elige candidatos, sin leer UI ni bridge.
- `AdapterFactory`: construye transports desde definiciones validadas.
- `CodexCatalogProjector`: convierte rutas visibles al formato del Desktop.
- `RequestPurposeClassifier`: clasifica propósito; no selecciona providers.
- `gloryctl`: cliente de aplicación; no contiene reglas duplicadas.

### Abierto/cerrado

Un provider de un adapter existente se agrega mediante datos. Un adapter nuevo
extiende una interfaz y su suite contractual sin modificar el router.

### Sustitución

Todos los adapters deben respetar identidad efectiva, streaming, abort,
timeouts, errores tipados y telemetría. Ningún provider puede devolver un
modelo distinto sin disparar el guard de identidad.

### Segregación de interfaces

Separar contratos de catálogo, routing, transporte, capabilities,
observabilidad y proyección del cliente. El bridge no debe importar repositorios
de DB y el router no debe conocer el formato de `models.json`.

### Inversión de dependencias

El hot path depende de `ConfigurationSnapshot`, no de SQLite ni de Express. UI,
CLI y HTTP dependen del servicio, no al revés.

## Eficiencia y escala

Objetivo local inicial:

- hasta 100 providers;
- hasta 1.000 modelos;
- hasta 100 rutas y 10.000 membresías;
- máximo configurable de 32 miembros por ruta y techo absoluto de 256;
- 32 requests concurrentes;
- menos de una escritura de configuración por segundo;
- cero consultas de configuración por chunk SSE.

La configuración se valida y compila al cambiar. Cada request captura una
referencia a un snapshot inmutable. Resolver una ruta cuesta O(miembros de la
ruta), no O(catálogo completo). El snapshot se intercambia atómicamente y los
requests en curso terminan con su revisión original.

SLO del benchmark sobre una máquina de referencia documentada:

- compilación de un snapshot máximo: p95 <= 100 ms y <= 32 MiB adicionales de
  RSS;
- resolución en memoria de una ruta de 256 miembros: p95 <= 1 ms y p99 <= 3 ms,
  sin contar I/O del proveedor;
- aplicación transaccional de configuración válida: p95 <= 250 ms sin
  contención;
- con 32 requests concurrentes, p95 del overhead interno de routing <= 5 ms y
  ninguna lectura de SQLite en el hot path;
- fallo explícito de validación al superar los límites, sin truncar miembros.

Los umbrales y la máquina se versionarán junto al benchmark. En entornos
distintos se comparará además contra el baseline del mismo host y fallará una
regresión superior al 20 %, para no confundir ruido de hardware con mejora.

No se diseñará ahora coordinación distribuida multi-instancia. Se dejarán
interfaces de repositorio/eventos para no acoplar el dominio a SQLite, pero un
bus remoto sería YAGNI sin un segundo proceso escritor real.

## Seguridad

- SQLite conserva referencias y metadatos; los secretos siguen en la bóveda
  DPAPI.
- Exportaciones y auditoría son redacted por defecto.
- Endpoints siguen bajo auth administrativa local y loopback.
- URLs se validan y se revalidan al conectar contra DNS rebinding/SSRF.
- Config importada tiene límites de tamaño, schemas estrictos y claves
  desconocidas rechazadas.
- No se aceptan transformaciones ejecutables, regex sin límites ni headers
  arbitrarios. Los comportamientos son enums allowlisted.
- Cambios sensibles requieren revisión esperada, diff y audit trail.
- Rollback restaura una revisión validada; nunca copia una DB por encima de un
  proceso activo.

## Fases de ejecución

### Fase 0 — Contrato y observabilidad antes del cambio

- Documentar formalmente `Model`, `Route`, `RouteMember`, `ClientCatalogEntry`
  y `RequestPurpose`.
- Añadir telemetría de `requestedClientModel`, `requestedRouteId`,
  `resolvedRouteId`, `selectionReason`, `configRevision` y confianza del
  clasificador.
- Crear un diagnóstico read-only que compare catálogo del bridge, proyección,
  DB y router y falle ante divergencias.
- Capturar fixtures redacted de solicitudes principales y auxiliares reales de
  Codex Desktop.
- Inventariar todas las referencias activas e históricas de modelos retirados y
  corregir las expectativas obsoletas del catálogo sin reintroducir Pro.

Gate: todavía no cambia la selección; el diagnóstico debe reproducir la
incoherencia Auto/flags y la colisión de aliases.

### Fase 1 — Esquema V2 y migración aditiva

- Crear tablas V2, FKs, índices, lifecycle y revisión global.
- Migrar providers/modelos sin alterar IDs históricos.
- Crear rutas `auto`, `commandcode-flash` y `commandcode-muse`.
- Poblar `auto` solo desde miembros actualmente habilitados.
- Crear una vista/snapshot V2 y un comparador legacy/V2.
- No activar todavía el lector V2 en producción local.

Gate: migración idempotente, reinicio preserva cambios y cero secretos en
snapshots/exportaciones.

### Fase 2 — Servicio de configuración y CLI

- Implementar repositorio, servicio, validadores, revisiones, diff y rollback.
- Exponer schemas y snapshot efectivos desde API.
- Implementar `gloryctl` sobre el mismo servicio/API.
- Añadir `--dry-run`, JSON, idempotency keys y conflictos 409.
- Implementar compare-and-swap transaccional, timeout/503 y cola bounded.

Gate: la misma fixture aplicada por UI/API/CLI produce el mismo hash y snapshot;
dos procesos escritores producen exactamente un commit y un 409, y un lock
ocupado excediendo 2 segundos produce 503 sin escritura parcial.

### Fase 3 — Router por rutas persistidas

- Habilitar shadow read: resolver V1 y V2 sin duplicar requests externas.
- Comparar candidatos y explicar divergencias.
- Cambiar el hot path a V2 cuando las fixtures sean equivalentes salvo las
  incoherencias que este plan corrige.
- Retirar `MODEL_FALLBACK_OVERRIDES` y mover cooldowns a miembros/provider.
- Hacer que `model: auto` preserve `route:auto` de extremo a extremo.

Gate: un miembro desactivado nunca aparece como intento; Muse y CommandCode no
entran en Auto salvo configuración explícita.

### Fase 4 — Proyección y correlación del bridge

- Sustituir `DEFAULT_MODEL_CATALOG`, `PICKER_IDS` y `DESCRIPTIONS` por la
  proyección versionada de GloryAPI.
- Clasificar propósito antes de resolver aliases.
- Hacer que hijos hereden route/revision del padre.
- Configurar una ruta auxiliar segura y registrar ambigüedad.
- Retirar la dependencia de `gpt-5.6-luna` para detectar títulos; el propósito
  se resolverá por contrato estructurado y correlación, no por modelo.
- Generar archivos del picker atómicamente con revisión/hash y estado stale.
- Sincronizar desde el launcher y mostrar actualización pendiente en UI.

Gate: una solicitud interna con `gpt-5.6-terra` bajo Auto no llega a Muse; una
selección explícita de Muse sí llega únicamente a Muse.

### Fase 5 — Providers y modelos realmente configurables

- Sustituir listas por plataforma por factories de adapter.
- Mover opciones declarativas de transporte a configuración validada.
- Hacer operativa la activación de drafts para adapters existentes.
- Retirar la normalización destructiva del catálogo al arrancar.
- Convertir el seed en bootstrap explícito de DB vacía o `config apply`, no en
  reconciliación que borra decisiones.

Gate: agregar y retirar un provider/modelo OpenAI-compatible mediante CLI sin
editar código; reiniciar no revierte la operación.

### Fase 6 — UI schema-driven y modal por modelo

- Reutilizar `SortableModelRow`, Dialog, inputs, switches y tokens existentes.
- Añadir modal por modelo y editor de rutas.
- Renderizar settings desde schema backend en español.
- Mostrar valor efectivo, origen, revisión y requisito de reinicio.
- Eliminar traducciones y allowlists de dominio duplicadas en React.

Gate: una configuración realizada en UI se refleja igual en CLI/snapshot y
viceversa, sin recargar manualmente datos del frontend.

### Fase 7 — Retirada de compatibilidad y endurecimiento

- Eliminar lectores V1, tablas/vistas obsoletas cuando no tengan consumidores.
- Eliminar catálogo compilado, overrides especiales y listas duplicadas.
- Añadir auditoría de hardcodes prohibidos y consistencia de proyección.
- Añadir un guard que distinga referencias históricas permitidas de referencias
  operativas prohibidas a DeepSeek V4 Pro y aliases retirados.
- Actualizar ADR-002 y ADR-004 con la nueva semántica.

Gate: una búsqueda controlada no encuentra modelos/providers activos fuera de
fixtures, bootstrap explícito o tests negativos.

### Fase 8 — Validación funcional y cierre

- Suite unitaria, integración server, bridge y frontend.
- Build completo.
- Benchmark de routing con 8/16/32 concurrentes, límites máximos y SLO p50,
  p95, p99 y memoria definidos en este plan.
- Reinicios repetidos con DB real clonada y rollback de revisión.
- E2E Desktop con home aislado para Auto, pinned, auxiliar, tools, visión,
  auditoría, continuación y compactación.
- Gate Sentinel si el runtime fijado vuelve a estar disponible; si sigue
  `tool-source-missing`, registrar la limitación sin declarar PASS.

## Matriz mínima de regresión

1. Auto con Zen y Go activos: solo Zen/Go son candidatos.
2. Auto con TokenHarbor desactivado: cero intentos TokenHarbor tras reinicio.
3. Auto con todos los miembros desactivados: error explícito, sin fallback
   oculto.
4. Muse pinned: solo CommandCode/Muse.
5. Flash CommandCode pinned: solo CommandCode/Flash.
6. Alias interno de título: respuesta local, cero request facturable.
7. Alias interno Terra bajo Auto: conserva Auto, cero Muse.
8. Auditoría/continuación: hereda la ruta del padre.
9. Pro retirado: no aparece en DB activa, proyección, selector ni routing.
10. Modelo nuevo por CLI: aparece en UI; no entra en Auto hasta agregar miembro.
11. Cambio por modal: CLI ve la misma revisión y valor efectivo.
12. Dos escritores con la misma revisión: uno gana y el otro recibe 409.
13. Config inválida: ninguna escritura parcial.
14. Reinicio: no altera prioridades, flags ni lifecycle.
15. Catálogo local stale: bridge lo informa y no revive un modelo retirado.
16. Dos procesos de configuración: exactamente uno hace commit y el otro recibe
    409; con lock excedido se obtiene 503 acotado.
17. Ruta con 257 miembros: rechazo atómico; nunca truncamiento silencioso.

## Rollout y rollback

- Antes de migrar: backup por la API de mantenimiento, hash y copia externa
  autorizada.
- V2 entra primero en shadow mode, sin duplicar llamadas a proveedores.
- El cutover del lector se hace con revisión fija y puede volver temporalmente
  a V1 mientras ambas estructuras existan.
- No habrá dual-write prolongado. Tras el cutover, V1 queda read-only hasta
  superar el E2E y luego se retira.
- Rollback funcional restaura la revisión de configuración; rollback de schema
  usa migración forward correctiva, no reemplazo destructivo de la DB activa.
- Los artefactos del bridge llevan revisión/hash, por lo que rollback también
  regenera la proyección correspondiente.

## Archivos y responsabilidades que se espera modificar al ejecutar

Nuevos módulos previstos:

- dominio/configuración V2;
- repositorio SQLite V2;
- compilador de snapshots;
- proyector Codex Desktop;
- CLI `gloryctl`;
- schemas de formularios/configuración.

Módulos actuales a simplificar o retirar:

- `server/src/db/catalog/normalize.ts` como reconciliador destructivo;
- `server/src/routes/proxy-routing.ts` para overrides/políticas estáticas;
- listas de providers en `server/src/providers/registry.ts`;
- instancias por plataforma en `server/src/providers/index.ts`;
- `integrations/codex-bridge/bridge/model-catalog.js` como catálogo propietario;
- lista/descripciones de `build-model-catalog.cjs`;
- traducciones por clave en `client/src/hooks/useSettingsPage.ts`.

Módulos que se conservan y se conectan al nuevo contrato:

- traducción Responses y SSE del bridge;
- aislamiento de homes/historiales;
- bóveda DPAPI;
- adapters y guards de identidad;
- trazas de routing y Analytics;
- Settings revision/audit como patrón, ampliado a revisión global;
- `SortableModelRow` y sistema visual existente.

## Criterios de aceptación finales

- Una sola revisión/hash explica catálogo, rutas, settings y proyección bridge.
- Auto usa únicamente `route_members` activos de `route:auto`.
- No existe una ruta alternativa hardcodeada que ignore flags de DB.
- Un alias del Desktop nunca decide por sí solo un provider/modelo para una
  solicitud auxiliar.
- UI y CLI ofrecen el mismo dominio, validación y resultado.
- Agregar/quitar un modelo de un adapter existente no requiere cambios de
  código ni frontend.
- Agregar una opción soportada requiere backend/schema/consumidor, pero no un
  formulario React específico.
- Reiniciar GloryAPI o el bridge no revierte preferencias.
- Analytics permite reconstruir intención, ruta, selección y revisión.
- No se filtran secretos ni se debilitan loopback, SSRF, timeouts o límites.
- Las escrituras UI/CLI son compare-and-swap atómicas, bounded y observables.
- Los benchmarks cumplen límites de ruta, SLO de latencia y presupuesto de
  memoria documentados.
- Tests y E2E cubren explícitamente las dos regresiones originales: miembros
  Auto desactivados y aliases internos convertidos a modelos pinned.

## Riesgos abiertos

- Codex Desktop no documenta un identificador de intención del selector para
  todas sus tareas internas. Antes del cutover se necesitan fixtures redacted
  de título, compactación, revisión y tareas principales. Si dos clases fueran
  indistinguibles, una selección pinned deberá exigir un binding de sesión
  explícito o un perfil aislado adicional; nunca se resolverá por intuición.
- El selector puede no recargar `models.json` en caliente. La configuración
  seguirá siendo central, pero la UI debe distinguir “guardado en GloryAPI” de
  “publicado al cliente” y “cargado por Desktop”.
- La configuración dinámica de quirks debe limitarse a un vocabulario seguro.
  Un provider que necesite lógica nueva no se debe forzar dentro del adapter
  genérico.
- Sentinel continúa sujeto a la disponibilidad de su source externo fijado; no
  se usará una instalación diferente para simular el gate.

## Siguiente acción

Revisar el diff y hacer el commit local del bloque. Después, al reiniciar el
bridge, validar en Desktop el catálogo aislado y una llamada Auto/pinned; esa
prueba live queda separada del PASS local porque requiere el runtime de
ChatGPT Bridge activo. Si se necesita cerrar el gate Sentinel, primero hay que
restaurar el `sourcePath` fijado; no se sustituye por otra instalación.
