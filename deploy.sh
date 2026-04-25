#!/bin/bash

# Deploy script for VPS Stats Dashboard
# Uploads built files to production server

echo "Deploying VPS Stats Dashboard to production..."

# Server details
SERVER="root@68.183.81.164"
REMOTE_PATH="/var/www/stats.viralpatelstudio.in/"
LOCAL_DIST="dist/stats-dashboard/"

# Check if dist directory exists
if [ ! -d "$LOCAL_DIST" ]; then
    echo "Error: Build directory not found. Run 'npm run build' first."
    exit 1
fi

# Upload files to server
echo "Uploading files to $SERVER..."
rsync -avz --delete "$LOCAL_DIST" "$SERVER:$REMOTE_PATH"

# Restart nginx to ensure changes are picked up
echo "Restarting nginx..."
ssh "$SERVER" "systemctl reload nginx"

echo "Deployment complete!"
echo "Live at: https://stats.viralpatelstudio.in/"
