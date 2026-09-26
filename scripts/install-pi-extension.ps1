[CmdletBinding()]
param([string]$PiAgentDir = (Join-Path $env:USERPROFILE '.pi\agent'))

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\adapters\pi-extension.js'))
$destinationDir = Join-Path $PiAgentDir 'extensions'
$destination = Join-Path $destinationDir 'agent-task-hub.js'
if (-not (Test-Path -LiteralPath (Join-Path $PiAgentDir 'bin\pi.cmd'))) {
    throw "Pi was not found at $PiAgentDir"
}
New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Output "Pi extension installed: $destination"
Write-Output 'In an already-open Pi terminal, enter /reload once to activate it.'
