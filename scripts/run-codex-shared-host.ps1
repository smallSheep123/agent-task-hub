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

& $codex app-server --listen "ws://127.0.0.1:$Port"
exit $LASTEXITCODE
