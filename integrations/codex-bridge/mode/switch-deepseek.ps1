# Cambia Codex (CLI y app de escritorio) al proveedor DeepSeek flash via bridge local.
# Reversible en cualquier momento con:  .\switch-chatgpt.ps1
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'codex-mode.ps1') -Mode deepseek
exit $LASTEXITCODE
