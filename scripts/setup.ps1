[CmdletBinding()]
param(
    [string]$DataRoot = "$env:USERPROFILE\.config\agent-task-hub",
    [ValidateSet('auto','zh-CN','en-US')]
    [string]$Language = 'auto'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'localization.ps1')
$Language = Resolve-AgentHubLanguage $Language
Set-AgentHubLanguage $Language
Save-AgentHubLanguage $Language
$ConfigPath = Join-Path $DataRoot 'config.json'
$StatePath = Join-Path $DataRoot 'state.json'

function Read-SecretText([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Telegram([string]$Token, [string]$Method, [hashtable]$Body = @{}) {
    try {
        # Windows PowerShell 5 may encode a JSON string with the active ANSI code page.
        # Supplying explicit UTF-8 bytes prevents Chinese text from becoming question marks.
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $utf8Body = [Text.Encoding]::UTF8.GetBytes($json)
        $result = Invoke-RestMethod -Uri "https://api.telegram.org/bot$Token/$Method" -Method Post -ContentType 'application/json; charset=utf-8' -Body $utf8Body -TimeoutSec 40
        if (-not $result.ok) { throw 'Telegram returned ok=false' }
        return $result.result
    } catch {
        throw (Get-AgentHubText 'TelegramCallFailed' @($Method))
    }
}

function Lock-DataRoot([string]$Path) {
    $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $directories = @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Recurse -Directory -Force)
    foreach ($directory in $directories) {
        & icacls.exe $directory.FullName /inheritance:r /grant:r "${account}:(OI)(CI)F" 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw (Get-AgentHubText 'SecureDirectoryFailed' @($directory.FullName)) }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)) {
        & icacls.exe $file.FullName /inheritance:r /grant:r "${account}:F" 'NT AUTHORITY\SYSTEM:F' 'BUILTIN\Administrators:F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw (Get-AgentHubText 'SecureFileFailed' @($file.FullName)) }
    }
}

Write-Host ''
Write-Host (Get-AgentHubText 'SetupTitle') -ForegroundColor Cyan
Write-Host (Get-AgentHubText 'SetupIntro')
Write-Host ''

$token = Read-SecretText (Get-AgentHubText 'PasteToken')
if ($token -notmatch '^\d{8,12}:[A-Za-z0-9_-]{20,}$') { throw (Get-AgentHubText 'BadToken') }
$me = Invoke-Telegram $token 'getMe'
Write-Host (Get-AgentHubText 'BotVerified' @($me.username)) -ForegroundColor Green

$webhook = Invoke-Telegram $token 'getWebhookInfo'
if ($webhook.url) {
    Write-Host (Get-AgentHubText 'WebhookFound' @($webhook.url)) -ForegroundColor Yellow
    $remove = Read-Host (Get-AgentHubText 'RemoveWebhook')
    if ($remove -notmatch '^(?i)y(es)?$') { throw (Get-AgentHubText 'CancelledWebhook') }
    [void](Invoke-Telegram $token 'deleteWebhook' @{ drop_pending_updates = $false })
}

Write-Host ''
Write-Host (Get-AgentHubText 'SendStart' @($me.username)) -ForegroundColor Yellow
[void](Read-Host)
$updates = @(Invoke-Telegram $token 'getUpdates' @{ timeout = 2; allowed_updates = @('message') })
$private = @($updates | Where-Object { $_.message -and $_.message.chat.type -eq 'private' } | Sort-Object update_id -Descending)
if ($private.Count -eq 0) { throw (Get-AgentHubText 'NoPrivateMessage') }

$selected = $private[0]
$from = $selected.message.from
$chat = $selected.message.chat
$display = if ($from.username) { "@$($from.username)" } else { (@($from.first_name, $from.last_name) | Where-Object { $_ }) -join ' ' }
Write-Host (Get-AgentHubText 'BindUser' @($display, $from.id, $chat.id))
$yes = Read-Host (Get-AgentHubText 'ConfirmY')
if ($yes -notmatch '^(?i)y(es)?$') { throw (Get-AgentHubText 'CancelledConfig') }

New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
foreach ($name in @('instances','events','logs')) { New-Item -ItemType Directory -Path (Join-Path $DataRoot $name) -Force | Out-Null }
$protectedToken = ConvertFrom-SecureString (ConvertTo-SecureString $token -AsPlainText -Force)
$config = [ordered]@{
    version = 2
    product = 'agent-task-hub'
    language = $Language
    botUsername = [string]$me.username
    botTokenProtected = $protectedToken
    allowedUserId = [string]$from.id
    allowedChatId = [string]$chat.id
    maxSessions = 10
    sessionPageSize = 6
    queueLimit = 20
    configuredAt = (Get-Date).ToString('o')
}
$maxUpdate = ($updates | Measure-Object -Property update_id -Maximum).Maximum
$state = [ordered]@{
    updateOffset = if ($null -eq $maxUpdate) { 0 } else { [long]$maxUpdate + 1 }
    selected = $null
    sessionMap = @()
}
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StatePath -Encoding UTF8
Lock-DataRoot $DataRoot

$commands = if ($Language -eq 'zh-CN') { @(
    @{ command='sessions'; description='列出最近的 OpenCode 会话' }; @{ command='find'; description='按标题或项目目录搜索会话' }; @{ command='current'; description='查看当前选择的会话' }; @{ command='show'; description='查看当前会话进展' }; @{ command='send'; description='向当前会话继续发送指令' }; @{ command='add'; description='向当前会话队列追加一条指令' }; @{ command='batch'; description='按 --- 分隔并依次执行多条指令' }; @{ command='queue'; description='查看当前会话的自动队列' }; @{ command='pause'; description='暂停当前会话的自动队列' }; @{ command='resume'; description='恢复当前会话的自动队列' }; @{ command='clearqueue'; description='清空等待中的队列任务' }; @{ command='stop'; description='停止当前会话的运行' }; @{ command='status'; description='查看服务状态' }; @{ command='health'; description='查看完整健康状态' }; @{ command='approvals'; description='查看等待处理的审批' }; @{ command='help'; description='显示帮助' }
) } else { @(
    @{ command='sessions'; description='List recent OpenCode sessions' }; @{ command='find'; description='Search titles and project paths' }; @{ command='current'; description='Show the selected session' }; @{ command='show'; description='Show current session progress' }; @{ command='send'; description='Send one instruction now' }; @{ command='add'; description='Append one queued instruction' }; @{ command='batch'; description='Queue prompts separated by ---' }; @{ command='queue'; description='Show the session queue' }; @{ command='pause'; description='Pause automatic queue progress' }; @{ command='resume'; description='Resume automatic queue progress' }; @{ command='clearqueue'; description='Clear waiting queue items' }; @{ command='stop'; description='Stop the current run' }; @{ command='status'; description='Show service status' }; @{ command='health'; description='Show detailed health status' }; @{ command='approvals'; description='Show pending approvals' }; @{ command='help'; description='Show command help' }
) }
[void](Invoke-Telegram $token 'setMyCommands' @{ commands = $commands })
[void](Invoke-Telegram $token 'sendMessage' @{ chat_id=[string]$chat.id; text=(Get-AgentHubText 'BindingComplete') })
$token = $null
Write-Host ''
Write-Host (Get-AgentHubText 'ConfigComplete' @($ConfigPath)) -ForegroundColor Green
