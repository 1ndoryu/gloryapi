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
- `bridge.requests.log` guarda metadatos y errores redactados. El cuerpo completo
  solo se habilita conscientemente con `BRIDGE_REQUEST_LOG_FULL=1`.
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
