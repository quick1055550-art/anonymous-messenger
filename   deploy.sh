#!/usr/bin/env bash
set -Eeuo pipefail

PM2_NAME="${PM2_NAME:-anonymous-server}"
PORT="${PORT:-4000}"
BRANCH="${1:-main}"
REMOTE="${REMOTE:-origin}"

log() { echo -e "\n==> $*\n"; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$PROJECT_DIR/client"
SERVER_DIR="$PROJECT_DIR/server"

SUDO="sudo"
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then SUDO=""; fi

if [[ -z "${NVM_DIR:-}" ]]; then export NVM_DIR="$HOME/.nvm"; fi
if [[ -s "$NVM_DIR/nvm.sh" ]]; then source "$NVM_DIR/nvm.sh"; fi

command -v git >/dev/null || { echo "git not found"; exit 1; }
command -v npm >/dev/null || { echo "npm not found"; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 not found"; exit 1; }

[[ -d "$CLIENT_DIR" ]] || { echo "client dir not found: $CLIENT_DIR"; exit 1; }
[[ -d "$SERVER_DIR" ]] || { echo "server dir not found: $SERVER_DIR"; exit 1; }

log "Project dir: $PROJECT_DIR"

log "Git: fetch + checkout $BRANCH + pull --ff-only"
cd "$PROJECT_DIR"
git fetch "$REMOTE" "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only "$REMOTE" "$BRANCH"

log "Client: install deps + build"
cd "$CLIENT_DIR"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
npm run build

log "Server: install deps"
cd "$SERVER_DIR"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

log "PM2: restart/start process '$PM2_NAME' on port $PORT"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  PORT="$PORT" pm2 restart "$PM2_NAME" --update-env
else
  PORT="$PORT" pm2 start "$SERVER_DIR/index.js" --name "$PM2_NAME" --time --update-env
fi

pm2 save >/dev/null 2>&1 || true

log "Nginx: config test + reload"
$SUDO nginx -t
$SUDO systemctl reload nginx

log "Done. Quick status:"
pm2 status || true
ss -lntp | egrep ":80|:443|:$PORT" || true