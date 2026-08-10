# GloryAPI tray prototype. It only talks to the isolated local Control API.
# It never edits Codex config, starts the bridge, or changes FreeLLMAPI.
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:3101',
    [string]$DashboardUrl = 'http://127.0.0.1:5173',
    [int]$PollSeconds = 5
)

$ErrorActionPreference = 'Stop'

Import-Module -Name (Join-Path $PSScriptRoot 'GloryApiTray.Core.psm1') -Force

$BaseUrl = Assert-LocalHttpUrl $BaseUrl 'BaseUrl'
$DashboardUrl = Assert-LocalHttpUrl $DashboardUrl 'DashboardUrl'
$adminToken = $env:GLORYAPI_ADMIN_AUTH_TOKEN
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $true
$notify.Text = 'GloryAPI'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('GloryAPI: comprobando…')
$statusItem.Enabled = $false
$menu.Items.Add('-') | Out-Null
$controlItem = $menu.Items.Add('Mostrar control')
$openItem = $menu.Items.Add('Abrir dashboard')
$openItem.Add_Click({ Start-Process $DashboardUrl })
$refreshItem = $menu.Items.Add('Actualizar')
$exitItem = $menu.Items.Add('Salir')
$exitItem.Add_Click({ $script:closeRequested = $true })
$notify.ContextMenuStrip = $menu

function Get-Json([string]$Path) {
    try { return Send-GloryJson -BaseUrl $BaseUrl -Path $Path -AdminToken $adminToken } catch { return $null }
}

$script:latestSnapshot = $null
$script:modelRows = @()
$script:controlForm = $null
$script:modelList = $null
$script:controlStatus = $null

function Set-ControlStatus([string]$Message, [bool]$Error = $false) {
    if ($script:controlStatus) {
        $script:controlStatus.Text = $Message
        $script:controlStatus.ForeColor = if ($Error) { [System.Drawing.Color]::Firebrick } else { [System.Drawing.Color]::DimGray }
    }
}

function Update-ControlView {
    $snapshot = Get-Json '/api/control/status'
    if (-not $snapshot) {
        Set-ControlStatus 'GloryAPI detenido o no disponible' $true
        return
    }
    $script:latestSnapshot = $snapshot
    $script:modelRows = @($snapshot.models | Sort-Object priority)
    if ($script:modelList) {
        $script:modelList.Items.Clear()
        foreach ($model in $script:modelRows) {
            $state = if ($model.enabled) { 'activo' } else { 'inactivo' }
            [void]$script:modelList.Items.Add("$($model.priority). $($model.displayName) [$state]")
        }
    }
    $last = if ($snapshot.runtime.lastCompleted) { "$($snapshot.runtime.lastCompleted.platform)/$($snapshot.runtime.lastCompleted.modelId)" } else { 'sin solicitudes' }
    Set-ControlStatus "Actual: $last · revisado $(Get-Date -Format 'HH:mm:ss')"
}

function Save-ControlOrder {
    if (-not $script:latestSnapshot -or $script:modelRows.Count -eq 0) { return }
    $result = Save-GloryControlOrder -BaseUrl $BaseUrl -AdminToken $adminToken -LatestSnapshot $script:latestSnapshot -ModelRows $script:modelRows
    if ($result.Succeeded) {
        $script:latestSnapshot.routing = $result.Snapshot
        Update-ControlView
    } else {
        if ($result.Snapshot) { $script:latestSnapshot = $result.Snapshot }
        Set-ControlStatus 'No se pudo guardar el orden; se conserva el estado local anterior' $true
        Update-ControlView
    }
}

function Toggle-SelectedModel {
    $index = $script:modelList.SelectedIndex
    if ($index -lt 0) { return }
    $script:modelRows[$index].enabled = -not [bool]$script:modelRows[$index].enabled
    Save-ControlOrder
}

function Move-SelectedModel([int]$Delta) {
    $index = $script:modelList.SelectedIndex
    $target = $index + $Delta
    if ($index -lt 0 -or $target -lt 0 -or $target -ge $script:modelRows.Count) { return }
    $item = $script:modelRows[$index]
    $script:modelRows[$index] = $script:modelRows[$target]
    $script:modelRows[$target] = $item
    Save-ControlOrder
    $script:modelList.SelectedIndex = $target
}

function Show-ControlWindow {
    if ($script:controlForm -and -not $script:controlForm.IsDisposed) {
        $script:controlForm.Activate()
        Update-ControlView
        return
    }
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'GloryAPI — control local'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object System.Drawing.Size(520, 360)
    $form.MinimumSize = New-Object System.Drawing.Size(460, 320)
    $form.FormBorderStyle = 'Sizable'

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Modelo actual y orden de fallback'
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point(16, 14)
    $form.Controls.Add($title)

    $list = New-Object System.Windows.Forms.ListBox
    $list.Location = New-Object System.Drawing.Point(16, 44)
    $list.Size = New-Object System.Drawing.Size(470, 190)
    $list.Anchor = 'Top,Bottom,Left,Right'
    $form.Controls.Add($list)
    $script:modelList = $list

    $toggle = New-Object System.Windows.Forms.Button
    $toggle.Text = 'Activar/desactivar'
    $toggle.Location = New-Object System.Drawing.Point(16, 246)
    $toggle.Add_Click({ Toggle-SelectedModel })
    $form.Controls.Add($toggle)

    $up = New-Object System.Windows.Forms.Button
    $up.Text = 'Subir'
    $up.Location = New-Object System.Drawing.Point(150, 246)
    $up.Add_Click({ Move-SelectedModel -Delta -1 })
    $form.Controls.Add($up)

    $down = New-Object System.Windows.Forms.Button
    $down.Text = 'Bajar'
    $down.Location = New-Object System.Drawing.Point(226, 246)
    $down.Add_Click({ Move-SelectedModel -Delta 1 })
    $form.Controls.Add($down)

    $refresh = New-Object System.Windows.Forms.Button
    $refresh.Text = 'Actualizar'
    $refresh.Location = New-Object System.Drawing.Point(302, 246)
    $refresh.Add_Click({ Update-ControlView })
    $form.Controls.Add($refresh)

    $dashboard = New-Object System.Windows.Forms.Button
    $dashboard.Text = 'Abrir dashboard'
    $dashboard.Location = New-Object System.Drawing.Point(388, 246)
    $dashboard.Add_Click({ Start-Process $DashboardUrl })
    $form.Controls.Add($dashboard)

    $status = New-Object System.Windows.Forms.Label
    $status.AutoSize = $true
    $status.Location = New-Object System.Drawing.Point(16, 292)
    $status.Anchor = 'Bottom,Left,Right'
    $form.Controls.Add($status)
    $script:controlStatus = $status
    $script:controlForm = $form
    $form.Add_FormClosed({ $script:controlForm = $null; $script:modelList = $null; $script:controlStatus = $null })
    Update-ControlView
    $form.Show()
}

$controlItem.Add_Click({ Show-ControlWindow })
$notify.Add_DoubleClick({ Show-ControlWindow })

function Update-Status {
    $snapshot = Get-Json '/api/control/status'
    if (-not $snapshot) {
        $statusItem.Text = 'GloryAPI: detenido o no disponible'
        $notify.Text = 'GloryAPI: no disponible'
        return
    }
    $runtime = $snapshot.runtime
    $current = if ($runtime.lastCompleted) { "$($runtime.lastCompleted.platform)/$($runtime.lastCompleted.modelId)" } else { 'sin solicitudes' }
    $statusItem.Text = "Actual: $current"
    $notify.Text = ("GloryAPI: {0}" -f $current).Substring(0, [Math]::Min(63, ("GloryAPI: {0}" -f $current).Length))
}

$script:closeRequested = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(2, $PollSeconds) * 1000
$timer.Add_Tick({ Update-Status })
$timer.Start()
Update-Status

try {
    while (-not $script:closeRequested) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100
    }
} finally {
    $timer.Stop()
    $timer.Dispose()
    $notify.Visible = $false
    $notify.Dispose()
    $menu.Dispose()
}
