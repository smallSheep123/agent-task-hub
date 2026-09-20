[CmdletBinding()]
param(
    [ValidateSet('auto','zh-CN','en-US')]
    [string]$Language = 'auto'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\localization.ps1')

function Select-Language {
    while ($true) {
        Clear-Host
        Write-Host '========================================================' -ForegroundColor DarkCyan
        Write-Host '                  Agent Task Hub' -ForegroundColor Cyan
        Write-Host '========================================================' -ForegroundColor DarkCyan
        Write-Host ''
        Write-Host '  1  简体中文'
        Write-Host '  2  English'
        Write-Host ''
        $choice = Read-Host '请选择语言 / Choose a language'
        if ($choice -eq '1') { return 'zh-CN' }
        if ($choice -eq '2') { return 'en-US' }
        Write-Host 'Invalid choice / 输入无效' -ForegroundColor Red
        Start-Sleep -Seconds 1
    }
}

function Save-ConfiguredLanguage([string]$SelectedLanguage) {
    $configPath = Join-Path $env:USERPROFILE '.config\agent-task-hub\config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { return $false }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $config.language = $SelectedLanguage
    $config | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $configPath -Encoding UTF8
    return $true
}

$savedLanguage = Get-SavedAgentHubLanguage
if ($Language -eq 'auto' -and -not $savedLanguage) { $Language = Select-Language }
else { $Language = Resolve-AgentHubLanguage $Language }
Save-AgentHubLanguage $Language
Set-AgentHubLanguage $Language
$Host.UI.RawUI.WindowTitle = 'Agent Task Hub Manager'

function Write-Banner {
    Clear-Host
    Write-Host '========================================================' -ForegroundColor DarkCyan
    Write-Host ('                 ' + (Get-AgentHubText 'ManagerTitle')) -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor DarkCyan
    Write-Host ''
    Write-Host '  1' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuSetup'))
    Write-Host '  2' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuStart'))
    Write-Host '  3' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuStop'))
    Write-Host '  4' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuRestart'))
    Write-Host '  5' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuStatus'))
    Write-Host '  6' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuLogs'))
    Write-Host '  7' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuDoctor'))
    Write-Host '  8' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuPlugin'))
    Write-Host '  9' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuUninstall'))
    Write-Host '  L' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuLanguage'))
    Write-Host '  0' -NoNewline -ForegroundColor Yellow; Write-Host ('  ' + (Get-AgentHubText 'MenuExit'))
    Write-Host ''
    Write-Host '--------------------------------------------------------' -ForegroundColor DarkGray
}

$actions = @{
    '1' = 'setup'; '2' = 'start'; '3' = 'stop'; '4' = 'restart'; '5' = 'status'
    '6' = 'logs'; '7' = 'doctor'; '8' = 'install-plugin'; '9' = 'uninstall'
}

while ($true) {
    Write-Banner
    $choice = Read-Host (Get-AgentHubText 'Choose')
    if ($choice -eq '0') { break }
    if ($choice -match '^(?i)l$') {
        $Language = Select-Language
        Save-AgentHubLanguage $Language
        Set-AgentHubLanguage $Language
        if (Save-ConfiguredLanguage $Language) {
            $task = Get-ScheduledTask -TaskName 'Agent Task Hub' -ErrorAction SilentlyContinue
            if ($task) { & (Join-Path $PSScriptRoot 'bridge.ps1') -Action restart -Language $Language }
        }
        continue
    }
    if (-not $actions.ContainsKey($choice)) {
        Write-Host ''
        Write-Host (Get-AgentHubText 'InvalidMenu') -ForegroundColor Red
        Start-Sleep -Seconds 1
        continue
    }
    Write-Host ''
    try {
        & (Join-Path $PSScriptRoot 'bridge.ps1') -Action $actions[$choice] -Language $Language
        Write-Host ''
        Write-Host (Get-AgentHubText 'Done') -ForegroundColor Green
    } catch {
        Write-Host ''
        Write-Host (Get-AgentHubText 'Failed' @($_.Exception.Message)) -ForegroundColor Red
    }
    Write-Host ''
    [void](Read-Host (Get-AgentHubText 'Return'))
}
