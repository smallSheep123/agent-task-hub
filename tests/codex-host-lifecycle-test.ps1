$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\scripts\codex-transport.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$null)
# Load function definitions only. Never run the script's environment/task mutations.
$ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) |
    ForEach-Object { Invoke-Expression $_.Extent.Text }
$Port = 39234
$WsUrl = "ws://127.0.0.1:$Port"
$TaskName = 'Test host'
$WatchTaskName = 'Test watchdog'
$HostRunner = 'test.ps1'
$Root = $PSScriptRoot
$script:killed = @()
$script:registered = 0
$script:started = 0
$script:ready = $true
$script:occupied = $false
$script:tasks = $false
$script:processes = @()
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($script:tasks) { [pscustomobject]@{ State = 'Running' } } }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) }
function Unregister-ScheduledTask { param($TaskName, $Confirm) }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) $script:processes }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:killed += $Id }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) if ($script:occupied) { [pscustomobject]@{ OwningProcess = 999 } } }
function Start-Sleep { param($Milliseconds) }
function Test-SharedReady { $script:ready }
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) @{} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) @{} }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) @{} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable, $RestartCount, $RestartInterval, $ExecutionTimeLimit) @{} }
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force) $script:registered++ }
function Start-ScheduledTask { param($TaskName) $script:started++ }

# A healthy shared host must survive repair while its launch definition is updated.
Start-SharedHost 'unused.exe'
Assert ($script:registered -eq 1 -and $script:started -eq 0) 'Repair restarted a healthy host.'
$script:ready = $false
$script:occupied = $true
$rejected = $false
try { Start-SharedHost 'unused.exe' } catch { $rejected = $_.Exception.Message -like '*already in use*' }
Assert $rejected 'An unrelated listener must block host startup.'
Assert ($script:registered -eq 1) 'Occupied-port rejection mutated the scheduled task.'

# Task Scheduler can lose its launcher while its child survives. Cleanup must work
# even if the task entry is gone, and must exclude other ports and client commands.
$script:occupied = $false
$script:processes = @(
    [pscustomobject]@{ ProcessId = 1; CommandLine = 'codex.exe app-server --listen ws://127.0.0.1:39234' },
    [pscustomobject]@{ ProcessId = 2; CommandLine = '"C:\Program Files\Codex\codex.exe" app-server --listen "ws://127.0.0.1:39234"' },
    [pscustomobject]@{ ProcessId = 3; CommandLine = 'codex.exe app-server --listen ws://127.0.0.1:392340' },
    [pscustomobject]@{ ProcessId = 4; CommandLine = 'codex.exe app-server --listen ws://127.0.0.1:9234' },
    [pscustomobject]@{ ProcessId = 5; CommandLine = 'codex.exe exec --message "app-server --listen ws://127.0.0.1:39234"' }
)
Stop-SharedHost
Assert (($script:killed -join ',') -eq '1,2') 'Cleanup killed unrelated processes or left the managed orphan.'
$script:occupied = $true
$rejected = $false
try { Stop-SharedHost } catch { $rejected = $_.Exception.Message -like '*not the managed Codex host*' }
Assert $rejected 'Cleanup must report an unrelated remaining listener.'
Write-Host 'CODEX_HOST_LIFECYCLE_TEST=PASS'
