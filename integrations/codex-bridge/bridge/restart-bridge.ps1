# Reinicia el bridge local Codex <-> GloryAPI (deepseek-v4-flash) en un solo paso.
#   .\restart-bridge.ps1           -> stop + start + health (con espera de puerto)
#   .\restart-bridge.ps1 -Force    -> sustituye también un proceso ajeno en :4100
#   .\restart-bridge.ps1 -Runtime  -> además reinicia el runtime GloryAPI :3101
param(
    [switch]$Force,
    [switch]$Runtime
)
$ErrorActionPreference = 'Stop'
$bridgeLink = Get-Item -LiteralPath $PSScriptRoot -Force
$BridgeDir = if ($bridgeLink.LinkType -eq 'Junction' -and $bridgeLink.Target) {
    (Resolve-Path -LiteralPath ([string](@($bridgeLink.Target) | Select-Object -First 1))).Path
} else { $PSScriptRoot }

if ($Runtime) {
    $ProjectRoot = (Resolve-Path (Join-Path $BridgeDir '..\..\..')).Path
    $DataDir = Join-Path $ProjectRoot 'server\data'
    $RuntimePidFile = Join-Path $DataDir 'gloryapi.pid'
    $RuntimeServer = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'server\dist\index.js'))
    $RuntimePort = 3101

    function Test-RuntimeProcess([int]$ProcessIdValue) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessIdValue" -ErrorAction SilentlyContinue
        if (-not $process) { return $false }
        if ($process.Name -notmatch '^node(?:\.exe)?$') { return $false }
        return $process.CommandLine -and
            $process.CommandLine.IndexOf($RuntimeServer, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }

    $runtimeStopped = @()
    if (Test-Path -LiteralPath $RuntimePidFile) {
        $rawProcessId = (Get-Content -LiteralPath $RuntimePidFile -Raw).Trim()
        $processIdValue = 0
        if ([int]::TryParse($rawProcessId, [ref]$processIdValue)) {
            $running = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
            if ($running -and (Test-RuntimeProcess $processIdValue)) {
                Stop-Process -Id $processIdValue -Force
                $runtimeStopped += $processIdValue
                Write-Host "Runtime detenido (PID $processIdValue)"
            }
        }
        Remove-Item -LiteralPath $RuntimePidFile -Force
    }
    $conn = Get-NetTCPConnection -LocalPort $RuntimePort -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $runtimeOwnerPids = @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
        foreach ($ownerPid in $runtimeOwnerPids) {
            if (Test-RuntimeProcess ([int]$ownerPid)) {
                Stop-Process -Id $ownerPid -Force
                $runtimeStopped += $ownerPid
                Write-Host "Runtime detenido (por puerto $RuntimePort, PID $ownerPid)"
            }
            elseif (-not $Force) {
                throw "El puerto $RuntimePort está ocupado por un proceso ajeno (PID $ownerPid); usa -Force para sustituirlo."
            }
            else {
                Write-Warning "El puerto $RuntimePort está ocupado por un proceso ajeno (PID $ownerPid); se detiene por -Force."
                Stop-Process -Id $ownerPid -Force
                $runtimeStopped += $ownerPid
            }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline -and (Get-NetTCPConnection -LocalPort $RuntimePort -State Listen -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 200
        }
    }
    if ($runtimeStopped.Count -gt 0) {
        Write-Host 'Runtime GloryAPI detenido; se arrancará de nuevo con el build actual.'
    }
}

Write-Host 'Reiniciando bridge (stop + start + health)...'
& (Join-Path $BridgeDir 'start-bridge.ps1') -Restart -Force:$Force
if ($LASTEXITCODE -ne 0) {
    throw "start-bridge.ps1 falló con código $LASTEXITCODE."
}
Write-Host 'Bridge reiniciado y verificado.'