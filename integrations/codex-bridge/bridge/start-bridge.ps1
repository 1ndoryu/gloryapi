# Inicia el bridge local Codex <-> GloryAPI (deepseek-v4-flash)
$ErrorActionPreference = 'Stop'
$BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogOut = Join-Path $BridgeDir 'bridge.out.log'
$LogErr = Join-Path $BridgeDir 'bridge.err.log'
$PidFile = Join-Path $BridgeDir 'bridge.pid'
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

if ([string]::IsNullOrWhiteSpace($env:BRIDGE_CLIENT_TOKEN)) {
    $authScript = Join-Path $BridgeDir '..\..\..\server\dist\scripts\bridge-auth.js'
    if (-not (Test-Path -LiteralPath $authScript)) {
        throw 'Falta el helper bridge-auth compilado; ejecuta npm run build:server antes de iniciar.'
    }
    $authOutput = & $node $authScript --print 2>$null
    if ($LASTEXITCODE -ne 0 -or $authOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$authOutput[0])) {
        throw 'No se pudo resolver BRIDGE_CLIENT_TOKEN desde la bóveda DPAPI; ejecuta bridge-auth --rotate una vez.'
    }
    $env:BRIDGE_CLIENT_TOKEN = ([string]$authOutput[0]).Trim()
}
if ([string]::IsNullOrWhiteSpace($env:GLORY_API_KEY) -and [string]::IsNullOrWhiteSpace($env:FREEL_API_KEY)) {
    throw 'Falta GLORY_API_KEY/FREEL_API_KEY; el bridge no arranca sin credencial upstream configurada.'
}

$proc = Start-Process -FilePath $node -ArgumentList @((Join-Path $BridgeDir 'server.js')) `
    -WorkingDirectory $BridgeDir -WindowStyle Hidden `
    -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr -PassThru

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
