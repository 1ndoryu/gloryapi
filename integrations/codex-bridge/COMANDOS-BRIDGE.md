# Comandos del ChatGPT Bridge

Todos los comandos se ejecutan en PowerShell desde la raíz de `gloryapi`:

```powershell
Set-Location 'C:\Users\Owner\OneDrive\Documentos\area-trabajo\gloryapi'
```

## Abrir ChatGPT normal

La ventana normal conserva su proveedor e historial habituales:

```powershell
$chatgpt = Get-AppxPackage -Name 'OpenAI.Codex' |
  Sort-Object Version -Descending |
  Select-Object -First 1 -ExpandProperty InstallLocation
Start-Process (Join-Path $chatgpt 'app\ChatGPT.exe')
```

## Abrir ChatGPT con el bridge

El bridge usa otra ventana, otro perfil y otro historial. No cierra ni cambia la ventana normal.

Opción recomendada, desde el escritorio:

```text
ChatGPT Bridge - GloryAPI.lnk
```

Opción por comando, compatible con Windows PowerShell 5.1 y PowerShell 7:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File '.\integrations\codex-bridge\mode\start-codex-bridge.ps1' `
  -RefreshConfig -Desktop
```

Al abrirlo, el launcher comprueba tanto el bridge (`4100`) como GloryAPI (`3101`). Si el bridge sigue
abierto pero GloryAPI fue cerrado, vuelve a iniciar automáticamente el runtime antes de abrir la sesión.

`-RefreshConfig` regenera solo la configuración aislada del bridge. No copia `auth.json`, conversaciones
ni bases SQLite del home normal.

Para preparar la configuración sin abrir una ventana:

```powershell
& '.\integrations\codex-bridge\mode\start-codex-bridge.ps1' -RefreshConfig -PrepareOnly
```

## Encender solamente el servidor bridge

```powershell
& '.\integrations\codex-bridge\bridge\start-bridge.ps1'
```

Usa otra base/ruta de runtime solo si se necesita una instalación paralela:

```powershell
& '.\integrations\codex-bridge\bridge\start-bridge.ps1' `
  -RuntimeDataDir "$env:USERPROFILE\.gloryapi\runtime\bridge-runtime" `
  -DatabasePath "$env:USERPROFILE\.gloryapi\gloryapi.db"
```

## Configurar visión y fallbacks

La visión no depende del modelo de texto de GloryAPI. El bridge envía cada imagen al proveedor de
visión configurado y entrega la descripción al modelo principal como texto. Por defecto prueba
`mimo-v2.5-free` y, si devuelve `429`, salta a `mimo-v2.5` de OpenCode Go usando automáticamente la
clave `opencode-go` guardada en la bóveda DPAPI local. También se puede cambiar con
`-VisionBaseUrl` y `-VisionModel`; no pongas claves en el script ni en este documento.

Para añadir rutas alternativas, define `VISION_FALLBACKS_JSON` en el entorno antes de iniciar el bridge.
Cada clave se referencia por nombre mediante `apiKeyEnv`, no se guarda dentro del JSON:

```powershell
$env:VISION_FALLBACKS_JSON = '[{"id":"vision-secundaria","baseUrl":"https://proveedor.example/v1","model":"modelo-vision","apiKeyEnv":"VISION_SECUNDARIA_API_KEY"}]'
# VISION_SECUNDARIA_API_KEY debe existir ya en el entorno seguro del proceso.
& '.\integrations\codex-bridge\bridge\start-bridge.ps1' -Restart
```

Si el proveedor principal responde `429`, se reintenta de forma acotada y se prueban las rutas
alternativas. Si todas fallan, la conversación continúa con un aviso que distingue “imagen recibida
sin descripción” de “imagen ausente”; no se inventa que una carpeta o visualización está vacía.

## Seleccionar proveedor y modelo (CommandCode, Muse, DeepSeek)

El selector es el picker de modelos de la ventana ChatGPT del bridge. Desktop lee el archivo
`model_catalog_json` de `C:\Users\Owner\.codex-gloryapi\config.toml`; el endpoint `/v1/models`
expone el mismo catálogo para clientes compatibles. El catálogo está versionado como
`glory-bridge-model-catalog-v2` (`bridge/model-catalog.js`). Algunas versiones de Desktop filtran los
IDs de proveedores personalizados; por eso el archivo local usa alias `pickerId` reconocibles por
Desktop, pero el bridge los traduce al ID real antes de llamar a GloryAPI. Opciones visibles por defecto:

- `auto` — comportamiento actual: GloryAPI enruta/fallback entre los proveedores gratuitos.
- `deepseek-v4-flash-free` — OpenCode Zen · DeepSeek V4 Flash gratuito.
- `deepseek-v4-flash:free` — TokenHarbor Free · DeepSeek V4 Flash gratuito.
- `deepseek/deepseek-v4-flash` — CommandCode · DeepSeek V4 Flash (texto).
- `meta/muse-spark-1.2-contributor` — CommandCode · Muse Spark 1.2 Contributor (visión nativa).

Al elegir un modelo CommandCode, el bridge envía ese id exacto y GloryAPI lo fija a su propio
proveedor: no salta silenciosamente a un proveedor gratuito. Si falta la clave, el modelo no existe
o el proveedor falla, la respuesta es un error estructurado visible, no un cierre de turno falso.

Muse Spark 1.2 tiene visión nativa: con ese modelo, las imágenes se reenvían como `image_url` para
que el modelo las vea directamente. Con el resto de modelos se conserva la descripción por texto.

El selector `Esfuerzo` también se aplica por modelo. En Muse, `Alto` se envía a CommandCode como
`reasoning_effort: "high"` y `Máximo` como `reasoning_effort: "max"`. Los modelos que no declaran
razonamiento, como TokenHarbor Free, no reciben el parámetro ni anuncian niveles en el catálogo.

Para guardar la credencial de CommandCode (bóveda DPAPI, nunca en código ni en logs), usa el panel
local de GloryAPI o su API segura:

```powershell
# No pegar la clave aquí: se envía una sola vez a la bóveda DPAPI de GloryAPI.
$headers = @{ Authorization = "Bearer <unified-key>" }
$body = @{ platform = 'commandcode'; key = '<clave>'; label = 'CommandCode Provider' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3101/api/keys' -Headers $headers -ContentType 'application/json' -Body $body
```

Si la clave fue pegada en texto plano en una conversación, revócala en CommandCode Studio y genera
otra antes de guardarla.

## Apagar el servidor bridge

Este comando detiene únicamente el bridge identificado por su PID y su `server.js`:

```powershell
& '.\integrations\codex-bridge\bridge\stop-bridge.ps1'
```

No uses `-Force` salvo que el puerto 4100 esté ocupado por un proceso que se haya comprobado que se puede
reemplazar.

## Reiniciar el servidor bridge

```powershell
& '.\integrations\codex-bridge\bridge\restart-bridge.ps1'
```

El reinicio hace `stop + start + health`. Para reiniciar también el runtime local de GloryAPI en el puerto
3101:

```powershell
& '.\integrations\codex-bridge\bridge\restart-bridge.ps1' -Runtime
```

## Comprobar estado

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4100/health' | Select-Object -ExpandProperty Content
```

La respuesta esperada contiene `"ok":true` y `"service":"gloryapi-codex-bridge"`.

Para ver el proceso registrado por el bridge:

```powershell
$pidFile = Join-Path $env:USERPROFILE '.gloryapi\runtime\bridge-runtime\bridge.pid'
if (Test-Path $pidFile) { Get-Content $pidFile | Get-Process }
```

## Ver logs

```powershell
$runtime = Join-Path $env:USERPROFILE '.gloryapi\runtime\bridge-runtime'
Get-Content (Join-Path $runtime 'bridge.out.log') -Tail 100 -Wait
```

En otra consola, para errores:

```powershell
$runtime = Join-Path $env:USERPROFILE '.gloryapi\runtime\bridge-runtime'
Get-Content (Join-Path $runtime 'bridge.err.log') -Tail 100 -Wait
```

Los logs de la ventana aislada de Desktop están en:

```text
C:\Users\Owner\.codex-gloryapi\desktop-user-data-bridge
```

## Cerrar solo la ventana bridge de ChatGPT

Este bloque busca únicamente procesos `ChatGPT.exe` que tengan el `user-data-dir` aislado. La ventana normal
no coincide con ese filtro:

```powershell
$bridgeData = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex-gloryapi\desktop-user-data-bridge'))
$bridgePids = @(Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -and $_.CommandLine.Contains($bridgeData) } |
  Select-Object -ExpandProperty ProcessId -Unique)
if ($bridgePids.Count -gt 0) {
  Stop-Process -Id $bridgePids -Force
  Write-Host "Ventana bridge cerrada: PID $($bridgePids -join ', ')"
} else {
  Write-Host 'No hay una ventana bridge abierta.'
}
```

Cerrar la ventana no borra el historial aislado. Para volver a abrirla, usa el acceso directo o el comando
de la sección anterior.

## Si vuelve a detenerse una tarea

1. Comprueba primero `http://127.0.0.1:4100/health`.
2. Si no responde, ejecuta `restart-bridge.ps1`.
3. Si responde, conserva el hilo y revisa `bridge.err.log`; no borres `C:\Users\Owner\.codex-gloryapi`,
   porque allí está el historial separado del bridge.
4. Si aparece el mensaje genérico de razonamiento sin resultado, guarda la hora y el ID del hilo para
   correlacionarlo con los logs. El bridge no debe cerrarse como tarea completada solo por mostrar ese texto.

## Rutas principales

- Configuración normal: `%USERPROFILE%\.codex\config.toml`
- Home e historial bridge: `%USERPROFILE%\.codex-gloryapi`
- Base de GloryAPI: `%USERPROFILE%\.gloryapi\gloryapi.db`
- Runtime del bridge: `%USERPROFILE%\.gloryapi\runtime\bridge-runtime`
- Servidor bridge: `integrations\codex-bridge\bridge\server.js`
- Acceso directo: `%USERPROFILE%\OneDrive\Desktop\ChatGPT Bridge - GloryAPI.lnk`
