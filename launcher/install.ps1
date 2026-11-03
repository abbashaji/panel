<#
.SYNOPSIS
  Registers (or removes) the blueprint:// protocol for the current user.

.DESCRIPTION
  Writes only to HKCU\Software\Classes\blueprint. No admin rights needed.
  Run it next to blueprint-launcher.exe, or pass -ExePath.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -ExePath C:\Tools\blueprint-launcher.exe
  .\install.ps1 -Uninstall
#>
param(
    [string]$ExePath = (Join-Path $PSScriptRoot 'blueprint-launcher.exe'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Classes\blueprint'

if ($Uninstall) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force
        Write-Host 'Removed the blueprint:// protocol registration.'
    } else {
        Write-Host 'Nothing to remove.'
    }
    return
}

if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    throw "Launcher not found: $ExePath"
}
$exe = (Resolve-Path -LiteralPath $ExePath).Path
if ($exe.Contains('"')) {
    throw 'The path must not contain a double quote.'
}

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Blueprint Launcher'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''

New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value ('"' + $exe + '" "%1"')

Write-Host "Registered blueprint:// for the current user -> $exe"
