$script:AgentHubCatalog = @{
    'zh-CN' = @{
        ManagerTitle = 'Agent Task Hub 管理中心'; MenuSetup = '首次配置并启动'; MenuStart = '启动服务'; MenuStop = '停止服务'; MenuRestart = '重启服务'; MenuStatus = '查看状态'; MenuLogs = '查看日志'; MenuDoctor = '运行自检'; MenuPlugin = '重新安装 OpenCode 插件'; MenuUninstall = '卸载自启任务（保留配置）'; MenuLanguage = '切换语言'; MenuExit = '退出'; Choose = '请选择'; InvalidMenu = '输入无效，请选择 0 到 9，或输入 L。'; Done = '操作完成。'; Failed = '操作失败：{0}'; Return = '按回车键返回主菜单'
        SetupTitle = 'Agent Task Hub 初始化'; SetupIntro = '这里只需要 BotFather 提供的 Telegram Bot Token。Token 会使用当前 Windows 用户的 DPAPI 加密保存。'; PasteToken = '粘贴 Bot Token'; BadToken = 'Bot Token 格式不正确。'; TelegramCallFailed = 'Telegram {0} 调用失败。请检查 Token 和网络连接。'; BotVerified = '机器人验证成功：@{0}'; WebhookFound = '这个机器人当前配置了 webhook：{0}'; RemoveWebhook = '长轮询不能与 webhook 同时使用。输入 Y 删除旧 webhook'; CancelledWebhook = '已取消，未修改 webhook。'; SendStart = '请在 Telegram 中打开 @{0}，发送 /start，然后回到这里按回车。'; NoPrivateMessage = '没有读取到私聊消息。请给机器人发送 /start 后重新运行。'; BindUser = '将绑定 Telegram 用户 {0}（user_id={1}, chat_id={2}）'; ConfirmY = '输入 Y 确认'; CancelledConfig = '已取消，未保存配置。'; SecureDirectoryFailed = '无法收紧目录权限：{0}'; SecureFileFailed = '无法收紧文件权限：{0}'; BindingComplete = 'Agent Task Hub 已完成安全绑定。服务启动后发送 /sessions。'; ConfigComplete = '配置完成：{0}'
        PluginInstalled = 'OpenCode 插件已安装：{0}'; RestartOpenCode = '已经运行的 OpenCode 需要重启一次才能加载插件。'; ServiceMissing = '服务未安装。'; ServiceNotInstalled = '服务：未安装；Telegram：{0}'; ServiceStatus = '服务：{0}；Telegram：{1}；上次结果：{2}；上次启动：{3}'; Configured = '已配置'; NotConfigured = '未配置'; TelegramNotInitialized = 'Telegram 尚未初始化，请先运行首次配置。'; NoLogs = '暂无日志。'; DoctorWaiting = 'NOT_CONFIGURED：程序自检通过，等待 Bot Token 初始化。'; Uninstalled = '自启任务已卸载；配置、插件和日志均已保留。'
    }
    'en-US' = @{
        ManagerTitle = 'Agent Task Hub Manager'; MenuSetup = 'First-time setup and start'; MenuStart = 'Start service'; MenuStop = 'Stop service'; MenuRestart = 'Restart service'; MenuStatus = 'Show status'; MenuLogs = 'Show logs'; MenuDoctor = 'Run diagnostics'; MenuPlugin = 'Reinstall OpenCode plugin'; MenuUninstall = 'Remove startup task (keep data)'; MenuLanguage = 'Change language'; MenuExit = 'Exit'; Choose = 'Select an option'; InvalidMenu = 'Invalid choice. Select 0 through 9, or enter L.'; Done = 'Operation completed.'; Failed = 'Operation failed: {0}'; Return = 'Press Enter to return to the main menu'
        SetupTitle = 'Agent Task Hub setup'; SetupIntro = 'You only need the Telegram Bot Token from BotFather. Windows DPAPI encrypts it for the current user.'; PasteToken = 'Paste Bot Token'; BadToken = 'The Bot Token format is invalid.'; TelegramCallFailed = 'Telegram {0} failed. Check the token and network connection.'; BotVerified = 'Bot verified: @{0}'; WebhookFound = 'This bot currently has a webhook: {0}'; RemoveWebhook = 'Long polling cannot run with a webhook. Enter Y to remove the old webhook'; CancelledWebhook = 'Cancelled. The webhook was not changed.'; SendStart = 'Open @{0} in Telegram, send /start, then return here and press Enter.'; NoPrivateMessage = 'No private message was found. Send /start to the bot and run setup again.'; BindUser = 'Bind Telegram user {0} (user_id={1}, chat_id={2})'; ConfirmY = 'Enter Y to confirm'; CancelledConfig = 'Cancelled. Configuration was not saved.'; SecureDirectoryFailed = 'Could not restrict directory permissions: {0}'; SecureFileFailed = 'Could not restrict file permissions: {0}'; BindingComplete = 'Agent Task Hub is securely linked. Send /sessions after the service starts.'; ConfigComplete = 'Configuration completed: {0}'
        PluginInstalled = 'OpenCode plugin installed: {0}'; RestartOpenCode = 'Restart any running OpenCode instance once to load the plugin.'; ServiceMissing = 'The service is not installed.'; ServiceNotInstalled = 'Service: not installed; Telegram: {0}'; ServiceStatus = 'Service: {0}; Telegram: {1}; last result: {2}; last start: {3}'; Configured = 'configured'; NotConfigured = 'not configured'; TelegramNotInitialized = 'Telegram is not initialized. Run first-time setup first.'; NoLogs = 'No logs are available.'; DoctorWaiting = 'NOT_CONFIGURED: program checks passed; waiting for Bot Token setup.'; Uninstalled = 'The startup task was removed. Configuration, plugin, and logs were kept.'
    }
}

function Get-AgentHubPreferencePath { Join-Path $env:USERPROFILE '.config\agent-task-hub\ui.json' }
function Get-SavedAgentHubLanguage {
    $path = Get-AgentHubPreferencePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { $value = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).language; if ($value -in @('zh-CN','en-US')) { return $value } } catch {}
    return $null
}
function Resolve-AgentHubLanguage([string]$Requested = 'auto') {
    if ($Requested -in @('zh-CN','en-US')) { return $Requested }
    $saved = Get-SavedAgentHubLanguage
    if ($saved) { return $saved }
    if ([Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh-*') { return 'zh-CN' }
    return 'en-US'
}
function Save-AgentHubLanguage([string]$Language) {
    if ($Language -notin @('zh-CN','en-US')) { throw "Unsupported language: $Language" }
    $path = Get-AgentHubPreferencePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    @{ language = $Language } | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
}
function Set-AgentHubLanguage([string]$Language) { $script:AgentHubLanguage = Resolve-AgentHubLanguage $Language }
function Get-AgentHubText([string]$Key, [object[]]$Arguments = @()) {
    $language = if ($script:AgentHubLanguage) { $script:AgentHubLanguage } else { Resolve-AgentHubLanguage }
    $value = $script:AgentHubCatalog[$language][$Key]
    if ($null -eq $value) { $value = $script:AgentHubCatalog['en-US'][$Key] }
    if ($null -eq $value) { return $Key }
    if ($Arguments.Count) { return ([string]$value -f $Arguments) }
    return [string]$value
}
