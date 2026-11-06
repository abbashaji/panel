<#
.SYNOPSIS
  Tests, publishes and registers the blueprint:// launcher for the current user.

.EXAMPLE
  .\launcher\build-install.ps1
#>
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo

function Invoke-Step {
    param([string]$Name, [scriptblock]$Command)
    Write-Host "==> $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host "BUILD FAILED at step: $Name" -ForegroundColor Red
        exit 1
    }
}

Invoke-Step 'dotnet test' { dotnet test launcher/Core.Tests }
Invoke-Step 'dotnet publish' {
    dotnet publish launcher/App/App.csproj -c Release -r win-x64 --self-contained false -o launcher\out
}

$exe = Join-Path $repo 'launcher\out\blueprint-launcher.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Write-Host "BUILD FAILED: $exe was not produced." -ForegroundColor Red
    exit 1
}

Write-Host '==> install'
& (Join-Path $repo 'launcher\install.ps1') -ExePath $exe

$cmdKey = 'HKCU:\Software\Classes\blueprint\shell\open\command'
$registered = (Get-ItemProperty -Path $cmdKey).'(default)'
Write-Host "Registered protocol command: $registered"

# Self test only if the source mentions the --self-test switch.
$hasSelfTest = Select-String -Path (Join-Path $repo 'launcher\App\*.cs') -Pattern '--self-test' -Quiet
if ($hasSelfTest) {
    $sample = 'blueprint://sync?repo=owner/name&cell=C-001'
    & $exe --self-test $sample
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Self test OK: $sample"
    } else {
        Write-Host "Self test FAILED (exit $LASTEXITCODE): $sample" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host 'Self test skipped: the launcher has no --self-test switch.'
}
