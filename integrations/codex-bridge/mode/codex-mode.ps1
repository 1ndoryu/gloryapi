# =====================================================================
#  codex-mode.ps1  — CAMBIA CODEX ENTRE PROVEEDORES EN UN SOLO PASO
# ---------------------------------------------------------------------
#  Uso:
#    .\codex-mode.ps1 -Mode chatgpt   -> proveedor ChatGPT (detiene el bridge)
#    .\codex-mode.ps1 -Mode deepseek  -> deepseek-v4-flash vía bridge local
#    .\codex-mode.ps1                 -> muestra el modo actual
#
#  Después de cambiar, CIERRA la app de escritorio (bandeja incluida)
#  y vuelve a abrirla para que relea config.toml.
# =====================================================================
param(
    [ValidateSet('chatgpt', 'deepseek', '')]
    [string]$Mode = ''
)

$ErrorActionPreference = 'Stop'
$codex = Join-Path $env:USERPROFILE '.codex'
$bridge = Join-Path $codex 'bridge'

function Get-CurrentMode {
    $cfg = Get-Content (Join-Path $codex 'config.toml') -Raw
    if ($cfg -match '(?m)^\s*model_provider\s*=\s*"freellm"\s*$') { return 'deepseek' }
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

function Set-CodexConfig([string]$SourceName) {
    $source = Join-Path $codex $SourceName
    $destination = Join-Path $codex 'config.toml'
    if (-not (Test-Path -LiteralPath $source)) {
        throw "No existe la configuración fuente: $source"
    }
    $temporary = Join-Path $codex "config.toml.tmp.$PID"
    try {
        Copy-Item -LiteralPath $source -Destination $temporary -Force
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

# ---- Sin argumentos: solo informar ----
if ($Mode -eq '') {
    $cur = Get-CurrentMode
    $b = Test-Bridge
    Write-Host "Modo actual: $cur"
    Write-Host "Bridge :4100: $(if($b){'CORRIENDO'}else{'detenido'})"
    Write-Host ''
    Write-Host 'Cambiar con:  .\codex-mode.ps1 -Mode chatgpt   |   .\codex-mode.ps1 -Mode deepseek'
    exit 0
}

# ---- Modo CHATGPT: restaura config y detiene el bridge ----
if ($Mode -eq 'chatgpt') {
    Set-CodexConfig 'config.chatgpt.toml'
    Write-Host '[OK] config.toml -> CHATGPT'
    if (Test-Bridge) {
        if (Test-Path (Join-Path $bridge 'stop-bridge.ps1')) {
            & (Join-Path $bridge 'stop-bridge.ps1')
        }
    }
}

# ---- Modo DEEPSEEK: arranca el bridge (si falta) y aplica la config ----
if ($Mode -eq 'deepseek') {
    if (-not (Test-Bridge)) {
        Write-Host 'Bridge no está corriendo. Arrancándolo...'
        if (-not (Test-Path (Join-Path $bridge 'start-bridge.ps1'))) {
            Write-Error 'Falta el bridge en .codex\bridge\. No se puede pasar a deepseek.'
        }
        & (Join-Path $bridge 'start-bridge.ps1')
        if (-not (Test-Bridge)) {
            Write-Error 'El bridge no respondió tras el arranque. Revisa .codex\bridge\bridge.err.log'
        }
    }
    Set-CodexConfig 'config.deepseek.toml'
    Write-Host '[OK] config.toml -> DEEPSEEK (deepseek-v4-flash vía bridge)'
}

Write-Host 'Cierra la app de escritorio (ChatGPT en la bandeja) y vuelve a abrirla para aplicar.'
Write-Host ('Modo ahora: {0}' -f (Get-CurrentMode))
