[CmdletBinding()]
param([int]$Port = 9234)

$ErrorActionPreference = 'Stop'
$desktopRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$codex = $null
if (Test-Path -LiteralPath $desktopRoot) {
    $codex = Get-ChildItem -LiteralPath $desktopRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending |
        Select-Object -First 1
}
if (-not $codex) {
    $standalone = Join-Path $env:USERPROFILE '.codex\packages\standalone\current\bin\codex.exe'
    if (Test-Path -LiteralPath $standalone) { $codex = $standalone }
}
if (-not $codex) { throw 'Codex executable was not found.' }

$logDir = Join-Path $env:USERPROFILE '.config\agent-task-hub\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$hostLog = Join-Path $logDir 'codex-shared-host.log'
$script:warnedUnrelated = $false
while ($true) {
    # A surviving child may own the listener after Task Scheduler stopped its launcher.
    $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($occupied) {
        $listenerIds = @($occupied | Select-Object -ExpandProperty OwningProcess -Unique)
        $liveIds = @($listenerIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        $ghostIds = @($listenerIds | Where-Object { $liveIds -notcontains $_ })
        if ($ghostIds.Count -gt 0) {
            # Owner process is gone but the bind survives on a leaked handle inside a
            # surviving launcher process. Exit (never throw): the watchdog detects the
            # ghost, recycles the pinning task tree to release the handle, and starts
            # this launcher again with the port free.
            Add-Content -LiteralPath $hostLog -Value "$([DateTime]::UtcNow.ToString('o')) Port $Port pinned by dead PID=$($ghostIds -join ','); exiting for a launcher-tree recycle."
            exit 2
        }
        $preserveIds = @()
        foreach ($listenerId in $liveIds) {
            $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId"
            $expectedEndpoint = [regex]::Escape("ws://127.0.0.1:$Port")
            if ($listenerProcess.Name -eq 'codex.exe' -and $listenerProcess.CommandLine -match ("app-server\s+--listen\s+`"?" + $expectedEndpoint + '(?:\s|"|$)')) {
                $preserveIds += $listenerId
            } elseif (-not $script:warnedUnrelated) {
                $script:warnedUnrelated = $true
                Add-Content -LiteralPath $hostLog -Value "$([DateTime]::UtcNow.ToString('o')) Port $Port belongs to an unrelated live process PID=$listenerId; preserving it and retrying."
            }
        }
        if ($preserveIds.Count -gt 0) {
            Add-Content -LiteralPath $hostLog -Value "$([DateTime]::UtcNow.ToString('o')) Preserving existing Codex listener PID=$($preserveIds -join ','); monitoring from D-drive launcher."
            # Take over supervision without closing the backend used by Desktop.
            do {
                Start-Sleep -Seconds 3
                $stillListening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $preserveIds })
            } while ($stillListening.Count -gt 0)
        } else {
            # Unrelated live owner: keep the supervisor alive and re-check later instead
            # of dying, so the port is claimed as soon as that process releases it.
            Start-Sleep -Seconds 30
        }
        continue
    }
    $child = $null
    $started = [DateTime]::UtcNow
    try {
        $child = Start-Process -FilePath $codex -ArgumentList @('app-server','--listen',"ws://127.0.0.1:$Port") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'codex-shared-stdout.log') -RedirectStandardError (Join-Path $logDir 'codex-shared-stderr.log')
        Add-Content -LiteralPath $hostLog -Value "$($started.ToString('o')) Started PID=$($child.Id) Port=$Port"
        $child.WaitForExit()
        Add-Content -LiteralPath $hostLog -Value "$([DateTime]::UtcNow.ToString('o')) Host exited; restarting."
    } catch {
        Add-Content -LiteralPath $hostLog -Value "$([DateTime]::UtcNow.ToString('o')) Host launch failed: $($_.Exception.Message)"
    } finally {
        if ($child -and -not $child.HasExited) { $child.Kill() }
        if ($child) { $child.Dispose() }
    }
    # Bound rapid restart loops without exhausting Task Scheduler's retry count.
    if (([DateTime]::UtcNow - $started).TotalSeconds -lt 10) { Start-Sleep -Seconds 3 }
    else { Start-Sleep -Milliseconds 300 }
}
