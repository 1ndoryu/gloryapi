# Abre una sesión Codex separada para GloryAPI sin cambiar el ChatGPT normal.
[CmdletBinding()]
param(
    [string]$BridgeHome = (Join-Path $env:USERPROFILE '.codex-gloryapi'),
    [string]$SourceCodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$ProfileName = 'gloryapi-bridge',
    [ValidateRange(1024, 65535)]
    [int]$BridgePort = 4100,
    [string]$RuntimeDataDir = '',
    [string]$DatabasePath = '',
    [switch]$RefreshConfig,
    [switch]$PrepareOnly,
    [switch]$NoStartBridge,
    [switch]$Desktop,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArguments
)

$ErrorActionPreference = 'Stop'
$modeDir = $PSScriptRoot
$prepareScript = Join-Path $modeDir 'prepare-isolated-home.ps1'
$startBridgeScript = Join-Path $modeDir '..\bridge\start-bridge.ps1'

if (-not (Test-Path -LiteralPath $prepareScript -PathType Leaf)) {
    throw "Falta el preparador de CODEX_HOME aislado: $prepareScript"
}

$prepareArgs = @{
    BridgeHome = $BridgeHome
    SourceCodexHome = $SourceCodexHome
    ProfileName = $ProfileName
    BridgePort = $BridgePort
}
if ($RefreshConfig) { $prepareArgs.RefreshConfig = $true }
& $prepareScript @prepareArgs
if ($PrepareOnly) { exit 0 }

if (-not $NoStartBridge) {
    if (-not (Test-Path -LiteralPath $startBridgeScript -PathType Leaf)) {
        throw "Falta el launcher del bridge: $startBridgeScript"
    }
    $bridgeArgs = @{ Port = $BridgePort }
    if (-not [string]::IsNullOrWhiteSpace($RuntimeDataDir)) { $bridgeArgs.RuntimeDataDir = $RuntimeDataDir }
    if (-not [string]::IsNullOrWhiteSpace($DatabasePath)) { $bridgeArgs.DatabasePath = $DatabasePath }
    & $startBridgeScript @bridgeArgs
}

$codexCommand = Get-Command codex -ErrorAction Stop
$previousHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
$resolvedBridgeHome = [IO.Path]::GetFullPath($BridgeHome)
$resolvedHome = [IO.Path]::GetFullPath($SourceCodexHome)
if ($resolvedBridgeHome.Equals($resolvedHome, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'El CODEX_HOME del bridge coincide con el home normal.'
}

try {
    if ($Desktop) {
        # codex app no expone --profile en su subcomando, pero acepta las opciones
        # globales antes de `app`; el entorno aislado también separa el estado.
        $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
        if ([string]::IsNullOrWhiteSpace($pwsh)) { $pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source }
        $codexScript = $codexCommand.Source
        $appArgs = @('-NoLogo', '-NoProfile', '-File', $codexScript, '--profile', $ProfileName, 'app')
        if ($CodexArguments) { $appArgs += $CodexArguments }
        $process = Start-Process -FilePath $pwsh -ArgumentList $appArgs -WorkingDirectory (Get-Location).Path `
            -Environment @{ CODEX_HOME = $resolvedBridgeHome } -PassThru
        Write-Host "Desktop bridge solicitado. PID=$($process.Id) CODEX_HOME=$resolvedBridgeHome"
        Write-Host 'El Desktop puede reutilizar una instancia gráfica existente; si ocurre, usa la modalidad CLI/TUI sin -Desktop.'
        exit 0
    }

    [Environment]::SetEnvironmentVariable('CODEX_HOME', $resolvedBridgeHome, 'Process')
    & $codexCommand.Source '--profile' $ProfileName @CodexArguments
    exit $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable('CODEX_HOME', $previousHome, 'Process')
}
