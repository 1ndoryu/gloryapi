# Mantiene el ChatGPT normal y detiene el bridge si está activo, sin modificar
# config.toml ni el historial normal. El historial aislado permanece intacto.
# Para una migración global legacy explícita: codex-mode.ps1 -Mode chatgpt -LegacyGlobalConfig.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'codex-mode.ps1') -Mode chatgpt
exit $LASTEXITCODE
