[CmdletBinding()]
param([int]$Port = 9234, [switch]$Once)

$ErrorActionPreference = 'Stop'
$taskName = 'Agent Task Hub Codex App Server'
$logDir = Join-Path $env:USERPROFILE '.config\agent-task-hub\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$mutex = [Threading.Mutex]::new($false, "Local\AgentTaskHubCodexWatchdog-$Port")
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    do {
        # Desktop keeps this endpoint after the Hub stops; maintain its independent service.
        $enabled = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User') -eq "ws://127.0.0.1:$Port"
        $manuallyPaused = Test-Path -LiteralPath 'D:\AIGC\background-app-manager\runtime\codex-host.paused'
        if ($enabled -and -not $manuallyPaused) {
            $client = [Net.Sockets.TcpClient]::new()
            $listening = $false
            try {
                $connect = $client.ConnectAsync('127.0.0.1', $Port)
                $listening = $connect.Wait(1000) -and $client.Connected
            } catch {} finally { $client.Dispose() }
            if (-not $listening) {
                # A listen entry whose owner process is gone is a leaked-handle ghost:
                # every connection is refused until the pinning process tree is recycled.
                $ghostIds = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty OwningProcess -Unique |
                    Where-Object { -not (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
                if ($ghostIds.Count -gt 0) {
                    Add-Content -LiteralPath (Join-Path $logDir 'codex-shared-watchdog.log') -Value "$([DateTime]::UtcNow.ToString('o')) Ghost listener on port $Port owned by dead PID=$($ghostIds -join ','); recycling the host task tree."
                    $hostTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                    if ($hostTask) { Stop-ScheduledTask -InputObject $hostTask -ErrorAction SilentlyContinue }
                    for ($i = 0; $i -lt 8; $i++) {
                        Start-Sleep -Seconds 1
                        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
                    }
                    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
                        Add-Content -LiteralPath (Join-Path $logDir 'codex-shared-watchdog.log') -Value "$([DateTime]::UtcNow.ToString('o')) Port $Port still pinned after the host task stopped; recycling the watchdog tree as well."
                        # Kill the BackgroundAppManager supervisor explicitly so this exit
                        # cannot hang with the task stuck in Running; Task Scheduler's
                        # restart count then brings a clean watchdog back within a minute.
                        $parentId = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" | Select-Object -ExpandProperty ParentProcessId
                        if (Get-Process -Id $parentId -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'BackgroundAppManager') {
                            Stop-Process -Id $parentId -Force -ErrorAction SilentlyContinue
                        }
                        exit 3
                    }
                }
                try {
                    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
                    $autoStartAllowed = $task.State -ne 'Disabled' -and @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled -ne $false }).Count -gt 0
                    if ($task.State -ne 'Running' -and $autoStartAllowed) {
                        Start-ScheduledTask -TaskName $taskName
                        Add-Content -LiteralPath (Join-Path $logDir 'codex-shared-watchdog.log') -Value "$([DateTime]::UtcNow.ToString('o')) Restarted shared host task on port $Port"
                    }
                } catch {
                    Add-Content -LiteralPath (Join-Path $logDir 'codex-shared-watchdog.log') -Value "$([DateTime]::UtcNow.ToString('o')) Host recovery failed: $($_.Exception.Message)"
                }
            }
        }
        if (-not $Once) { Start-Sleep -Seconds 3 }
    } while (-not $Once)
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
