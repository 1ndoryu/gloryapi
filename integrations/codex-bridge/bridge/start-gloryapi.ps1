# Starts the isolated local GloryAPI runtime required by the Codex bridge.
param(
    [string]$NodePath = '',
    [string]$NodeScriptOverride = '',
    [string]$EnvironmentProbePath = '',
    [int]$Port = 3101,
    [string]$RuntimeDataDir = '',
    [string]$DatabasePath = ''
)
$ErrorActionPreference = 'Stop'
$bridgeLink = Get-Item -LiteralPath $PSScriptRoot -Force
$BridgeDir = if ($bridgeLink.LinkType -eq 'Junction' -and $bridgeLink.Target) {
    (Resolve-Path -LiteralPath ([string](@($bridgeLink.Target) | Select-Object -First 1))).Path
} else { $PSScriptRoot }
$ProjectRoot = (Resolve-Path (Join-Path $BridgeDir '..\..\..')).Path
$ServerFile = Join-Path $ProjectRoot 'server\dist\index.js'
$DefaultDataRoot = Join-Path $env:USERPROFILE '.gloryapi'
$DataDir = if ([string]::IsNullOrWhiteSpace($RuntimeDataDir)) { Join-Path $DefaultDataRoot 'runtime' } else { [IO.Path]::GetFullPath($RuntimeDataDir) }
$ConfiguredDatabasePath = if (-not [string]::IsNullOrWhiteSpace($DatabasePath)) {
    $DatabasePath
} elseif (-not [string]::IsNullOrWhiteSpace($env:GLORYAPI_DB_PATH)) {
    $env:GLORYAPI_DB_PATH
} else {
    Join-Path $DefaultDataRoot 'gloryapi.db'
}
if ($ConfiguredDatabasePath -eq ':memory:') { throw 'GLORYAPI_DB_PATH debe apuntar a una SQLite persistente para el runtime.' }
$DatabasePath = [IO.Path]::GetFullPath($ConfiguredDatabasePath)
if ($DatabasePath -match '(?i)(^|[\\/])freellmapi([\\/]|$)') { throw 'GLORYAPI_DB_PATH no puede apuntar al árbol legado FreeLLMAPI.' }
if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "No existe la base GloryAPI configurada: $DatabasePath"
}
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$PidFile = Join-Path $DataDir 'gloryapi.pid'
$LogOut = Join-Path $DataDir 'gloryapi.out.log'
$LogErr = Join-Path $DataDir 'gloryapi.err.log'
# Default health: http://127.0.0.1:3101/api/ping; port check: Get-NetTCPConnection -LocalPort 3101
$Health = "http://127.0.0.1:$Port/api/ping"

function Test-GloryApiHealth {
    try {
        $response = Invoke-RestMethod -Uri $Health -TimeoutSec 2
        return $response.status -eq 'ok'
    } catch { return $false }
}

if (Test-GloryApiHealth) {
    Write-Host "GloryAPI ya está corriendo ($Health)"
    exit 0
}
if (-not (Test-Path -LiteralPath $ServerFile)) {
    throw 'Falta server/dist/index.js; ejecuta npm run build:server antes de iniciar GloryAPI.'
}
$occupant = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupant) { throw "El puerto $Port está ocupado por otro servicio; se rechaza iniciar GloryAPI." }

$node = if ([string]::IsNullOrWhiteSpace($NodePath)) { (Get-Command node -ErrorAction Stop).Source } else { (Resolve-Path -LiteralPath $NodePath).Path }
$launchScript = if ([string]::IsNullOrWhiteSpace($NodeScriptOverride)) { $ServerFile } else { (Resolve-Path -LiteralPath $NodeScriptOverride).Path }
function Start-IsolatedGloryApi {
    # Start-Process desacopla el runtime del host de PowerShell. Durante la
    # creación se sustituye el entorno completo por una allowlist mínima y se
    # restaura únicamente en este host al terminar.
    $snapshot = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $snapshot[$entry.Key] = [string]$entry.Value
    }
    $keep = @('Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PATHEXT')
    try {
        foreach ($name in @($snapshot.Keys)) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($name in $keep) {
            if ($snapshot.ContainsKey($name)) {
                [Environment]::SetEnvironmentVariable($name, $snapshot[$name], 'Process')
            }
        }
        $env:GLORYAPI_DB_PATH = $DatabasePath
        if (-not [string]::IsNullOrWhiteSpace($EnvironmentProbePath)) {
            $env:GLORYAPI_ENV_PROBE_PATH = $EnvironmentProbePath
        }
        $env:PORT = [string]$Port
        $args = @($launchScript)
        $proc = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr -PassThru
        return $proc
    } finally {
        foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($name in $snapshot.Keys) {
            [Environment]::SetEnvironmentVariable($name, $snapshot[$name], 'Process')
        }
    }
}
$proc = Start-IsolatedGloryApi
$proc.Id | Set-Content -LiteralPath $PidFile

try {
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-GloryApiHealth) {
            Write-Host "GloryAPI listo. PID=$($proc.Id)  $Health"
            exit 0
        }
    }
    throw "GloryAPI no respondió en 3101; revisa $LogErr."
} catch {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    throw
}
