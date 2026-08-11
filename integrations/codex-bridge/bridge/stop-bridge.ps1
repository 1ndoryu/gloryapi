# Detiene únicamente este bridge local; nunca mata un proceso solo por usar :4100.
#   -Force              -> además detiene un proceso ajeno que ocupe :4100
#   -WaitReleaseSeconds -> espera a que el puerto quede libre tras el stop (0 desactiva)
param(
    [switch]$Force,
    [int]$WaitReleaseSeconds = 10,
    [ValidateRange(1, 65535)]
    [int]$Port = 4100,
    [string]$RuntimeDataDir = ''
)
$ErrorActionPreference = 'Stop'
$bridgeLink = Get-Item -LiteralPath $PSScriptRoot -Force
$BridgeDir = if ($bridgeLink.LinkType -eq 'Junction' -and $bridgeLink.Target) {
    (Resolve-Path -LiteralPath ([string](@($bridgeLink.Target) | Select-Object -First 1))).Path
} else { $PSScriptRoot }
$RuntimeDir = if ([string]::IsNullOrWhiteSpace($RuntimeDataDir)) {
    $serverData = (Resolve-Path (Join-Path $BridgeDir '..\..\..\server\data')).Path
    Join-Path $serverData 'bridge-runtime'
} else {
    [System.IO.Path]::GetFullPath($RuntimeDataDir)
}
$PidFile = Join-Path $RuntimeDir 'bridge.pid'
$ServerFile = [System.IO.Path]::GetFullPath((Join-Path $BridgeDir 'server.js'))

function Test-BridgeProcess([int]$ProcessIdValue) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessIdValue" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    if ($process.Name -notmatch '^node(?:\.exe)?$') { return $false }
    return $process.CommandLine -and
        $process.CommandLine.IndexOf($ServerFile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-PortListening {
    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-PortOwnedBy([int]$ProcessIdValue) {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    return @($connections | Where-Object { [int]$_.OwningProcess -eq $ProcessIdValue }).Count -gt 0
}

function Wait-PortRelease([int]$Seconds) {
    if ($Seconds -le 0) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline -and (Test-PortListening)) {
        Start-Sleep -Milliseconds 200
    }
}

$stopped = @()
if (Test-Path -LiteralPath $PidFile) {
    $rawProcessId = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $processIdValue = 0
    if (-not [int]::TryParse($rawProcessId, [ref]$processIdValue)) {
        throw "bridge.pid no contiene un PID válido: $rawProcessId"
    }
    $running = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
    if ($running) {
        if (-not (Test-BridgeProcess $processIdValue)) {
            if (-not $Force) {
                throw "El PID $processIdValue no pertenece a $ServerFile; se rechaza detenerlo."
            }
            if (-not (Test-PortOwnedBy $processIdValue)) {
                throw "El PID $processIdValue no está verificado como listener del puerto $Port; se rechaza detenerlo."
            }
            Write-Warning "El PID $processIdValue no pertenece a $ServerFile; se detiene por -Force."
        }
        Stop-Process -Id $processIdValue -Force
        $stopped += $processIdValue
    }
    Remove-Item -LiteralPath $PidFile -Force
}

# Fallback: el puerto identifica candidatos, pero el comando debe coincidir.
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $processIds = @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
    $bridgeProcessIds = @($processIds | Where-Object { Test-BridgeProcess ([int]$_) })
    $foreignProcessIds = @($processIds | Where-Object { -not (Test-BridgeProcess ([int]$_)) })
    if ($foreignProcessIds.Count -gt 0) {
        if (-not $Force) {
            throw "El puerto $Port está ocupado total o parcialmente por un proceso ajeno; no se detuvo nada."
        }
        Write-Warning "El puerto $Port está ocupado por procesos ajenos (PID $($foreignProcessIds -join ', ')); se detienen por -Force."
    }
    @($bridgeProcessIds + $foreignProcessIds) | ForEach-Object {
        Stop-Process -Id $_ -Force
        $stopped += $_
    }
}

if ($stopped.Count -gt 0) {
    Write-Host "Bridge detenido (PID $($stopped -join ', '))"
    Wait-PortRelease $WaitReleaseSeconds
    if (Test-PortListening) {
        Write-Warning "El puerto $Port sigue ocupado tras esperar $WaitReleaseSeconds s; revisa qué proceso lo mantiene."
    } else {
        Write-Host "Puerto $Port liberado."
    }
    exit 0
}

Write-Host 'El bridge no está corriendo.'
