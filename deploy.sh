#!/usr/bin/env bash
set -euo pipefail

PM2_NAME="anonymous-server"
APP_DIR="/var/www/anonymous-messenger"

echo "==> Pull repo"
cd "$APP_DIR"
git pull

echo "==> Build client"
cd "$APP_DIR/client"
rm -rf dist
npm ci
npm run build

echo "==> Install server deps + restart pm2"
cd "$APP_DIR/server"
npm ci

pm2 restart "$PM2_NAME" || pm2 start index.js --name "$PM2_NAME"
pm2 save

echo "==> Reload nginx"
sudo nginx -t
sudo systemctl reload nginx

echo "✅ Done"
