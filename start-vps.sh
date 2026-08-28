#!/bin/bash
# Antigravity (AGY) Integration Hub - VPS / Linux Runner

set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================================"
echo "  Starting Antigravity (AGY) Integration Hub on VPS/Linux"
echo "========================================================"

cd "$ROOT_DIR/agy-project-manager"
if [ ! -d "node_modules" ]; then
    echo "[*] Installing Node.js dependencies..."
    npm install
fi

cd "$ROOT_DIR/agy-telegram-bot"
echo "[*] Checking Python dependencies..."
pip3 install -r requirements.txt --quiet || pip install -r requirements.txt --quiet

cd "$ROOT_DIR"
if command -v pm2 >/dev/null 2>&1; then
    echo "[+] Starting via PM2 ecosystem..."
    pm2 start ecosystem.config.js
    pm2 save
    pm2 status
else
    echo "[*] PM2 not found, running directly..."
    cd "$ROOT_DIR/agy-project-manager" && node server.js &
    cd "$ROOT_DIR/agy-telegram-bot" && python3 bot.py &
    wait
fi
