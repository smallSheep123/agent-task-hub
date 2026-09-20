[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$errors = @()

Get-ChildItem -LiteralPath $root -Recurse -Filter '*.ps1' -File | ForEach-Object {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors) { $errors += $parseErrors }
}

if ($errors.Count) {
    $errors | Format-List
    exit 1
}

Write-Output 'POWERSHELL_PARSE=PASS'
