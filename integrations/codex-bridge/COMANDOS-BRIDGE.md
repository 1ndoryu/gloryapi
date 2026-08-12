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
