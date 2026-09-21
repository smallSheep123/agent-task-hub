[CmdletBinding()]
param(
    [ValidateSet('install','start','stop','restart','status','logs','doctor','uninstall')]
    [string]$Action = 'status',
    [ValidateSet('auto','zh-CN','en-US')]
    [string]$Language = 'auto'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'localization.ps1')
$Language = Resolve-AgentHubLanguage $Language
Set-AgentHubLanguage $Language
$TaskName = 'Agent Task Hub'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Controller = Join-Path $Root 'app\controller.mjs'
$Runner = Join-Path $Root 'app\run-controller.ps1'
$DataRoot = "$env:USERPROFILE\.config\agent-task-hub"
$ConfigPath = Join-Path $DataRoot 'config.json'

function Get-BridgeTask { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
function Get-BridgeControllerProcess {
    $controllerPath = [IO.Path]::GetFullPath($Controller)
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($controllerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
}
function Stop-BridgeTask {
    $lockPath = Join-Path $DataRoot 'controller.lock'
    $lockedPid = 0
    if (Test-Path -LiteralPath $lockPath) {
        $rawPid = Get-Content -LiteralPath $lockPath -Raw -ErrorAction SilentlyContinue
        [void][int]::TryParse(([string]$rawPid).Trim(), [ref]$lockedPid)
    }
    if (Get-BridgeTask) { Stop-ScheduledTask $TaskName -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    # Task Scheduler can stop the PowerShell launcher while leaving node.exe alive.
    # Only terminate node processes whose command line contains this installation's exact controller path.
    $targets = @(Get-BridgeControllerProcess)
    if ($lockedPid -gt 0 -and -not ($targets.ProcessId -contains $lockedPid)) {
        $locked = Get-CimInstance Win32_Process -Filter "ProcessId = $lockedPid" -ErrorAction SilentlyContinue
        if ($locked.Name -eq 'node.exe' -and $locked.CommandLine -and $locked.CommandLine.IndexOf([IO.Path]::GetFullPath($Controller), [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $targets += $locked
        }
    }
    foreach ($process in @($targets | Sort-Object ProcessId -Unique)) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 20 -and @(Get-BridgeControllerProcess).Count -gt 0; $i++) { Start-Sleep -Milliseconds 100 }
    if (@(Get-BridgeControllerProcess).Count -eq 0) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
}
function Show-Status {
    $task = Get-BridgeTask
    if (-not $task) {
        $telegramState = if(Test-Path $ConfigPath){Get-AgentHubText 'Configured'}else{Get-AgentHubText 'NotConfigured'}
        Write-Host (Get-AgentHubText 'ServiceNotInstalled' @($telegramState))
        return
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $telegramState = if(Test-Path $ConfigPath){Get-AgentHubText 'Configured'}else{Get-AgentHubText 'NotConfigured'}
    Write-Host (Get-AgentHubText 'ServiceStatus' @($task.State, $telegramState, $info.LastTaskResult, $info.LastRunTime))
}

switch ($Action) {
    'install' {
        if (-not (Test-Path -LiteralPath $ConfigPath)) { throw (Get-AgentHubText 'TelegramNotInitialized') }
        if (Get-BridgeTask) { Stop-BridgeTask }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
        $runnerArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`" -Mode run -ControllerPath `"$Controller`" -NodePath `"$node`""
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $runnerArgs -WorkingDirectory $Root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local multilingual task hub for OpenCode, Codex, ZCode, and Telegram' -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 2
        Show-Status
    }
    'start' { if(-not (Get-BridgeTask)){throw (Get-AgentHubText 'ServiceMissing')}; Start-ScheduledTask $TaskName; Start-Sleep 1; Show-Status }
    'stop' { Stop-BridgeTask; Show-Status }
    'restart' { if(-not (Get-BridgeTask)){throw (Get-AgentHubText 'ServiceMissing')}; Stop-BridgeTask; Start-ScheduledTask $TaskName; Start-Sleep 2; Show-Status }
    'status' { Show-Status }
    'logs' {
        $latest = Get-ChildItem -LiteralPath (Join-Path $DataRoot 'logs') -Filter 'bridge-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if($latest){Get-Content -LiteralPath $latest.FullName -Tail 120}else{Write-Host (Get-AgentHubText 'NoLogs')}
    }
    'doctor' {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        & $Runner -Mode self-test -ControllerPath $Controller -NodePath $node
        if(Test-Path $ConfigPath){& $Runner -Mode check -ControllerPath $Controller -NodePath $node}else{Write-Host (Get-AgentHubText 'DoctorWaiting')}
        $plugin = "$env:USERPROFILE\.config\opencode\plugins\agent-task-hub.js"
        Write-Host "PLUGIN=$(if(Test-Path $plugin){'OK'}else{'MISSING'})"
        Show-Status
    }
    'uninstall' {
        if(Get-BridgeTask){Stop-BridgeTask; Unregister-ScheduledTask $TaskName -Confirm:$false}
        Write-Host (Get-AgentHubText 'Uninstalled')
    }
}
