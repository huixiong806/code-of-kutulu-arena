# Kutulu Arena launcher (Windows PowerShell)
# Usage:  ./start.ps1            -> http://localhost:8787
#         $env:PORT=8788; ./start.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 18+ is required, but 'node' was not found." -ForegroundColor Red
    exit 1
}

if (-not $env:PORT) { $env:PORT = "8787" }

Write-Host ""
Write-Host "  Kutulu Arena" -ForegroundColor Cyan
Write-Host "  http://localhost:$($env:PORT)" -ForegroundColor Cyan
Write-Host ""

node server/index.js

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "The server exited with code $LASTEXITCODE." -ForegroundColor Yellow
    Write-Host "If the port is busy, start on another one:" -ForegroundColor Yellow
    Write-Host "  `$env:PORT=8788; ./start.ps1" -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit $LASTEXITCODE
}
