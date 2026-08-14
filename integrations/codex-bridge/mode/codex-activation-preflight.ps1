# Read-only activation preflight for the GloryAPI Codex/ChatGPT bridge.
# It never changes the active Codex profile, links, processes, or bridge state.
param(
    [string]$CodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [switch]$Json,
    [switch]$SkipHealth
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$expectedBridge = Join-Path $projectRoot 'integrations\codex-bridge\bridge'
$expectedMode = Join-Path $projectRoot 'integrations\codex-bridge\mode'
$expectedAuthHelper = Join-Path $projectRoot 'server\dist\scripts\bridge-auth.js'
$expectedUpstreamAuthHelper = Join-Path $projectRoot 'server\dist\scripts\bridge-upstream-auth.js'
$expectedHealthUrl = 'http://127.0.0.1:4100/health'
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Id, [bool]$Passed, [string]$Detail) {
    $checks.Add([pscustomobject]@{
        id = $Id
        status = if ($Passed) { 'pass' } else { 'fail' }
        detail = $Detail
    })
}

function Normalize-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    try { return [IO.Path]::GetFullPath($Value).TrimEnd('\').ToLowerInvariant() }
    catch { return $Value.TrimEnd('\').ToLowerInvariant() }
}

function Link-Target([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force
    if ([string]::IsNullOrWhiteSpace([string]$item.LinkType)) { return $null }
    $target = @($item.Target) | Select-Object -First 1
    if ($null -eq $target) { return $null }
    return [string]$target
}

function Test-Link([string]$Id, [string]$Path, [string]$Expected) {
    $target = Link-Target $Path
    $normalizedTarget = if ($null -eq $target) { '' } else { Normalize-Path $target }
    $normalizedExpected = Normalize-Path $Expected
    $passed = (-not [string]::IsNullOrWhiteSpace($target)) -and ($normalizedTarget -eq $normalizedExpected)
    if ($passed) { Add-Check $Id $true 'target=gloryapi' }
    elseif ($null -eq $target) { Add-Check $Id $false 'missing-or-not-a-link' }
    else { Add-Check $Id $false 'target-not-gloryapi' }
}

Add-Check 'canonical-bridge-server' (Test-Path -LiteralPath (Join-Path $expectedBridge 'server.js')) 'server.js present in GloryAPI bridge'
Add-Check 'bridge-auth-helper' (Test-Path -LiteralPath $expectedAuthHelper) 'compiled DPAPI bridge-auth helper present'
$upstreamCredentialPresent = -not ([string]::IsNullOrWhiteSpace($env:GLORY_API_KEY) -and [string]::IsNullOrWhiteSpace($env:FREEL_API_KEY))
$upstreamVaultAvailable = $false
if (-not $upstreamCredentialPresent -and (Test-Path -LiteralPath $expectedUpstreamAuthHelper)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($node) {
        # PowerShell 7 can promote native stderr to a terminating error even
        # when it is redirected. The helper is intentionally allowed to fail
        # here (that is the check's result), so swallow that process failure
        # and keep producing the machine-readable preflight report.
        try { & $node $expectedUpstreamAuthHelper --check 2>&1 | Out-Null } catch { }
        $upstreamVaultAvailable = ($LASTEXITCODE -eq 0)
    }
}
if ($upstreamCredentialPresent) {
    Add-Check 'gloryapi-upstream-credential' $true 'upstream credential present in process environment'
} elseif ($upstreamVaultAvailable) {
    Add-Check 'gloryapi-upstream-credential' $true 'unified key available through local GloryAPI vault (value never printed)'
} else {
    Add-Check 'gloryapi-upstream-credential' $false 'missing environment credential and local GloryAPI vault key (value never printed)'
}
Test-Link 'codex-bridge-link' (Join-Path $CodexHome 'bridge') $expectedBridge
Test-Link 'codex-mode-link' (Join-Path $CodexHome 'codex-mode.ps1') (Join-Path $expectedMode 'codex-mode.ps1')
Test-Link 'switch-chatgpt-link' (Join-Path $CodexHome 'switch-chatgpt.ps1') (Join-Path $expectedMode 'switch-chatgpt.ps1')
Test-Link 'switch-deepseek-link' (Join-Path $CodexHome 'switch-deepseek.ps1') (Join-Path $expectedMode 'switch-deepseek.ps1')

$deepseekConfigPath = Join-Path $CodexHome 'config.deepseek.toml'
$deepseekConfig = if (Test-Path -LiteralPath $deepseekConfigPath) { Get-Content -LiteralPath $deepseekConfigPath -Raw } else { '' }
$providerDeclaration = [regex]::Match($deepseekConfig, '(?m)^\s*model_provider\s*=\s*["'']([^"'']+)["'']\s*$')
$expectedAuthScript = Normalize-Path (Join-Path $expectedMode 'get-codex-auth.ps1')
$modelContract = ($deepseekConfig -match '(?m)^\s*model\s*=\s*["'']auto["'']\s*$')
$deepseekContract = $false
if ($providerDeclaration.Success) {
    $providerName = $providerDeclaration.Groups[1].Value
    $escapedProvider = [regex]::Escape($providerName)
    $providerSection = [regex]::Match($deepseekConfig, "(?ms)^\s*\[model_providers\.$escapedProvider\]\s*\r?\n(?<body>.*?)(?=^\s*\[|\z)")
    $authSection = [regex]::Match($deepseekConfig, "(?ms)^\s*\[model_providers\.$escapedProvider\.auth\]\s*\r?\n(?<body>.*?)(?=^\s*\[|\z)")
    if ($providerSection.Success -and $authSection.Success) {
        $providerBody = $providerSection.Groups['body'].Value
        $authBody = $authSection.Groups['body'].Value
        $authArgs = [regex]::Match($authBody, '(?m)^\s*args\s*=\s*\[[^\r\n\]]*["'']-File["'']\s*,\s*["''](?<path>[^"'']*get-codex-auth\.ps1)["''][^\r\n\]]*\]\s*$')
        $authPath = if ($authArgs.Success) { Normalize-Path ($authArgs.Groups['path'].Value.Replace('\\', '\')) } else { '' }
        $deepseekContract = $modelContract -and
            ($providerBody -match '(?m)^\s*base_url\s*=\s*["'']http://127\.0\.0\.1:4100/v1["'']\s*$') -and
            ($providerBody -match '(?m)^\s*wire_api\s*=\s*["'']responses["'']\s*$') -and
            ($authBody -match '(?m)^\s*command\s*=\s*["'']powershell\.exe["'']\s*$') -and
            $authArgs.Success -and ($authPath -eq $expectedAuthScript)
    }
}
$deepseekContract = $deepseekContract -and ($deepseekConfig -notmatch 'experimental_bearer_token')
Add-Check 'deepseek-profile-contract' $deepseekContract 'responses/4100/local-dpapi-auth/no-bearer contract'

$activeConfigPath = Join-Path $CodexHome 'config.toml'
$activeConfig = if (Test-Path -LiteralPath $activeConfigPath) { Get-Content -LiteralPath $activeConfigPath -Raw } else { '' }
$activeMode = if ($activeConfig -match '(?m)^\s*model_provider\s*=\s*["''](?:freellm|gloryapi[^"'']*)["'']') { 'deepseek' }
    elseif ($activeConfig -match '(?m)^\s*model\s*=') { 'chatgpt' }
    else { 'unknown' }
Add-Check 'active-profile-readable' ($activeMode -ne 'unknown') "mode=$activeMode"

$healthPassed = $false
$healthDetail = 'loopback health identity/model'
if ($SkipHealth) {
    $healthPassed = $true
    $healthDetail = 'skipped-before-bridge-start'
} else {
    try {
        $healthResponse = Invoke-WebRequest -UseBasicParsing -Uri $expectedHealthUrl -TimeoutSec 2
        $health = $healthResponse.Content | ConvertFrom-Json
        $healthPassed = ($health.service -eq 'gloryapi-codex-bridge') -and ($health.catalog.entries -ge 1)
    } catch {
        $healthPassed = $false
    }
}
Add-Check 'bridge-health-identity' $healthPassed $healthDetail

$result = [pscustomobject]@{
    schema = 'glory-codex-activation-preflight-v1'
    project = 'gloryapi'
    codexHome = (Normalize-Path $CodexHome)
    activeMode = $activeMode
    healthChecked = (-not $SkipHealth)
    ready = (($checks | Where-Object status -eq 'fail').Count -eq 0)
    checks = @($checks)
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
} else {
    Write-Output "GloryAPI Codex activation preflight: $(if ($result.ready) { 'READY' } else { 'BLOCKED' })"
    Write-Output "Active mode: $activeMode"
    $checks | ForEach-Object { Write-Output ("[{0}] {1}: {2}" -f $_.status.ToUpperInvariant(), $_.id, $_.detail) }
}

if (-not $result.ready) { exit 1 }
