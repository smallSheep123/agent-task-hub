[CmdletBinding()]
param(
    [ValidateSet('probe','enable-shared','disable-shared')]
    [string]$Action = 'probe',
    [string]$DataRoot = "$env:USERPROFILE\.config\agent-task-hub",
    [int]$Port = 9234
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ConfigPath = Join-Path $DataRoot 'config.json'
$Probe = Join-Path $PSScriptRoot 'codex-shared-probe.mjs'
$TaskName = 'Agent Task Hub Codex App Server'
$WsUrl = "ws://127.0.0.1:$Port"

function Find-CodexExecutable {
    $standalone = Join-Path $env:USERPROFILE '.codex\packages\standalone\current\bin\codex.exe'
    if (Test-Path -LiteralPath $standalone) { return $standalone }
    $desktopRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopRoot) {
        $candidate = Get-ChildItem -LiteralPath $desktopRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending |
            Select-Object -First 1
        if ($candidate) { return [string]$candidate }
    }
    $command = Get-Command codex.exe,codex.cmd,codex.ps1,codex -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return [string]$command.Source }
    throw 'Codex executable was not found.'
}

function Set-JsonProperty([object]$Object, [string]$Name, [object]$Value) {
    if ($Object.PSObject.Properties.Name -contains $Name) { $Object.$Name = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Set-CodexTransport([string]$Transport, [string]$Url = '') {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Agent Task Hub is not configured: $ConfigPath" }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    Set-JsonProperty $config 'codexTransport' $Transport
    Set-JsonProperty $config 'codexWsUrl' $Url
    Set-JsonProperty $config 'version' ([Math]::Max(4, [int]$config.version))
    $temporary = "$ConfigPath.tmp"
    $config | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
}

function Test-SharedReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Start-SharedHost([string]$Codex) {
    if (Test-SharedReady) { return }
    $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($occupied) { throw "Port $Port is already in use by process $($occupied[0].OwningProcess)." }
    $action = New-ScheduledTaskAction -Execute $Codex -Argument "app-server --listen $WsUrl" -WorkingDirectory $env:USERPROFILE
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Shared loopback Codex app-server for Codex Desktop and Agent Task Hub' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    for ($i = 0; $i -lt 30 -and -not (Test-SharedReady); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-SharedReady)) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        throw "Shared Codex app-server did not become ready. LastTaskResult=$($info.LastTaskResult)"
    }
}

function Stop-SharedHost {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

function Invoke-SharedProbe([string]$Codex) {
    $savedCommand = $env:AGENT_TASK_HUB_CODEX_COMMAND
    $savedUrl = $env:AGENT_TASK_HUB_CODEX_WS_URL
    try {
        $env:AGENT_TASK_HUB_CODEX_COMMAND = $Codex
        $env:AGENT_TASK_HUB_CODEX_WS_URL = $WsUrl
        & node $Probe
        if ($LASTEXITCODE -ne 0) { throw 'Shared Codex app-server probe failed.' }
    } finally {
        $env:AGENT_TASK_HUB_CODEX_COMMAND = $savedCommand
        $env:AGENT_TASK_HUB_CODEX_WS_URL = $savedUrl
    }
}

$codex = Find-CodexExecutable
Write-Host "CODEX=$codex"
& $codex --version
if ($LASTEXITCODE -ne 0) { throw 'Could not execute Codex.' }

switch ($Action) {
    'probe' {
        Invoke-SharedProbe $codex
    }
    'enable-shared' {
        Start-SharedHost $codex
        Invoke-SharedProbe $codex
        Set-CodexTransport 'shared' $WsUrl
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $WsUrl, 'User')
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_USE_LOCAL_DAEMON', $null, 'User')
        Write-Host "CODEX_TRANSPORT=shared URL=$WsUrl"
        Write-Host 'Restart Agent Task Hub, then fully restart Codex Desktop to test shared ownership.'
    }
    'disable-shared' {
        Set-CodexTransport 'private' ''
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $null, 'User')
        [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_USE_LOCAL_DAEMON', $null, 'User')
        Stop-SharedHost
        Write-Host 'CODEX_TRANSPORT=private'
        Write-Host 'Restart Agent Task Hub and Codex Desktop to complete the rollback.'
    }
}
