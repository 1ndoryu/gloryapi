# Codex auth command for the GloryAPI Responses sidecar.
# stdout is intentionally token-only; diagnostics go to stderr through the helper.
$ErrorActionPreference = 'Stop'
$modeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$authScript = Join-Path $modeDir '..\..\..\server\dist\scripts\bridge-auth.js'
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $authScript)) {
    throw 'Falta bridge-auth compilado; ejecuta npm run build:server.'
}
& $node $authScript --print
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
