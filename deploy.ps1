# Deploy Tawan Farm app via git push (no token needed after first-time login)
# Run this from anywhere; it copies the latest files from ..\Claude and pushes them.

$repoDir = $PSScriptRoot
$sourceDir = Join-Path (Split-Path $repoDir -Parent) "Claude"

Write-Host "=== Tawan Farm Git Deploy ===" -ForegroundColor Cyan

Copy-Item (Join-Path $sourceDir "index.html") (Join-Path $repoDir "index.html") -Force
Copy-Item (Join-Path $sourceDir "TawanFarm_App.html") (Join-Path $repoDir "TawanFarm_App.html") -Force
Write-Host "Copied latest index.html + TawanFarm_App.html into repo." -ForegroundColor Green

Set-Location $repoDir

$status = git status --porcelain
if (-not $status) {
    Write-Host "No changes to deploy." -ForegroundColor Yellow
    pause
    exit 0
}

$commitMessage = Read-Host "Commit message (Enter = default)"
if (-not $commitMessage) { $commitMessage = "Update Tawan Farm app" }

git add -A
git commit -m "$commitMessage"
git push

Write-Host ""
Write-Host "=== Pushed. GitHub Actions will validate, then Pages updates in ~1 minute. ===" -ForegroundColor Green
Write-Host "Visit: https://gamekroekphon.github.io" -ForegroundColor Cyan
pause
