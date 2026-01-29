#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/anonymous-messenger"

echo "==> Pull repo"
cd "$APP_DIR"
git pull

echo "==> Build client"
cd "$APP_DIR/client"
rm -rf dist
npm ci
npm run build

echo "==> Install server deps (safe) + restart pm2"
cd "$APP_DIR/server"
npm ci

# Перезапуск
pm2 restart anonymous-server || pm2 start index.js --name anonymous-server
pm2 save

echo "==> Reload nginx"
nginx -t
systemctl reload nginx

echo "✅ Done"
