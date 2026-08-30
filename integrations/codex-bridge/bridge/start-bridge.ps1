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
$RuntimeHealth = 'http://127.0.0.1:3101/api/ping'
$StopScript = Join-Path $BridgeDir 'stop-bridge.ps1'
$RuntimeScript = Join-Path $BridgeDir 'start-gloryapi.ps1'

function Test-ExpectedBridge {
    try {
        $result = Invoke-RestMethod -Uri $Health -TimeoutSec 2
        return $result.ok -and $result.service -eq 'gloryapi-codex-bridge'
    }
    catch { return $false }
}

function Test-ExpectedRuntime {
    try {
        $result = Invoke-RestMethod -Uri $RuntimeHealth -TimeoutSec 2
        return $result.status -eq 'ok'
    }
    catch { return $false }
}

function Ensure-GloryApiRuntime {
    if (Test-ExpectedRuntime) { return }
    if (-not (Test-Path -LiteralPath $RuntimeScript -PathType Leaf)) {
        throw "Falta el launcher de GloryAPI: $RuntimeScript"
    }
    Write-Host "GloryAPI no responde en $RuntimeHealth; iniciándolo..."
    & $RuntimeScript -DatabasePath $DatabasePath -RuntimeDataDir (Split-Path -Parent $RuntimeDir)
    if ($LASTEXITCODE -ne 0 -or -not (Test-ExpectedRuntime)) {
        throw 'GloryAPI runtime no está listo; se rechaza continuar con el bridge.'
    }
}

# El acceso directo puede abrirse cuando el bridge sigue vivo pero alguien cerró
# solo el runtime en :3101. La salud del bridge por sí sola no garantiza que el
# upstream esté disponible, así que reparamos el runtime antes del early-exit.
Ensure-GloryApiRuntime

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
# Ensure-GloryApiRuntime ya verificó el runtime antes de resolver secretos y de
# decidir si el bridge existente permite salir por el camino rápido.

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

# The picker and request translator consume the same revisioned projection.
# There is no compiled provider catalog fallback: if the first synchronization
# fails, startup is rejected; an existing valid projection may be reused.
$catalogSyncScript = Join-Path $BridgeDir '..\mode\sync-model-catalog.cjs'
$catalogFile = Join-Path $RuntimeDir 'bridge-model-catalog.json'
function Test-ValidCatalogFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $catalog = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        return $catalog.schemaVersion -eq 'glory-bridge-model-catalog-v2' -and
            [int]$catalog.revision -ge 0 -and
            -not [string]::IsNullOrWhiteSpace([string]$catalog.hash) -and
            @($catalog.entries).Count -gt 0 -and
            @($catalog.entries | Where-Object { $_.id -eq 'auto' }).Count -eq 1
    }
    catch { return $false }
}
if (Test-Path -LiteralPath $catalogSyncScript -PathType Leaf) {
    $previousGloryApiKey = $env:GLORY_API_KEY
    try {
        $env:GLORY_API_KEY = $upstreamToken
        & $node $catalogSyncScript $catalogFile
        if ($LASTEXITCODE -ne 0) {
            if (-not (Test-ValidCatalogFile $catalogFile)) { throw 'No se pudo sincronizar el catálogo y no existe una proyección válida previa.' }
            Write-Warning 'No se pudo sincronizar el catálogo; se conserva la última proyección válida.'
        }
    }
    catch {
        if (-not (Test-ValidCatalogFile $catalogFile)) { throw "No se pudo sincronizar el catálogo: $($_.Exception.Message)" }
        Write-Warning "No se pudo sincronizar el catálogo; se conserva la última proyección válida: $($_.Exception.Message)"
    }
    finally { $env:GLORY_API_KEY = $previousGloryApiKey }
}

$bridgeServer = Join-Path $BridgeDir 'server.js'

# Vision se configura desde el launcher o desde el entorno del proceso que lo
# invoca. El valor por defecto conserva el pool gratuito existente, pero no
# obliga a editar este script para cambiar de proveedor o añadir fallbacks.
$catalogVisionEnvelope = $null
$catalogVisionRoutes = @()
$catalogVisionHasProjection = $false
if (Test-Path -LiteralPath $catalogFile -PathType Leaf) {
    try {
        $catalogVisionEnvelope = Get-Content -LiteralPath $catalogFile -Raw | ConvertFrom-Json
        if ($null -ne $catalogVisionEnvelope -and $null -ne $catalogVisionEnvelope.visionModels) {
            $catalogVisionHasProjection = $true
            $catalogVisionRoutes = @($catalogVisionEnvelope.visionModels |
                Where-Object { $_.enabled -eq $true } |
                Sort-Object -Property @{ Expression = { [int]$_.priority } }, @{ Expression = { [string]$_.routeId } })
        }
    }
    catch {
        Write-Warning 'No se pudo leer visionModels del catálogo sincronizado; se conservan los valores explícitos o heredados.'
    }
}
$primaryVisionRoute = @($catalogVisionRoutes | Select-Object -First 1)[0]
$VisionBaseUrlExplicit = -not [string]::IsNullOrWhiteSpace($VisionBaseUrl) -or
    -not [string]::IsNullOrWhiteSpace($env:VISION_BASE_URL)
$VisionModelExplicit = -not [string]::IsNullOrWhiteSpace($VisionModel) -or
    -not [string]::IsNullOrWhiteSpace($env:VISION_MODEL)
$ConfiguredVisionBaseUrl = if (-not [string]::IsNullOrWhiteSpace($VisionBaseUrl)) {
    $VisionBaseUrl
} elseif (-not [string]::IsNullOrWhiteSpace($env:VISION_BASE_URL)) {
    $env:VISION_BASE_URL
} elseif ($primaryVisionRoute -and -not [string]::IsNullOrWhiteSpace([string]$primaryVisionRoute.baseUrl)) {
    [string]$primaryVisionRoute.baseUrl
} else { 'https://opencode.ai/zen/v1' }
$ConfiguredVisionModel = if (-not [string]::IsNullOrWhiteSpace($VisionModel)) {
    $VisionModel
} elseif (-not [string]::IsNullOrWhiteSpace($env:VISION_MODEL)) {
    $env:VISION_MODEL
} elseif ($primaryVisionRoute -and -not [string]::IsNullOrWhiteSpace([string]$primaryVisionRoute.id)) {
    [string]$primaryVisionRoute.id
} else { 'mimo-v2.5-free' }
$ConfiguredVisionApiKey = $env:VISION_API_KEY
$ConfiguredVisionAuthPlatform = if ($primaryVisionRoute -and -not [string]::IsNullOrWhiteSpace([string]$primaryVisionRoute.authPlatform)) {
    [string]$primaryVisionRoute.authPlatform
} elseif ($primaryVisionRoute -and -not [string]::IsNullOrWhiteSpace([string]$primaryVisionRoute.provider)) {
    [string]$primaryVisionRoute.provider
} else { 'opencode-zen' }
$visionAuthScript = Join-Path $BridgeDir '..\..\..\server\dist\scripts\bridge-vision-auth.js'
$VisionCredentialEnvironment = @{}
function Resolve-VisionCredential([string]$Platform) {
    if ([string]::IsNullOrWhiteSpace($Platform) -or -not (Test-Path -LiteralPath $visionAuthScript -PathType Leaf)) { return '' }
    $output = @(& $node $visionAuthScript --print --platform $Platform 2>$null)
    if ($LASTEXITCODE -eq 0 -and $output.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$output[0])) {
        return ([string]$output[0]).Trim()
    }
    return ''
}
# OpenCode Zen's free endpoint may reject anonymous direct requests with 401
# even though the model is free. Reuse the local Zen credential for the primary
# route when the default endpoint is selected; custom endpoints remain explicit
# and never receive a credential from another provider.
if (-not $VisionBaseUrlExplicit -and [string]::IsNullOrWhiteSpace($ConfiguredVisionApiKey)) {
    $ConfiguredVisionApiKey = Resolve-VisionCredential $ConfiguredVisionAuthPlatform
}
$VisionFallbacksExplicit = -not [string]::IsNullOrWhiteSpace($VisionFallbacksJson) -or
    -not [string]::IsNullOrWhiteSpace($env:VISION_FALLBACKS_JSON)
$ConfiguredVisionFallbacksJson = if (-not [string]::IsNullOrWhiteSpace($VisionFallbacksJson)) {
    $VisionFallbacksJson
} elseif (-not [string]::IsNullOrWhiteSpace($env:VISION_FALLBACKS_JSON)) {
    $env:VISION_FALLBACKS_JSON
} elseif ($catalogVisionRoutes.Count -gt 1) {
    # La cadena persistida del panel (/fallback) llega en visionModels del
    # catálogo sincronizado. La ruta con prioridad 1 es el primary; el resto
    # se convierte en fallbacks cuyo apiKeyEnv apunta a una variable aislada
    # que el launcher rellena con la clave DPAPI de authPlatform. Las claves
    # nunca entran en el JSON ni en este script.
    $fallbackRows = @()
    for ($index = 1; $index -lt $catalogVisionRoutes.Count; $index++) {
        $route = $catalogVisionRoutes[$index]
        $keyEnv = "BRIDGE_VISION_ROUTE_KEY_$index"
        $routePlatform = if (-not [string]::IsNullOrWhiteSpace([string]$route.authPlatform)) { [string]$route.authPlatform } else { [string]$route.provider }
        $routeKey = Resolve-VisionCredential $routePlatform
        if (-not [string]::IsNullOrWhiteSpace($routeKey)) { $VisionCredentialEnvironment[$keyEnv] = $routeKey }
        $fallbackRows += [ordered]@{
            id = [string]$route.routeId
            baseUrl = [string]$route.baseUrl
            completionsPath = if (-not [string]::IsNullOrWhiteSpace([string]$route.completionsPath)) { [string]$route.completionsPath } else { '/chat/completions' }
            model = [string]$route.id
            apiKeyEnv = $keyEnv
        }
    }
    if ($fallbackRows.Count -gt 0) { $fallbackRows | ConvertTo-Json -Compress } else { '[]' }
} else {
    '[{"id":"opencode-go","baseUrl":"https://opencode.ai/zen/go/v1","model":"mimo-v2.5","apiKeyEnv":"OPENCODE_GO_VISION_API_KEY"}]'
}
$ConfiguredVisionFallbackApiKey = $env:OPENCODE_GO_VISION_API_KEY
if (-not $VisionFallbacksExplicit -and $catalogVisionRoutes.Count -le 1 -and [string]::IsNullOrWhiteSpace($ConfiguredVisionFallbackApiKey)) {
    $ConfiguredVisionFallbackApiKey = Resolve-VisionCredential 'opencode-go'
}
if ($VisionFallbacksExplicit -and -not [string]::IsNullOrWhiteSpace($ConfiguredVisionFallbacksJson)) {
    try {
        $explicitFallbackRows = @($ConfiguredVisionFallbacksJson | ConvertFrom-Json)
        $processEnv = @{}
        foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
            $processEnv[$entry.Key] = [string]$entry.Value
        }
        foreach ($row in $explicitFallbackRows) {
            $keyEnv = if ($row -and $row.apiKeyEnv) { [string]$row.apiKeyEnv } else { '' }
            if ($keyEnv -and $processEnv.ContainsKey($keyEnv)) { $VisionCredentialEnvironment[$keyEnv] = $processEnv[$keyEnv] }
        }
    }
    catch { throw 'VISION_FALLBACKS_JSON no contiene una configuración JSON válida.' }
}
$ConfiguredVisionCompletionsPath = if (-not [string]::IsNullOrWhiteSpace($env:VISION_COMPLETIONS_PATH)) {
    $env:VISION_COMPLETIONS_PATH
} elseif ($primaryVisionRoute -and -not [string]::IsNullOrWhiteSpace([string]$primaryVisionRoute.completionsPath)) {
    [string]$primaryVisionRoute.completionsPath
} else { '/chat/completions' }
$ConfiguredVisionDisabled = if (-not [string]::IsNullOrWhiteSpace($env:VISION_DISABLE)) {
    $env:VISION_DISABLE
} elseif ($catalogVisionHasProjection -and $catalogVisionRoutes.Count -eq 0 -and
    -not $VisionBaseUrlExplicit -and -not $VisionModelExplicit -and -not $VisionFallbacksExplicit) {
    '1'
} else { '0' }
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
        $env:BRIDGE_MODEL_CATALOG_FILE = $catalogFile
        $env:BRIDGE_PORT = [string]$Port
        $env:GLORY_API_CONTRACT = 'chat-completions-v1'
        $env:VISION_BASE_URL = $ConfiguredVisionBaseUrl
        $env:VISION_COMPLETIONS_PATH = $ConfiguredVisionCompletionsPath
        $env:VISION_MODEL = $ConfiguredVisionModel
        $env:VISION_API_KEY = $ConfiguredVisionApiKey
        $env:VISION_ALLOW_ANONYMOUS = $ConfiguredVisionAnonymous
        $env:VISION_DISABLE = $ConfiguredVisionDisabled
        $env:VISION_FALLBACKS_JSON = $ConfiguredVisionFallbacksJson
        $env:OPENCODE_GO_VISION_API_KEY = $ConfiguredVisionFallbackApiKey
        foreach ($credentialName in $VisionCredentialEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($credentialName, [string]$VisionCredentialEnvironment[$credentialName], 'Process')
        }
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
