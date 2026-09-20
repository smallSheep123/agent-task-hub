[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\localization.ps1')

Set-AgentHubLanguage 'zh-CN'
if ((Get-AgentHubText 'ManagerTitle') -notmatch '管理中心') { throw 'Chinese manager text is unavailable.' }
if ((Get-AgentHubText 'Failed' @('demo')) -notmatch 'demo') { throw 'Chinese formatting failed.' }

Set-AgentHubLanguage 'en-US'
if ((Get-AgentHubText 'ManagerTitle') -notmatch 'Manager') { throw 'English manager text is unavailable.' }
if ((Get-AgentHubText 'Failed' @('demo')) -notmatch 'demo') { throw 'English formatting failed.' }

Write-Output 'LOCALIZATION_TEST=PASS'
