Set-StrictMode -Version Latest

function Assert-LocalHttpUrl {
    param([string]$Value, [string]$Name)
    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) {
        throw "$Name must be loopback HTTP without credentials"
    }
    $normalizedHost = $parsed.DnsSafeHost.Trim('[', ']')
    $ip = $null
    $isLoopbackLiteral = [System.Net.IPAddress]::TryParse($normalizedHost, [ref]$ip) -and
        ($normalizedHost -eq '127.0.0.1' -or $ip.Equals([System.Net.IPAddress]::IPv6Loopback))
    if ($parsed.Scheme -ne 'http' -or $parsed.UserInfo -or -not $isLoopbackLiteral) {
        throw "$Name must be loopback HTTP without credentials"
    }
    return $parsed.AbsoluteUri.TrimEnd('/')
}

function Send-GloryJson {
    param(
        [string]$BaseUrl,
        [string]$Path,
        [string]$Method = 'GET',
        [object]$Body = $null,
        [string]$AdminToken = ''
    )
    $headers = @{}
    if ($AdminToken) { $headers.Authorization = "Bearer $AdminToken" }
    $parameters = @{
        Uri = "$BaseUrl$Path"
        Method = $Method
        Headers = $headers
        TimeoutSec = 2
    }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 8
    }
    return Invoke-RestMethod @parameters
}

function New-GloryRoutingPayload {
    param([int]$ExpectedRevision, [object[]]$ModelRows)
    $entries = @()
    for ($index = 0; $index -lt $ModelRows.Count; $index++) {
        $model = $ModelRows[$index]
        $entries += [ordered]@{
            modelDbId = [int]$model.modelDbId
            priority = $index + 1
            enabled = [bool]$model.enabled
        }
    }
    return [ordered]@{ expectedRevision = $ExpectedRevision; entries = $entries }
}

function Save-GloryControlOrder {
    param(
        [string]$BaseUrl,
        [string]$AdminToken,
        [object]$LatestSnapshot,
        [object[]]$ModelRows
    )
    if ($null -eq $LatestSnapshot -or $ModelRows.Count -eq 0) {
        return [pscustomobject]@{ Succeeded = $false; Snapshot = $null; Error = $null }
    }
    $payload = New-GloryRoutingPayload -ExpectedRevision ([int]$LatestSnapshot.routing.revision) -ModelRows $ModelRows
    try {
        $updated = Send-GloryJson -BaseUrl $BaseUrl -Path '/api/fallback' -Method 'PUT' -Body $payload -AdminToken $AdminToken
        return [pscustomobject]@{ Succeeded = $true; Snapshot = $updated; Error = $null }
    } catch {
        $refreshed = $null
        try { $refreshed = Send-GloryJson -BaseUrl $BaseUrl -Path '/api/control/status' -AdminToken $AdminToken } catch { }
        return [pscustomobject]@{ Succeeded = $false; Snapshot = $refreshed; Error = $_.Exception }
    }
}

Export-ModuleMember -Function Assert-LocalHttpUrl, Send-GloryJson, New-GloryRoutingPayload, Save-GloryControlOrder
