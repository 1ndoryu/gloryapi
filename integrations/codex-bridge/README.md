# Bridge local de Codex para GloryAPI

`bridge/` es la única carpeta física del bridge. La ruta esperada por Codex,
`%USERPROFILE%\.codex\bridge`, es un junction de Windows hacia esa carpeta: no hay
copia instalada ni paso de sincronización.

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
- La búsqueda web se resuelve mediante un bucle interno conforme al patrón de function
  calling: llamada upstream, `assistant.tool_calls`, búsqueda, mensaje `role=tool` y
  segunda llamada upstream. Codex Desktop recibe la respuesta final; el bridge no
  fabrica un `function_call_output` dentro de `response.output`.
- La descarga de URLs arbitrarias está deshabilitada para evitar SSRF. Los resultados
  de búsqueda se marcan como contenido web no confiable.

## Seguridad por defecto

- No hay claves embebidas. El sidecar exige `BRIDGE_CLIENT_TOKEN` para
  Codex→sidecar y usa por separado `GLORY_API_KEY` (o `FREEL_API_KEY` transitorio)
  para sidecar→GloryAPI; nunca reenvía ciegamente el bearer del cliente.
  Visión requiere `VISION_API_KEY` explícita.
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
el helper solo acepta esa fila DPAPI y falla cerrado si falta. `server/data`
conserva además ACL explícita sin herencia (solo Owner, SYSTEM y Administrators)
como defensa en profundidad. El helper abre SQLite en modo `readonly` y no tiene
código de escritura.
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
```

El mismo mecanismo está disponible sin el wrapper:

```powershell
.\start-bridge.ps1 -Restart     # detiene el bridge actual y lo inicia de nuevo
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

## Perfil temporal de canary

Para preparar una prueba real sin tocar el perfil principal:

```powershell
.\mode\prepare-canary-profile.ps1
codex --profile gloryapi-canary
```

El script escribe únicamente `%CODEX_HOME%\gloryapi-canary.config.toml`, usa
`model_providers.<id>.auth.command` y no contiene `experimental_bearer_token` ni
ningún secreto. No reemplaza `config.toml`; `-Force` solo permite regenerar ese
perfil temporal. El canary debe ejecutarse con GloryAPI y el bridge ya listos, y
su rollback es seleccionar el perfil ChatGPT y detener el bridge. La evidencia
E2E sigue siendo obligatoria antes de declarar compatibilidad con Codex Desktop.

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

El controlador `mode/codex-mode.ps1` vuelve a ejecutar esa validación antes de un
cambio real a DeepSeek y se detiene antes de arrancar procesos o reemplazar
`config.toml` si falla. Para revisar el resultado sin mutar nada:

```powershell
.\mode\codex-mode.ps1 -Mode deepseek -Preview
```

Si el preflight vuelve a marcar `target-not-gloryapi`, no debe ejecutarse ningún
script desde `%USERPROFILE%\.codex` hasta restaurar el enlace a GloryAPI; esa fue la
protección que evitó repetir el incidente del controlador legacy.

El preflight también comprueba dos prerrequisitos de runtime que antes solo se
detectaban después de intentar arrancar: los helpers compilados de auth y la
presencia de una credencial upstream en el entorno o en la bóveda local. Solo
informa presencia/ausencia; nunca imprime ni persiste el valor. Por tanto,
`-SkipHealth` ya no puede dar un falso "listo" cuando el bridge no puede resolver
su token DPAPI ni la clave unificada.

## Runbook de cutover (ejecutado localmente; Desktop E2E pendiente)

La operación local del 2026-08-10 siguió este orden reversible:

1. Registrar hashes de `config.toml`, `config.chatgpt.toml`, los cuatro enlaces y
   cualquier journal existente; detener la operación si falta el snapshot.
2. Ejecutar este preflight desde la fuente GloryAPI; devolvió `ready=true` sin
   `target-not-gloryapi`, perfil legacy ni secretos bearer.
3. Alinear los cuatro enlaces con GloryAPI mediante una operación explícita y
   verificable; no editar ni copiar `freellmapi`.
4. Generar el perfil temporal `gloryapi-canary`, iniciar el bridge con identidad
   `gloryapi-codex-bridge` y repetir `/health`, `/ready` y `/capabilities`.
5. Probar una solicitud real Node → bridge → GloryAPI → Andoryyu; devolvió HTTP 200
   con el modelo `deepseek-v4-flash`. El E2E de Codex Desktop con una conversación
   nueva, incluyendo stream, tools, web y rollback, sigue pendiente.
6. Para revertir: detener el bridge, restaurar ChatGPT desde el snapshot hashado,
   comprobar que los enlaces y el modo coinciden con el snapshot y registrar la
   evidencia final.

El snapshot de rollback quedó en `%USERPROFILE%\.codex\gloryapi-cutover.rollback.*.json`.
La configuración activa quedó en DeepSeek y el bridge/runtime permanecen operativos;
volver a ChatGPT ejecuta `switch-chatgpt.ps1` desde la fuente GloryAPI.

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
