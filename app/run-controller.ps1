[CmdletBinding()]
param(
    [ValidateSet('run','check','self-test')]
    [string]$Mode = 'run',
    [string]$ControllerPath = '',
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $ControllerPath) { $ControllerPath = Join-Path $PSScriptRoot 'controller.mjs' }

function ConvertTo-ProxyUri([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $candidate = $Value.Trim()
    if ($candidate -match '^(?i)https?://') { return $candidate }
    return "http://$candidate"
}

function Import-WindowsProxy {
    if ($env:HTTPS_PROXY -or $env:https_proxy) { return }
    $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if (-not $settings -or [int]$settings.ProxyEnable -ne 1 -or [string]::IsNullOrWhiteSpace([string]$settings.ProxyServer)) { return }

    $raw = [string]$settings.ProxyServer
    $httpProxy = $null
    $httpsProxy = $null
    if ($raw -match '=') {
        foreach ($part in $raw -split ';') {
            $pair = $part -split '=', 2
            if ($pair.Count -ne 2) { continue }
            if ($pair[0].Trim() -ieq 'http') { $httpProxy = ConvertTo-ProxyUri $pair[1] }
            if ($pair[0].Trim() -ieq 'https') { $httpsProxy = ConvertTo-ProxyUri $pair[1] }
        }
    } else {
        $httpProxy = ConvertTo-ProxyUri $raw
        $httpsProxy = $httpProxy
    }
    if (-not $httpsProxy) { $httpsProxy = $httpProxy }
    if (-not $httpProxy) { $httpProxy = $httpsProxy }
    if ($httpProxy) { $env:HTTP_PROXY = $httpProxy }
    if ($httpsProxy) { $env:HTTPS_PROXY = $httpsProxy }
}

Import-WindowsProxy
$loopback = '127.0.0.1,localhost,::1'
$existingNoProxy = if ($env:NO_PROXY) { $env:NO_PROXY } elseif ($env:no_proxy) { $env:no_proxy } else { '' }
$env:NO_PROXY = (@($existingNoProxy, $loopback) | Where-Object { $_ }) -join ','

if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$supportsProxy = [bool](& $NodePath --help | Select-String -SimpleMatch '--use-env-proxy')
$arguments = @()
if ($supportsProxy -and ($env:HTTPS_PROXY -or $env:HTTP_PROXY)) { $arguments += '--use-env-proxy' }
$arguments += $ControllerPath
if ($Mode -eq 'check') { $arguments += '--check' }
elseif ($Mode -eq 'self-test') { $arguments += '--self-test' }

& $NodePath @arguments
exit $LASTEXITCODE
