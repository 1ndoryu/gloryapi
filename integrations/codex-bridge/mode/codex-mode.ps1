# =====================================================================
#  codex-mode.ps1  — ABRE CODEX NORMAL O UNA SESIÓN AISLADA DEL BRIDGE
# ---------------------------------------------------------------------
#  Uso:
#    .\codex-mode.ps1 -Mode chatgpt   -> proveedor ChatGPT (detiene el bridge)
#    .\codex-mode.ps1 -Mode deepseek  -> sesión aislada deepseek-v4-flash
#    .\codex-mode.ps1                 -> muestra el modo actual
#
#  La sesión normal conserva su CODEX_HOME e historial. El modo deepseek
#  usa %USERPROFILE%\.codex-gloryapi y puede convivir con el modo normal.
# =====================================================================
param(
    [ValidateSet('chatgpt', 'deepseek', '')]
    [string]$Mode = '',
    [switch]$Preview,
    [switch]$LegacyGlobalConfig
)

$ErrorActionPreference = 'Stop'
$codex = Join-Path $env:USERPROFILE '.codex'
$isolatedHome = Join-Path $env:USERPROFILE '.codex-gloryapi'
$bridge = Join-Path $codex 'bridge'
$configPath = Join-Path $codex 'config.toml'
$journalPath = Join-Path $codex 'config.toml.gloryapi.journal.json'
$lockPath = Join-Path $codex 'config.toml.gloryapi.lock'
$controllerLink = Get-Item -LiteralPath $MyInvocation.MyCommand.Path -Force
$modeSource = if ($controllerLink.LinkType -and $controllerLink.Target) {
    Split-Path -Parent ([string](@($controllerLink.Target) | Select-Object -First 1))
} else { $PSScriptRoot }
$isolatedLauncher = Join-Path $modeSource 'start-codex-bridge.ps1'

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-ConfigJournal([hashtable]$Entry) {
    $temporary = "$journalPath.tmp.$PID"
    try {
        $json = $Entry | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $journalPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Enter-ConfigLock {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        }
        catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 100
        }
    }
    throw "No se pudo adquirir el lock de configuración: $lockPath"
}

function Recover-ConfigTransaction {
    if (-not (Test-Path -LiteralPath $journalPath)) { return }
    $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
    if ($journal.status -ne 'pending') { return }
    $destinationHash = Get-FileSha256 $configPath
    if ($destinationHash -eq $journal.sourceHash) {
        Write-ConfigJournal @{ schemaVersion = 'glory-codex-config-journal-v1'; status = 'committed'; transactionId = $journal.transactionId; mode = $journal.mode; sourceHash = $journal.sourceHash; destinationHash = $destinationHash; recoveredAt = [DateTime]::UtcNow.ToString('o') }
        return
    }
    $temporary = $journal.temporaryPath
    if ($temporary -and (Test-Path -LiteralPath $temporary) -and (Get-FileSha256 $temporary) -eq $journal.sourceHash) {
        Move-Item -LiteralPath $temporary -Destination $configPath -Force
        $destinationHash = Get-FileSha256 $configPath
        if ($destinationHash -ne $journal.sourceHash) { throw 'La recuperación del journal no produjo el hash esperado' }
        Write-ConfigJournal @{ schemaVersion = 'glory-codex-config-journal-v1'; status = 'committed'; transactionId = $journal.transactionId; mode = $journal.mode; sourceHash = $journal.sourceHash; destinationHash = $destinationHash; recoveredAt = [DateTime]::UtcNow.ToString('o') }
        return
    }
    throw "Journal pendiente ambiguo; no se sobrescribe config.toml automáticamente: $journalPath"
}

function Get-CurrentMode {
    Recover-ConfigTransaction
    $cfg = Get-Content $configPath -Raw
    # El perfil actual usa gloryapi-canary; freellm se conserva solo para
    # reconocer instalaciones antiguas durante la transición.
    if ($cfg -match '(?m)^\s*model_provider\s*=\s*"(?:freellm|gloryapi(?:-[^"\s]+)?)"\s*$') { return 'deepseek' }
    if ($cfg -match '(?m)^\s*model\s*=') { return 'chatgpt' }
    return 'desconocido'
}

function Get-BridgeHealth {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4100/health' -TimeoutSec 2
        if ($health.ok -and $health.service -eq 'gloryapi-codex-bridge' -and $health.model -eq 'deepseek-v4-flash') {
            return $health
        }
    }
    catch { }
    return $null
}

function Test-Bridge {
    return $null -ne (Get-BridgeHealth)
}

function Invoke-ActivationPreflight([switch]$SkipHealth) {
    $preflight = Join-Path $modeSource 'codex-activation-preflight.ps1'
    if (-not (Test-Path -LiteralPath $preflight)) {
        throw "Falta el preflight de activación: $preflight"
    }
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $preflight, '-CodexHome', $codex, '-Json')
    if ($SkipHealth) { $arguments += '-SkipHealth' }
    $output = & powershell.exe @arguments 2>$null
    $exitCode = $LASTEXITCODE
    try { $result = (($output -join [Environment]::NewLine) | ConvertFrom-Json) }
    catch { throw 'El preflight de activación no devolvió un resultado JSON válido' }
    if ($exitCode -ne 0 -or -not $result.ready) {
        $failed = @($result.checks | Where-Object status -eq 'fail' | ForEach-Object id) -join ', '
        if ([string]::IsNullOrWhiteSpace($failed)) { $failed = 'resultado-no-listo' }
        throw "Preflight de activación bloqueado: $failed"
    }
    return $result
}

function Set-CodexConfig([string]$SourceName) {
    $source = Join-Path $codex $SourceName
    $destination = $configPath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "No existe la configuración fuente: $source"
    }
    $temporary = Join-Path $codex "config.toml.tmp.$PID"
    $lock = Enter-ConfigLock
    try {
        Recover-ConfigTransaction
        $sourceHash = Get-FileSha256 $source
        if (-not $sourceHash) { throw "No se pudo calcular el hash de la configuración fuente: $source" }
        $transactionId = [Guid]::NewGuid().ToString('N')
        Write-ConfigJournal @{
            schemaVersion = 'glory-codex-config-journal-v1'
            status = 'pending'
            transactionId = $transactionId
            mode = $SourceName
            sourcePath = $source
            destinationPath = $destination
            temporaryPath = $temporary
            previousHash = Get-FileSha256 $destination
            sourceHash = $sourceHash
            startedAt = [DateTime]::UtcNow.ToString('o')
        }
        Copy-Item -LiteralPath $source -Destination $temporary -Force
        Move-Item -LiteralPath $temporary -Destination $destination -Force
        $destinationHash = Get-FileSha256 $destination
        if ($destinationHash -ne $sourceHash) { throw 'La configuración reemplazada no coincide con la fuente' }
        Write-ConfigJournal @{
            schemaVersion = 'glory-codex-config-journal-v1'
            status = 'committed'
            transactionId = $transactionId
            mode = $SourceName
            sourceHash = $sourceHash
            destinationHash = $destinationHash
            committedAt = [DateTime]::UtcNow.ToString('o')
        }
    }
    catch {
        if (Test-Path -LiteralPath $journalPath) {
            try { Write-ConfigJournal @{ schemaVersion = 'glory-codex-config-journal-v1'; status = 'failed'; mode = $SourceName; error = $_.Exception.Message; failedAt = [DateTime]::UtcNow.ToString('o') } } catch { }
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if ($lock) { $lock.Dispose() }
    }
}

# ---- Sin argumentos: solo informar ----
if ($Mode -eq '') {
    $cur = Get-CurrentMode
    $b = Test-Bridge
    Write-Host "Modo actual: $cur"
    Write-Host "Bridge :4100: $(if($b){'CORRIENDO'}else{'detenido'})"
    Write-Host "Home normal: $codex"
    Write-Host "Home bridge: $isolatedHome"
    Write-Host ''
    Write-Host 'Cambiar con:  .\codex-mode.ps1 -Mode chatgpt   |   .\codex-mode.ps1 -Mode deepseek'
    exit 0
}

if ($Preview) {
    if ($Mode -eq 'chatgpt') {
        if ($LegacyGlobalConfig -and -not (Test-Path -LiteralPath (Join-Path $codex 'config.chatgpt.toml'))) {
            throw 'No existe la configuración fuente de ChatGPT'
        }
        if ($LegacyGlobalConfig) {
            Write-Host '[PREVIEW] ChatGPT legacy: restauraría config.toml y detendría el bridge si estuviera activo.'
        } else {
            Write-Host '[PREVIEW] ChatGPT normal: detendría el bridge si estuviera activo, sin tocar config.toml.'
        }
    } else {
        if (-not (Test-Path -LiteralPath $isolatedLauncher -PathType Leaf)) {
            throw "Falta el launcher del home aislado: $isolatedLauncher"
        }
        Write-Host "[PREVIEW] DeepSeek: prepararía $isolatedHome, arrancaría el bridge y abriría una sesión separada."
        Write-Host '[PREVIEW] config.toml y el historial del home normal no se modificarían.'
    }
    exit 0
}

# ---- Modo CHATGPT: conserva el home normal y detiene el bridge ----
if ($Mode -eq 'chatgpt') {
    if ($LegacyGlobalConfig) {
        Set-CodexConfig 'config.chatgpt.toml'
        Write-Host '[OK] config.toml -> CHATGPT (restauración global legacy explícita)'
    } else {
        Write-Host '[OK] ChatGPT normal conserva config.toml e historial; no se hizo cutover global.'
    }
    if (Test-Bridge) {
        if (Test-Path (Join-Path $bridge 'stop-bridge.ps1')) {
            & (Join-Path $bridge 'stop-bridge.ps1')
        }
    }
}

# ---- Modo DEEPSEEK: abre el bridge con home e historial independientes ----
if ($Mode -eq 'deepseek') {
    if (-not (Test-Path -LiteralPath $isolatedLauncher -PathType Leaf)) {
        throw "Falta el launcher del home aislado: $isolatedLauncher"
    }
    & $isolatedLauncher -Desktop
    if ($LASTEXITCODE -ne 0) {
        throw 'No se pudo abrir la sesión DeepSeek aislada.'
    }
    Write-Host "[OK] DeepSeek vía bridge abierto con historial separado en $isolatedHome"
    Write-Host '[OK] El config.toml y el historial de ChatGPT normal no fueron reemplazados.'
    exit 0
}

if ($Mode -eq 'chatgpt' -and -not $LegacyGlobalConfig) {
    exit 0
}

Write-Host 'Cierra la app de escritorio (ChatGPT en la bandeja) y vuelve a abrirla para aplicar.'
Write-Host ('Modo ahora: {0}' -f (Get-CurrentMode))
