# Launcher de escritorio / inicio de sesion para el runtime aislado de GloryAPI.
# Idempotente: si /api/ping ya responde, no arranca una segunda instancia.
# Reutiliza el launcher probado de codex-bridge (misma logica de salud, puerto
# y aislamiento de entorno), que es el que conoce la ruta de la base por defecto
# (~/.gloryapi/gloryapi.db) y escribe logs/pid en ~/.gloryapi/runtime/.
[CmdletBinding()]
param(
    [switch]$OpenDashboard,
    [ValidateRange(1, 65535)]
    [int]$Port = 3101
)
$ErrorActionPreference = 'Stop'
$trayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $trayDir '..\codex-bridge\bridge\start-gloryapi.ps1'
$launcher = (Resolve-Path -LiteralPath $launcher).Path
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Falta el launcher idempotente: $launcher"
}
& $launcher -Port $Port
if ($LASTEXITCODE -ne 0) { throw 'El launcher de GloryAPI fallo.' }

$Dashboard = "http://127.0.0.1:$Port"
$ok = $false
try {
    $ping = Invoke-RestMethod -Uri "$Dashboard/api/ping" -TimeoutSec 2
    $ok = $ping.status -eq 'ok'
} catch { $ok = $false }
if (-not $ok) { throw 'GloryAPI no responde tras el arranque.' }

Write-Host "GloryAPI corriendo en $Dashboard"
if ($OpenDashboard) { Start-Process $Dashboard }
