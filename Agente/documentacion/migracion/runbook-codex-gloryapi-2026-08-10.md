# Runbook: Codex Desktop con GloryAPI

Este documento conserva los comandos para instalar, activar, diagnosticar y
revertir el bridge local. No imprime ni solicita las credenciales DPAPI.

## Variables de trabajo

```powershell
$GloryApi = 'C:\Users\Owner\OneDrive\Documentos\area-trabajo\gloryapi'
$Bridge = Join-Path $GloryApi 'integrations\codex-bridge\bridge'
$Mode = Join-Path $GloryApi 'integrations\codex-bridge\mode'
Set-Location $GloryApi
```

## Instalación o reparación local

Usar esto después de clonar/copiar GloryAPI o si faltan artefactos compilados:

```powershell
Set-Location $GloryApi
# Primero libera el addon nativo SQLite si GloryAPI está ejecutándose.
& (Join-Path $Bridge 'stop-bridge.ps1')
$runtimePid = (Get-Content (Join-Path $GloryApi 'server\data\gloryapi.pid') -Raw -ErrorAction SilentlyContinue).Trim()
if ($runtimePid) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimePid" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -like '*gloryapi*server*dist*index.js*') {
    Stop-Process -Id ([int]$runtimePid) -Force
  }
}
npm ci
npm run build:server
```

Si `npm ci` muestra `EPERM` sobre `node_modules\better-sqlite3\build\Release\better_sqlite3.node`,
no borres `node_modules` a ciegas: detén primero los procesos de los puertos `3101/4100`, repite `npm ci`
y vuelve a compilar.

El gate de Sentinel se instala/verifica por separado según `quality-tools.json` y
`sentinel.lock.json`; no se debe copiar manualmente un artefacto ignorado.

## Comprobar antes de activar

```powershell
& (Join-Path $Mode 'codex-activation-preflight.ps1') -Json
```

Debe terminar con `ready: true`, enlaces `target=gloryapi`, helper DPAPI
disponible y health del bridge correcto.

## Usar DeepSeek mediante GloryAPI en Codex Desktop

`switch-deepseek.ps1` es el comando correcto para usar GloryAPI. El bridge y el
runtime se inician/resuelven con la bóveda local cuando corresponde:

```powershell
& "$env:USERPROFILE\.codex\switch-deepseek.ps1"
& (Join-Path $Mode 'codex-activation-preflight.ps1') -Json
```

Después de cambiar el modo, cerrar completamente Codex Desktop (incluida la
bandeja) y abrirlo de nuevo. Probar en una conversación nueva.

## Arranque y parada manuales

```powershell
# Inicia GloryAPI si hace falta y después el bridge en 4100.
& (Join-Path $Bridge 'start-bridge.ps1')

# Detiene solo el bridge cuyo PID/ruta coinciden con GloryAPI.
& (Join-Path $Bridge 'stop-bridge.ps1')

# Solo si se necesita levantar el runtime sin el bridge.
& (Join-Path $Bridge 'start-gloryapi.ps1')
```

Comprobación rápida:

```powershell
Invoke-WebRequest 'http://127.0.0.1:4100/health' -UseBasicParsing
Invoke-WebRequest 'http://127.0.0.1:3101/api/ping' -UseBasicParsing
Get-NetTCPConnection -LocalPort 4100,3101 -State Listen
```

## Regresar al ChatGPT nativo

`switch-chatgpt.ps1` no usa GloryAPI: vuelve al proveedor ChatGPT nativo y
detiene el bridge.

```powershell
& "$env:USERPROFILE\.codex\switch-chatgpt.ps1"
& (Join-Path $Mode 'codex-activation-preflight.ps1') -Json -SkipHealth
```

Cerrar y volver a abrir Codex Desktop para que relea `config.toml`.

## Vista previa sin cambiar nada

```powershell
& (Join-Path $Mode 'codex-mode.ps1') -Mode deepseek -Preview
& (Join-Path $Mode 'codex-mode.ps1') -Mode chatgpt -Preview
```

## Diagnóstico y validación

```powershell
Set-Location $GloryApi
npm run task:check:local -- GLORY-REQUEST-ID-ALL-FULL-20260810
npm run task:check -- GLORY-REQUEST-ID-ALL-FULL-20260810
sentinel doctor --json
node --test integrations/codex-bridge/test/*.test.cjs integrations/codex-bridge/test/security/*.test.cjs
```

Para una prueba aislada del flujo Codex sin tocar el perfil principal:

```powershell
npm run canary:codex
```

## Rollback si algo sale mal

1. Ejecutar `switch-chatgpt.ps1`.
2. Cerrar y reabrir Codex Desktop.
3. Confirmar que `/health` del bridge ya no es necesario y que el modo reporta
   `chatgpt`.
4. Conservar el snapshot generado bajo
   `%USERPROFILE%\.codex\gloryapi-cutover.rollback.*.json`; no borrar el legado.

Para volver a probar GloryAPI, ejecutar de nuevo `switch-deepseek.ps1` y abrir
otra conversación nueva.

## No confundir estos comandos

| Comando | Resultado |
|---|---|
| `switch-deepseek.ps1` | DeepSeek V4 Flash mediante bridge y GloryAPI |
| `switch-chatgpt.ps1` | ChatGPT nativo; detiene el bridge |
| `start-bridge.ps1` | Arranca runtime/bridge sin cambiar el perfil Codex |
| `codex-activation-preflight.ps1` | Solo lectura; no cambia modo ni procesos |

El E2E completo de Codex Desktop (stream, tools, web y rollback desde la
aplicación) sigue siendo una prueba manual pendiente; el canary y el flujo real
Node → bridge → GloryAPI ya tienen contratos automatizados.
