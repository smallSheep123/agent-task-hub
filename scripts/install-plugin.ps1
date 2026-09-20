[CmdletBinding()]
param(
    [string]$Source = "$PSScriptRoot\..\adapters\opencode.js",
    [string]$Destination = "$env:USERPROFILE\.config\opencode\plugins\agent-task-hub.js",
    [ValidateSet('auto','zh-CN','en-US')]
    [string]$Language = 'auto'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'localization.ps1')
$Language = Resolve-AgentHubLanguage $Language
Set-AgentHubLanguage $Language
$dir = Split-Path -Parent $Destination
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Copy-Item -LiteralPath $Source -Destination $Destination -Force
Write-Host (Get-AgentHubText 'PluginInstalled' @($Destination))
Write-Host (Get-AgentHubText 'RestartOpenCode')
