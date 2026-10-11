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
while ($true) {
    # A surviving child may own the listener after Task Scheduler stopped its launcher.
    $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($occupied) {
        Add-Content -LiteralPath $hostLog -Value "$([DateTime]::UtcNow.ToString('o')) Port $Port already has a listener; preserving it."
        exit 0
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
