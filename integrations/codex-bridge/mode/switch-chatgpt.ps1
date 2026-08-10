# Revierte Codex (CLI y app de escritorio) al proveedor ChatGPT.
# Vuelve a DeepSeek en cualquier momento con:  .\switch-deepseek.ps1
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'codex-mode.ps1') -Mode chatgpt
exit $LASTEXITCODE
