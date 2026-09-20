[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$secure = ConvertTo-SecureString ([string]$config.botTokenProtected)
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { Write-Output -NoEnumerate ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
