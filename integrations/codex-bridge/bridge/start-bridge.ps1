# Inicia el bridge local Codex <-> GloryAPI (deepseek-v4-flash)
$ErrorActionPreference = 'Stop'
$bridgeLink = Get-Item -LiteralPath $PSScriptRoot -Force
$BridgeDir = if ($bridgeLink.LinkType -eq 'Junction' -and $bridgeLink.Target) {
    (Resolve-Path -LiteralPath ([string](@($bridgeLink.Target) | Select-Object -First 1))).Path
} else { $PSScriptRoot }
$RuntimeDir = (Resolve-Path (Join-Path $BridgeDir '..\..\..\server\data')).Path
$RuntimeDir = Join-Path $RuntimeDir 'bridge-runtime'
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$LogOut = Join-Path $RuntimeDir 'bridge.out.log'
$LogErr = Join-Path $RuntimeDir 'bridge.err.log'
$PidFile = Join-Path $RuntimeDir 'bridge.pid'
$Port = 4100
$Health = "http://127.0.0.1:$Port/health"

function Test-ExpectedBridge {
    try {
        $result = Invoke-RestMethod -Uri $Health -TimeoutSec 2
        return $result.ok -and $result.service -eq 'gloryapi-codex-bridge' -and $result.model -eq 'deepseek-v4-flash'
    }
    catch { return $false }
}

# ¿Ya está corriendo?
if (Test-ExpectedBridge) {
    Write-Host "Bridge ya está corriendo ($Health)"
    exit 0
}

$occupant = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupant) {
    throw "El puerto $Port está ocupado por otro servicio; se rechaza iniciar o reemplazarlo."
}

$node = (Get-Command node -ErrorAction Stop).Source
$env:BRIDGE_RUNTIME_DIR = $RuntimeDir

# Arranca y verifica GloryAPI antes de resolver secretos del bridge. El runtime
# se inicia con un entorno aislado y nunca recibe las credenciales siguientes.
$runtimeScript = Join-Path $BridgeDir 'start-gloryapi.ps1'
if (Test-Path -LiteralPath $runtimeScript) {
    # Ejecutarlo en este mismo host evita que un PowerShell anidado termine el
    # proceso GloryAPI cuando el hijo deba permanecer como runtime persistente.
    & $runtimeScript
    if ($LASTEXITCODE -ne 0) { throw 'GloryAPI runtime no está listo; se rechaza iniciar el bridge.' }
}

$bridgeClientToken = $env:BRIDGE_CLIENT_TOKEN
if ([string]::IsNullOrWhiteSpace($bridgeClientToken)) {
    $authScript = Join-Path $BridgeDir '..\..\..\server\dist\scripts\bridge-auth.js'
    if (-not (Test-Path -LiteralPath $authScript)) {
        throw 'Falta el helper bridge-auth compilado; ejecuta npm run build:server antes de iniciar.'
    }
    $authOutput = @(& $node $authScript --print 2>$null)
    if ($LASTEXITCODE -ne 0 -or $authOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$authOutput[0])) {
        throw 'No se pudo resolver BRIDGE_CLIENT_TOKEN desde la bóveda DPAPI; ejecuta bridge-auth --rotate una vez.'
    }
    $bridgeClientToken = ([string]$authOutput[0]).Trim()
}
$upstreamToken = $env:GLORY_API_KEY
if ([string]::IsNullOrWhiteSpace($upstreamToken)) { $upstreamToken = $env:FREEL_API_KEY }
if ([string]::IsNullOrWhiteSpace($upstreamToken)) {
    $upstreamAuth = Join-Path $BridgeDir '..\..\..\server\dist\scripts\bridge-upstream-auth.js'
    if (-not (Test-Path -LiteralPath $upstreamAuth)) {
        throw 'Falta GLORY_API_KEY/FREEL_API_KEY y el helper bridge-upstream-auth compilado.'
    }
    $upstreamOutput = @(& $node $upstreamAuth --print 2>$null)
    if ($LASTEXITCODE -ne 0 -or $upstreamOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$upstreamOutput[0])) {
        throw 'No se pudo resolver la clave unificada de GloryAPI desde la bóveda local.'
    }
    $upstreamToken = ([string]$upstreamOutput[0]).Trim()
}

$bridgeServer = Join-Path $BridgeDir 'server.js'

# Lanzamiento desacoplado del host (mismo patron probado que el runtime en
# start-gloryapi.ps1): Start-Process con redireccion a archivo crea un proceso
# sin consola compartida. Un proceso .NET (CreateNoWindow) hereda la consola
# del padre y muere en silencio (CTRL_CLOSE) cuando el host que lo lanzo
# termina, dejando a Codex sin bridge ("stream disconnected"). El entorno se
# aisla con la misma allowlist minima que Start-IsolatedGloryApi.
function Start-IsolatedBridge {
    $snapshot = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $snapshot[$entry.Key] = [string]$entry.Value
    }
    $keep = @('Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA')
    try {
        foreach ($name in @($snapshot.Keys)) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($name in $keep) {
            if ($snapshot.ContainsKey($name)) {
                [Environment]::SetEnvironmentVariable($name, $snapshot[$name], 'Process')
            }
        }
        $env:BRIDGE_RUNTIME_DIR = $RuntimeDir
        $env:BRIDGE_CLIENT_TOKEN = $bridgeClientToken
        $env:GLORY_API_KEY = $upstreamToken
        $env:BRIDGE_PORT = [string]$Port
        $env:GLORY_API_CONTRACT = 'chat-completions-v1'
        return Start-Process -FilePath $node -ArgumentList @($bridgeServer) -WorkingDirectory $BridgeDir `
            -WindowStyle Hidden -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr -PassThru
    }
    finally {
        foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($name in $snapshot.Keys) {
            [Environment]::SetEnvironmentVariable($name, $snapshot[$name], 'Process')
        }
    }
}
$proc = Start-IsolatedBridge
if ($null -eq $proc) { throw 'No se pudo iniciar el bridge aislado.' }

$proc.Id | Set-Content -Path $PidFile

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ExpectedBridge) {
        $ok = $true
        break
    }
}

if ($ok) {
    Write-Host "Bridge listo. PID=$($proc.Id)  $Health  (logs: $LogOut / $LogErr)"
    exit 0
}
else {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Error "El bridge no respondió con la identidad esperada en $Health. Revisa $LogErr"
    if (Test-Path $LogErr) { Get-Content $LogErr -Tail 20 }
    exit 1
}
