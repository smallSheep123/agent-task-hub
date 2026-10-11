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
        if ($enabled) {
            $client = [Net.Sockets.TcpClient]::new()
            $listening = $false
            try {
                $connect = $client.ConnectAsync('127.0.0.1', $Port)
                $listening = $connect.Wait(1000) -and $client.Connected
            } catch {} finally { $client.Dispose() }
            if (-not $listening) {
                try {
                    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
                    if ($task.State -ne 'Running') {
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
