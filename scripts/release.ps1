<#
.SYNOPSIS
  One command: test, build the panel, deploy the Worker.

.EXAMPLE
  .\scripts\release.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Invoke-Step {
    param([string]$Name, [scriptblock]$Command)
    Write-Host "==> $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "RELEASE FAILED at step: $Name" -ForegroundColor Red
        exit 1
    }
}

Invoke-Step 'npm ci' { npm ci }
Invoke-Step 'npm test' { npm test }
Invoke-Step 'web: npm ci' { npm --prefix web ci }
Invoke-Step 'web: npm test' { npm --prefix web test }
Invoke-Step 'web: build' { npm --prefix web run build }

# Check secret names only (never their values).
Write-Host '==> checking secrets (names only)'
$secretsOut = (npx wrangler secret list 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
    Write-Host 'RELEASE FAILED at step: wrangler secret list (are you logged in? run: npx wrangler login)' -ForegroundColor Red
    exit 1
}
$missing = @()
foreach ($s in 'GITHUB_TOKEN', 'ADMIN_TOKEN', 'MCP_AUTH_TOKEN', 'PANEL_TOKEN') {
    if ($secretsOut -notmatch ('"' + $s + '"')) { $missing += $s }
}
if ($missing.Count -gt 0) {
    Write-Host ('Missing secrets: ' + ($missing -join ', ')) -ForegroundColor Red
    Write-Host 'Set each with: npx wrangler secret put <NAME>'
    Write-Host 'RELEASE FAILED at step: secret check' -ForegroundColor Red
    exit 1
}
Write-Host 'All required secrets exist.'

Write-Host '==> wrangler deploy'
$deployOut = (npx wrangler deploy 2>&1 | Out-String)
$code = $LASTEXITCODE
Write-Host $deployOut
if ($code -ne 0) {
    Write-Host 'RELEASE FAILED at step: wrangler deploy' -ForegroundColor Red
    exit 1
}

$url = ''
if ($deployOut -match 'https://[A-Za-z0-9._-]+\.workers\.dev') { $url = $Matches[0] }
Write-Host ''
Write-Host "Deployed. Panel path: $url/panel/"
