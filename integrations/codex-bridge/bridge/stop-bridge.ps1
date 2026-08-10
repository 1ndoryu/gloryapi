# Detiene únicamente este bridge local; nunca mata un proceso solo por usar :4100.
$ErrorActionPreference = 'Stop'
$bridgeLink = Get-Item -LiteralPath $PSScriptRoot -Force
$BridgeDir = if ($bridgeLink.LinkType -eq 'Junction' -and $bridgeLink.Target) {
    (Resolve-Path -LiteralPath ([string](@($bridgeLink.Target) | Select-Object -First 1))).Path
} else { $PSScriptRoot }
$RuntimeDir = (Resolve-Path (Join-Path $BridgeDir '..\..\..\server\data')).Path
$RuntimeDir = Join-Path $RuntimeDir 'bridge-runtime'
$PidFile = Join-Path $RuntimeDir 'bridge.pid'
$ServerFile = [System.IO.Path]::GetFullPath((Join-Path $BridgeDir 'server.js'))

function Test-BridgeProcess([int]$ProcessIdValue) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessIdValue" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    if ($process.Name -notmatch '^node(?:\.exe)?$') { return $false }
    return $process.CommandLine -and
        $process.CommandLine.IndexOf($ServerFile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

if (Test-Path -LiteralPath $PidFile) {
    $rawProcessId = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $processIdValue = 0
    if (-not [int]::TryParse($rawProcessId, [ref]$processIdValue)) {
        throw "bridge.pid no contiene un PID válido: $rawProcessId"
    }
    $running = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
    if ($running) {
        if (-not (Test-BridgeProcess $processIdValue)) {
            throw "El PID $processIdValue no pertenece a $ServerFile; se rechaza detenerlo."
        }
        Stop-Process -Id $processIdValue -Force
        Write-Host "Bridge detenido (PID $processIdValue)"
    }
    Remove-Item -LiteralPath $PidFile -Force
    exit 0
}

# Fallback: el puerto identifica candidatos, pero el comando debe coincidir.
$conn = Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $processIds = @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
    $bridgeProcessIds = @($processIds | Where-Object { Test-BridgeProcess ([int]$_) })
    if ($bridgeProcessIds.Count -ne $processIds.Count) {
        throw 'El puerto 4100 está ocupado total o parcialmente por un proceso ajeno; no se detuvo nada.'
    }
    $bridgeProcessIds | ForEach-Object { Stop-Process -Id $_ -Force }
    Write-Host 'Bridge detenido (por puerto 4100)'
    exit 0
}

Write-Host 'El bridge no está corriendo.'
