# Prepara un CODEX_HOME independiente para la sesión Codex que usa GloryAPI.
# Solo copia configuración; nunca copia auth.json ni bases/historial del home normal.
[CmdletBinding()]
param(
    [string]$BridgeHome = (Join-Path $env:USERPROFILE '.codex-gloryapi'),
    [string]$SourceCodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ProfileName = 'gloryapi-bridge',
    [ValidateRange(1024, 65535)]
    [int]$BridgePort = 4100,
    [switch]$RefreshConfig
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$PathValue) {
    return [IO.Path]::GetFullPath($PathValue).TrimEnd('\')
}

function Convert-ToTomlString([string]$Value) {
    return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

function Write-AtomicText([string]$PathValue, [string]$Content) {
    $temporary = "$PathValue.tmp.$PID"
    try {
        [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $PathValue -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Set-RootTomlValue([string]$Content, [string]$Key, [string]$Value) {
    $escapedKey = [regex]::Escape($Key)
    $pattern = "(?m)^[ \t]*$escapedKey[ \t]*=[^\r\n]*"
    if ([regex]::IsMatch($Content, $pattern)) {
        return [regex]::Replace($Content, $pattern, "$Key = $Value", 1)
    }
    return "$Key = $Value`r`n$Content"
}

function Set-SectionTomlValue([string]$Content, [string]$Section, [string]$Key, [string]$Value) {
    $escapedSection = [regex]::Escape($Section)
    $header = [regex]::Match($Content, "(?m)^\[$escapedSection\][ \t]*\r?$")
    if (-not $header.Success) {
        return "$($Content.TrimEnd())`r`n`r`n[$Section]`r`n$Key = $Value`r`n"
    }

    $sectionStart = $header.Index + $header.Length
    $remaining = $Content.Substring($sectionStart)
    $nextHeader = [regex]::Match($remaining, '(?m)^\s*\[')
    $sectionLength = if ($nextHeader.Success) { $nextHeader.Index } else { $remaining.Length }
    $sectionBody = $remaining.Substring(0, $sectionLength)
    $escapedKey = [regex]::Escape($Key)
    $keyPattern = "(?m)^[ \t]*$escapedKey[ \t]*=[^\r\n]*"
    if ([regex]::IsMatch($sectionBody, $keyPattern)) {
        $updatedBody = [regex]::Replace($sectionBody, $keyPattern, "$Key = $Value", 1)
        return $Content.Substring(0, $sectionStart) + $updatedBody + $remaining.Substring($sectionLength)
    }

    return $Content.Substring(0, $sectionStart) + "`r`n$Key = $Value" + $remaining.Substring(0, $sectionLength) + $remaining.Substring($sectionLength)
}

function Test-PathWithin([string]$ChildPath, [string]$ParentPath) {
    $child = (Resolve-FullPath $ChildPath).TrimEnd('\')
    $parent = (Resolve-FullPath $ParentPath).TrimEnd('\')
    return $child.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
        $child.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)
}

$SourceCodexHome = Resolve-FullPath $SourceCodexHome
$BridgeHome = Resolve-FullPath $BridgeHome
if ($SourceCodexHome.Equals($BridgeHome, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'El CODEX_HOME aislado debe ser diferente del CODEX_HOME normal.'
}

$sourceConfig = Join-Path $SourceCodexHome 'config.toml'
$bridgeConfig = Join-Path $BridgeHome 'config.toml'
$normalBaseConfig = Join-Path $BridgeHome 'normal-base.config.toml'
$profilePath = Join-Path $BridgeHome "$ProfileName.config.toml"
$authScript = Resolve-FullPath (Join-Path $PSScriptRoot 'get-codex-auth.ps1')
$modelsPath = Join-Path $SourceCodexHome 'models.json'
$sourceModelsCachePath = Join-Path $SourceCodexHome 'models_cache.json'

if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
    throw "No existe la configuración normal de Codex: $sourceConfig"
}
if (-not (Test-Path -LiteralPath $BridgeHome -PathType Container)) {
    New-Item -ItemType Directory -Path $BridgeHome -Force | Out-Null
}
$bridgeModelsPath = Join-Path $BridgeHome 'models.json'
$bridgeModelsCachePath = Join-Path $BridgeHome 'models_cache.json'
# El picker de modelos de Codex Desktop consume model_catalog_json (models.json),
# no /v1/models. Copiar el models.json normal dejaba una sola entrada
# (deepseek-v4-flash) y no se podían elegir CommandCode/Muse. Se genera un
# catálogo del bridge que conserva el default y añade los modelos CommandCode.
$catalogBuilder = Resolve-FullPath (Join-Path $PSScriptRoot 'build-model-catalog.cjs')
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$sourceModelsArg = if (Test-Path -LiteralPath $modelsPath -PathType Leaf) { $modelsPath } else { '-' }
$sourceCacheMetadataArg = if (Test-Path -LiteralPath $sourceModelsCachePath -PathType Leaf) { $sourceModelsCachePath } else { '-' }
& $nodeExe $catalogBuilder $sourceModelsArg $bridgeModelsPath $bridgeModelsCachePath $sourceCacheMetadataArg
if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo generar el catálogo de modelos del bridge (build-model-catalog.cjs).'
}

$existingBridgeConfig = if (Test-Path -LiteralPath $bridgeConfig -PathType Leaf) {
    [IO.File]::ReadAllText($bridgeConfig)
} else {
    ''
}
$sourceContent = [IO.File]::ReadAllText($sourceConfig)
$bridgeProviderPattern = '(?m)^\s*model_provider\s*=\s*"{0}"\s*$' -f [regex]::Escape($ProfileName)
$needsBridgeConfig = $RefreshConfig -or
    -not (Test-Path -LiteralPath $bridgeConfig -PathType Leaf) -or
    -not (Test-Path -LiteralPath $normalBaseConfig -PathType Leaf) -or
    $existingBridgeConfig -notmatch $bridgeProviderPattern

$authArgs = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $authScript
) | ForEach-Object { Convert-ToTomlString $_ }

$catalogLine = if (Test-Path -LiteralPath $bridgeModelsPath -PathType Leaf) {
    "model_catalog_json = $(Convert-ToTomlString (Resolve-FullPath $bridgeModelsPath))"
} else {
    ''
}

$runtimeModulesPath = $null
$runtimeModulesMatch = [regex]::Match($sourceContent, '(?m)^[ \t]*NODE_REPL_NODE_MODULE_DIRS[ \t]*=[ \t]*[''"]([^''"]+)[''"][ \t]*\r?$')
$trustedPaths = @((Resolve-FullPath $BridgeHome))
if ($runtimeModulesMatch.Success) {
    $candidateRuntimeModulesPath = Resolve-FullPath $runtimeModulesMatch.Groups[1].Value
    if (-not (Test-PathWithin $candidateRuntimeModulesPath $SourceCodexHome)) {
        $runtimeModulesPath = $candidateRuntimeModulesPath
        if (-not (Test-PathWithin $runtimeModulesPath $BridgeHome)) { $trustedPaths += $runtimeModulesPath }
    }
}
$trustedPaths = ($trustedPaths | Select-Object -Unique) -join ';'
$providerBlock = @"

[model_providers.$ProfileName]
name = "GloryAPI Bridge (isolated)"
base_url = "http://127.0.0.1:$BridgePort/v1"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 300000

[model_providers.$ProfileName.auth]
command = "powershell.exe"
args = [$($authArgs -join ', ')]
timeout_ms = 5000
refresh_interval_ms = 300000

[history]
persistence = "save-all"
"@

if ($needsBridgeConfig) {
    # normal-base.config.toml conserva una copia de configuración, no estado.
    Copy-Item -LiteralPath $sourceConfig -Destination $normalBaseConfig -Force
    $bridgeBase = $sourceContent
    $bridgeBase = Set-RootTomlValue $bridgeBase 'model' '"deepseek-v4-flash"'
    $bridgeBase = Set-RootTomlValue $bridgeBase 'model_provider' (Convert-ToTomlString $ProfileName)
    $bridgeBase = Set-RootTomlValue $bridgeBase 'model_reasoning_effort' '"high"'
    if ($catalogLine) { $bridgeBase = Set-RootTomlValue $bridgeBase 'model_catalog_json' (Convert-ToTomlString (Resolve-FullPath $bridgeModelsPath)) }
    $bridgeBase = Set-RootTomlValue $bridgeBase 'log_dir' (Convert-ToTomlString (Join-Path $BridgeHome 'log'))
    $moduleDirsPattern = '(?m)^[ \t]*NODE_REPL_NODE_MODULE_DIRS[ \t]*=[^\r\n]*(?:\r?\n)?'
    $moduleDirsValue = if ($runtimeModulesPath) {
        "NODE_REPL_NODE_MODULE_DIRS = $(Convert-ToTomlString $runtimeModulesPath)`r`n"
    } else {
        ''
    }
    $bridgeBase = [regex]::Replace($bridgeBase, $moduleDirsPattern, $moduleDirsValue, 1)
    $bridgeBase = Set-SectionTomlValue $bridgeBase 'mcp_servers.node_repl.env' 'CODEX_HOME' (Convert-ToTomlString $BridgeHome)
    $trustedPattern = "(?m)^[ \t]*NODE_REPL_TRUSTED_CODE_PATHS[ \t]*=[^\r\n]*"
    if ([regex]::IsMatch($bridgeBase, $trustedPattern)) {
        $bridgeBase = [regex]::Replace($bridgeBase, $trustedPattern, "NODE_REPL_TRUSTED_CODE_PATHS = $(Convert-ToTomlString $trustedPaths)")
    } else {
        $bridgeBase = Set-SectionTomlValue $bridgeBase 'mcp_servers.node_repl.env' 'NODE_REPL_TRUSTED_CODE_PATHS' (Convert-ToTomlString $trustedPaths)
    }
    $bridgeBase = [regex]::Replace($bridgeBase, '(?m)^[ \t]*js_repl[ \t]*=[^\r\n]*', 'js_repl = true', 1)
    Write-AtomicText $bridgeConfig ($bridgeBase.TrimEnd() + $providerBlock)
}

$profileContent = @"
# Generated by prepare-isolated-home.ps1.
# This profile has its own CODEX_HOME, state database and conversation history.
model = "deepseek-v4-flash"
model_provider = "$ProfileName"
model_reasoning_effort = "high"
$catalogLine
log_dir = $(Convert-ToTomlString (Join-Path $BridgeHome 'log'))
notify = []

[model_providers.$ProfileName]
name = "GloryAPI Bridge (isolated)"
base_url = "http://127.0.0.1:$BridgePort/v1"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 300000

[model_providers.$ProfileName.auth]
command = "powershell.exe"
args = [$($authArgs -join ', ')]
timeout_ms = 5000
refresh_interval_ms = 300000

[features]
js_repl = true

[mcp_servers.node_repl.env]
CODEX_HOME = $(Convert-ToTomlString $BridgeHome)
NODE_REPL_TRUSTED_CODE_PATHS = $(Convert-ToTomlString $trustedPaths)

[history]
persistence = "save-all"
"@

Write-AtomicText $profilePath $profileContent
Write-Host "CODEX_HOME aislado listo: $BridgeHome"
Write-Host "Perfil: $profilePath"
Write-Host "Configuración Desktop bridge: $bridgeConfig"
Write-Host 'No se copiaron conversaciones, auth.json ni bases SQLite del home normal.'
