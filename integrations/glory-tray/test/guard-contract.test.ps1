$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSScriptRoot '..\GloryApiTray.Core.psm1') -Force

$safe = Assert-LocalHttpUrl 'http://127.0.0.1:3101' 'BaseUrl'
if ($safe -ne 'http://127.0.0.1:3101') { throw "Unexpected safe URL: $safe" }
$ipv6 = Assert-LocalHttpUrl 'http://[::1]:3101' 'BaseUrl'
if (-not $ipv6.StartsWith('http://[')) { throw "Unexpected IPv6 URL: $ipv6" }

$rejected = $false
try { [void](Assert-LocalHttpUrl 'http://localhost:3101' 'BaseUrl') } catch { $rejected = $true }
if (-not $rejected) { throw 'localhost must be rejected' }

Write-Output 'Assert-LocalHttpUrl functional contract PASS'
