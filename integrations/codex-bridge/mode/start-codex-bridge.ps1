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
    [string]$DesktopUserDataDir = '',
    [string]$DesktopExecutable = '',
    [string]$VisionBaseUrl = '',
    [string]$VisionModel = '',
    [string]$VisionFallbacksJson = '',
    [switch]$VisionAllowAnonymous,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArguments
)

$ErrorActionPreference = 'Stop'
$modeDir = $PSScriptRoot
$prepareScript = Join-Path $modeDir 'prepare-isolated-home.ps1'
$startBridgeScript = Join-Path $modeDir '..\bridge\start-bridge.ps1'

function Resolve-DesktopExecutable {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending | Select-Object -First 1
    if ($package -and $package.InstallLocation) {
        $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $windowsAppsAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\ChatGPT.exe'
    if (Test-Path -LiteralPath $windowsAppsAlias -PathType Leaf) { return $windowsAppsAlias }
    return $null
}

function Start-BridgeProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [object[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$BridgeHomePath
    )

    $previousProcessHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
    try {
        # Start-Process -Environment no existe en Windows PowerShell 5.1,
        # que es el host usado por el acceso directo del escritorio.
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $BridgeHomePath, 'Process')
        return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -PassThru
    }
    finally {
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $previousProcessHome, 'Process')
    }
}

if (-not (Test-Path -LiteralPath $prepareScript -PathType Leaf)) {
    throw "Falta el preparador de CODEX_HOME aislado: $prepareScript"
}

if (-not $NoStartBridge -and -not $PrepareOnly) {
    if (-not (Test-Path -LiteralPath $startBridgeScript -PathType Leaf)) {
        throw "Falta el launcher del bridge: $startBridgeScript"
    }
    $bridgeArgs = @{ Port = $BridgePort }
    # RefreshConfig means that the persisted catalog may have changed. The
    # running bridge keeps its catalog in memory, so it must reload before the
    # Desktop home is regenerated; otherwise the shortcut can reopen a window
    # with a fresh models.json backed by a stale bridge revision.
    if ($RefreshConfig) { $bridgeArgs.Restart = $true }
    if (-not [string]::IsNullOrWhiteSpace($RuntimeDataDir)) { $bridgeArgs.RuntimeDataDir = $RuntimeDataDir }
    if (-not [string]::IsNullOrWhiteSpace($DatabasePath)) { $bridgeArgs.DatabasePath = $DatabasePath }
    if (-not [string]::IsNullOrWhiteSpace($VisionBaseUrl)) { $bridgeArgs.VisionBaseUrl = $VisionBaseUrl }
    if (-not [string]::IsNullOrWhiteSpace($VisionModel)) { $bridgeArgs.VisionModel = $VisionModel }
    if (-not [string]::IsNullOrWhiteSpace($VisionFallbacksJson)) { $bridgeArgs.VisionFallbacksJson = $VisionFallbacksJson }
    if ($VisionAllowAnonymous) { $bridgeArgs.VisionAllowAnonymous = $true }
    & $startBridgeScript @bridgeArgs
}

$prepareArgs = @{
    BridgeHome = $BridgeHome
    SourceCodexHome = $SourceCodexHome
    ProfileName = $ProfileName
    BridgePort = $BridgePort
    CatalogSourcePath = if (-not [string]::IsNullOrWhiteSpace($RuntimeDataDir)) {
        Join-Path ([IO.Path]::GetFullPath($RuntimeDataDir)) 'bridge-model-catalog.json'
    } else {
        Join-Path $env:USERPROFILE '.gloryapi\runtime\bridge-runtime\bridge-model-catalog.json'
    }
}
if ($RefreshConfig) { $prepareArgs.RefreshConfig = $true }
& $prepareScript @prepareArgs
if ($PrepareOnly) { exit 0 }

$codexCommand = Get-Command codex -ErrorAction Stop
$previousHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
$resolvedBridgeHome = [IO.Path]::GetFullPath($BridgeHome)
$resolvedHome = [IO.Path]::GetFullPath($SourceCodexHome)
if ($resolvedBridgeHome.Equals($resolvedHome, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'El CODEX_HOME del bridge coincide con el home normal.'
}

try {
    if ($Desktop) {
        $resolvedDesktopData = if ([string]::IsNullOrWhiteSpace($DesktopUserDataDir)) {
            Join-Path $resolvedBridgeHome 'desktop-user-data-bridge'
        } else {
            [IO.Path]::GetFullPath($DesktopUserDataDir)
        }
        New-Item -ItemType Directory -Path $resolvedDesktopData -Force | Out-Null

        $desktopExe = if ([string]::IsNullOrWhiteSpace($DesktopExecutable)) {
            Resolve-DesktopExecutable
        } else {
            [IO.Path]::GetFullPath($DesktopExecutable)
        }

        if ($desktopExe -and (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
            $desktopArgs = @(
                "--user-data-dir=$resolvedDesktopData",
                "--profile=$ProfileName"
            )
            if ($CodexArguments) { $desktopArgs += $CodexArguments }
            if ([IO.Path]::GetExtension($desktopExe) -ieq '.ps1') {
                $desktopHost = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
                if ([string]::IsNullOrWhiteSpace($desktopHost)) { $desktopHost = (Get-Command powershell.exe -ErrorAction Stop).Source }
                $desktopArgs = @('-NoLogo', '-NoProfile', '-File', $desktopExe) + $desktopArgs
            } else {
                $desktopHost = $desktopExe
            }
            $process = Start-BridgeProcess -FilePath $desktopHost -ArgumentList $desktopArgs `
                -WorkingDirectory (Get-Location).Path -BridgeHomePath $resolvedBridgeHome
            Write-Host "Desktop bridge solicitado. PID=$($process.Id) CODEX_HOME=$resolvedBridgeHome"
            Write-Host "Desktop data: $resolvedDesktopData"
        } else {
            # Fallback para instalaciones sin el paquete Windows de Desktop.
            $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
            if ([string]::IsNullOrWhiteSpace($pwsh)) { $pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source }
            $codexScript = $codexCommand.Source
            $appArgs = @('-NoLogo', '-NoProfile', '-File', $codexScript, '--profile', $ProfileName, 'app')
            if ($CodexArguments) { $appArgs += $CodexArguments }
            $process = Start-BridgeProcess -FilePath $pwsh -ArgumentList $appArgs `
                -WorkingDirectory (Get-Location).Path -BridgeHomePath $resolvedBridgeHome
            Write-Host "Desktop bridge solicitado por fallback Codex. PID=$($process.Id) CODEX_HOME=$resolvedBridgeHome"
            Write-Host 'No se encontró ChatGPT.exe; el fallback puede reutilizar una instancia gráfica existente.'
        }
        exit 0
    }

    [Environment]::SetEnvironmentVariable('CODEX_HOME', $resolvedBridgeHome, 'Process')
    & $codexCommand.Source '--profile' $ProfileName @CodexArguments
    exit $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable('CODEX_HOME', $previousHome, 'Process')
}
