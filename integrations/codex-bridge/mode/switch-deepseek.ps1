# Abre una sesión DeepSeek vía bridge con CODEX_HOME e historial separados.
# El ChatGPT normal puede seguir abierto; revierte cerrando esa ventana o
# usando .\switch-chatgpt.ps1 para detener el bridge sin mutar el home normal.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'codex-mode.ps1') -Mode deepseek
exit $LASTEXITCODE
