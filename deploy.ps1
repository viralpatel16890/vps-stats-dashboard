# Deploy script for VPS Stats Dashboard (PowerShell)
# Uploads built files to production server

Write-Host "Deploying VPS Stats Dashboard to production..." -ForegroundColor Green

# Server details
$Server = "root@68.183.81.164"
$RemotePath = "/var/www/stats.viralpatelstudio.in/browser/"
$LocalDist = "dist/stats-dashboard/"

# Check if dist directory exists
if (-not (Test-Path $LocalDist)) {
    Write-Host "Error: Build directory not found. Run 'npm run build' first." -ForegroundColor Red
    exit 1
}

# Check if rsync is available (usually via Git Bash or WSL)
try {
    $rsyncTest = Get-Command rsync -ErrorAction Stop
} catch {
    Write-Host "Error: rsync not found. Please install rsync or use Git Bash/WSL." -ForegroundColor Red
    Write-Host "Alternative: Use scp to copy files manually:" -ForegroundColor Yellow
    Write-Host "scp -r dist/stats-dashboard/* root@68.183.81.164:/var/www/stats.viralpatelstudio.in/" -ForegroundColor Yellow
    exit 1
}

# Upload files to server
Write-Host "Uploading files to $Server..." -ForegroundColor Blue
& rsync -avz --delete "$LocalDist" "$Server`:$RemotePath"

if ($LASTEXITCODE -eq 0) {
    # Restart nginx to ensure changes are picked up
    Write-Host "Restarting nginx..." -ForegroundColor Blue
    ssh $Server "systemctl reload nginx"
    
    Write-Host "Deployment complete!" -ForegroundColor Green
    Write-Host "Live at: https://stats.viralpatelstudio.in/" -ForegroundColor Cyan
} else {
    Write-Host "Error during file upload." -ForegroundColor Red
    exit 1
}
