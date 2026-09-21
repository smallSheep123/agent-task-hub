[CmdletBinding()]
param(
    [ValidateSet('setup','start','stop','restart','status','logs','doctor','uninstall','install-plugin','codex-probe','codex-shared','codex-private')]
    [string]$Action = 'status',
    [ValidateSet('auto','zh-CN','en-US')]
    [string]$Language = 'auto'
)

$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot 'scripts'
. (Join-Path $scripts 'localization.ps1')
$Language = Resolve-AgentHubLanguage $Language
Set-AgentHubLanguage $Language
if ($Action -eq 'setup') {
    & (Join-Path $scripts 'install-plugin.ps1') -Language $Language
    & (Join-Path $scripts 'setup.ps1') -Language $Language
    & (Join-Path $scripts 'service.ps1') -Action install -Language $Language
} elseif ($Action -eq 'install-plugin') {
    & (Join-Path $scripts 'install-plugin.ps1') -Language $Language
} elseif ($Action -eq 'codex-probe') {
    & (Join-Path $scripts 'codex-transport.ps1') -Action probe
} elseif ($Action -eq 'codex-shared') {
    & (Join-Path $scripts 'codex-transport.ps1') -Action enable-shared
} elseif ($Action -eq 'codex-private') {
    & (Join-Path $scripts 'codex-transport.ps1') -Action disable-shared
} else {
    & (Join-Path $scripts 'service.ps1') -Action $Action -Language $Language
}
