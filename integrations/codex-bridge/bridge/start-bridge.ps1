# Inicia el bridge local Codex <-> GloryAPI (deepseek-v4-flash)
#   -Restart -> detiene el bridge actual (si existe) y lo inicia de nuevo
#   -Force   -> con -Restart, sustituye también un proceso ajeno en :4100
param(
    [switch]$Restart,
    [switch]$Force,
    [ValidateRange(1, 65535)]
    [int]$Port = 4100,
    [string]$RuntimeDataDir = '',
    [string]$DatabasePath = '',
    [string]$VisionBaseUrl = '',
    [string]$VisionModel = '',
    [string]$VisionFallbacksJson = '',
    [switch]$VisionAllowAnonymous
)
$ErrorActionPreference = 'Stop'
$bridgeLink = Get-Item -LiteralPath $PSScriptRoot -Force
$BridgeDir = if ($bridgeLink.LinkType -eq 'Junction' -and $bridgeLink.Target) {
    (Resolve-Path -LiteralPath ([string](@($bridgeLink.Target) | Select-Object -First 1))).Path
} else { $PSScriptRoot }
$DefaultDataRoot = Join-Path $env:USERPROFILE '.gloryapi'
$ConfiguredDatabasePath = if (-not [string]::IsNullOrWhiteSpace($DatabasePath)) {
    $DatabasePath
} elseif (-not [string]::IsNullOrWhiteSpace($env:GLORYAPI_DB_PATH)) {
    $env:GLORYAPI_DB_PATH
} else {
    Join-Path $DefaultDataRoot 'gloryapi.db'
}
if ($ConfiguredDatabasePath -eq ':memory:') { throw 'GLORYAPI_DB_PATH debe apuntar a una SQLite persistente para el bridge.' }
$DatabasePath = [System.IO.Path]::GetFullPath($ConfiguredDatabasePath)
if ($DatabasePath -match '(?i)(^|[\\/])freellmapi([\\/]|$)') { throw 'GLORYAPI_DB_PATH no puede apuntar al árbol legado FreeLLMAPI.' }
if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "No existe la base GloryAPI configurada: $DatabasePath"
}
$RuntimeDir = if ([string]::IsNullOrWhiteSpace($RuntimeDataDir)) {
    Join-Path $DefaultDataRoot 'runtime\bridge-runtime'
} else {
    [System.IO.Path]::GetFullPath($RuntimeDataDir)
}
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$LogOut = Join-Path $RuntimeDir 'bridge.out.log'
$LogErr = Join-Path $RuntimeDir 'bridge.err.log'
$PidFile = Join-Path $RuntimeDir 'bridge.pid'
$Health = "http://127.0.0.1:$Port/health"
$StopScript = Join-Path $BridgeDir 'stop-bridge.ps1'

function Test-ExpectedBridge {
    try {
        $result = Invoke-RestMethod -Uri $Health -TimeoutSec 2
        return $result.ok -and $result.service -eq 'gloryapi-codex-bridge' -and $result.model -eq 'deepseek-v4-flash'
    }
    catch { return $false }
}

# ¿Ya está corriendo?
if (Test-ExpectedBridge) {
    if (-not $Restart) {
        Write-Host "Bridge ya está corriendo ($Health)"
        exit 0
    }
    Write-Host 'Reinicio solicitado: deteniendo el bridge actual...'
    & $StopScript -Force:$Force -Port $Port -RuntimeDataDir $RuntimeDir
    if (Test-ExpectedBridge) {
        throw 'El bridge siguió respondiendo tras el stop; no se inicia uno nuevo sin puerto libre.'
    }
}

$occupant = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupant) {
    $ownerPids = @($occupant | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($Restart) {
        Write-Host "El puerto $Port sigue ocupado (PID $($ownerPids -join ', ')); reintentando el stop..."
        & $StopScript -Force:$Force -Port $Port -RuntimeDataDir $RuntimeDir
    }
    else {
        throw "El puerto $Port está ocupado por otro servicio (PID $($ownerPids -join ', ')); usa -Restart para sustituirlo."
    }
}
$occupant = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupant) {
    $ownerPids = @($occupant | Select-Object -ExpandProperty OwningProcess -Unique)
    throw "El puerto $Port sigue ocupado tras el stop (PID $($ownerPids -join ', ')); no se inicia el bridge."
}

$node = (Get-Command node -ErrorAction Stop).Source
$env:BRIDGE_RUNTIME_DIR = $RuntimeDir
$env:GLORYAPI_DB_PATH = $DatabasePath

# Arranca y verifica GloryAPI antes de resolver secretos del bridge. El runtime
# se inicia con un entorno aislado y nunca recibe las credenciales siguientes.
$runtimeScript = Join-Path $BridgeDir 'start-gloryapi.ps1'
if (Test-Path -LiteralPath $runtimeScript) {
    # Ejecutarlo en este mismo host evita que un PowerShell anidado termine el
    # proceso GloryAPI cuando el hijo deba permanecer como runtime persistente.
    & $runtimeScript -DatabasePath $DatabasePath -RuntimeDataDir (Split-Path -Parent $RuntimeDir)
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

# Vision se configura desde el launcher o desde el entorno del proceso que lo
# invoca. El valor por defecto conserva el pool gratuito existente, pero no
# obliga a editar este script para cambiar de proveedor o añadir fallbacks.
$ConfiguredVisionBaseUrl = if (-not [string]::IsNullOrWhiteSpace($VisionBaseUrl)) {
    $VisionBaseUrl
} elseif (-not [string]::IsNullOrWhiteSpace($env:VISION_BASE_URL)) {
    $env:VISION_BASE_URL
} else { 'https://opencode.ai/zen/v1' }
$ConfiguredVisionModel = if (-not [string]::IsNullOrWhiteSpace($VisionModel)) {
    $VisionModel
} elseif (-not [string]::IsNullOrWhiteSpace($env:VISION_MODEL)) {
    $env:VISION_MODEL
} else { 'mimo-v2.5-free' }
$ConfiguredVisionApiKey = $env:VISION_API_KEY
$ConfiguredVisionFallbacksJson = if (-not [string]::IsNullOrWhiteSpace($VisionFallbacksJson)) {
    $VisionFallbacksJson
} else { $env:VISION_FALLBACKS_JSON }
$ConfiguredVisionAnonymous = if ($VisionAllowAnonymous) {
    '1'
} elseif (-not [string]::IsNullOrWhiteSpace($env:VISION_ALLOW_ANONYMOUS)) {
    $env:VISION_ALLOW_ANONYMOUS
} elseif ([string]::IsNullOrWhiteSpace($ConfiguredVisionApiKey)) {
    '1'
} else {
    '0'
}

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
        $env:VISION_BASE_URL = $ConfiguredVisionBaseUrl
        $env:VISION_MODEL = $ConfiguredVisionModel
        $env:VISION_API_KEY = $ConfiguredVisionApiKey
        $env:VISION_ALLOW_ANONYMOUS = $ConfiguredVisionAnonymous
        $env:VISION_FALLBACKS_JSON = $ConfiguredVisionFallbacksJson
        if (-not [string]::IsNullOrWhiteSpace($ConfiguredVisionFallbacksJson)) {
            try {
                $fallbackRows = @($ConfiguredVisionFallbacksJson | ConvertFrom-Json)
                foreach ($row in $fallbackRows) {
                    $keyEnv = if ($row -and $row.apiKeyEnv) { [string]$row.apiKeyEnv } else { '' }
                    if ($keyEnv -and $snapshot.ContainsKey($keyEnv)) {
                        [Environment]::SetEnvironmentVariable($keyEnv, $snapshot[$keyEnv], 'Process')
                    }
                }
            }
            catch {
                throw 'VISION_FALLBACKS_JSON no contiene una configuración JSON válida.'
            }
        }
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
