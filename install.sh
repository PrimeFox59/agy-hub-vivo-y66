#!/bin/bash
# ==============================================================================
#  Antigravity Orchestrator Pro - 1-Click Automated Installer (Linux / VPS)
# ==============================================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}==============================================================${NC}"
echo -e "${CYAN}   Antigravity Orchestrator Pro - Automated Installer        ${NC}"
echo -e "${CYAN}   Universal AI Workforce, Multi-Account Fallback & Gateway   ${NC}"
echo -e "${CYAN}==============================================================${NC}"
echo ""

# 1. Check Node.js and Python
echo -e "${YELLOW}[*] Checking system dependencies...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}[*] Installing Node.js (v20 LTS)...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

if ! command -v python3 &> /dev/null; then
    echo -e "${YELLOW}[*] Installing Python 3 and pip...${NC}"
    sudo apt-get update
    sudo apt-get install -y python3 python3-pip
fi

# 2. Install Project Manager dependencies
echo -e "${YELLOW}[*] Installing Node.js packages in agy-project-manager...${NC}"
cd agy-project-manager
npm install --production --no-audit --no-fund
cd ..

# 3. Install Telegram Bot dependencies
echo -e "${YELLOW}[*] Installing Python packages in agy-telegram-bot...${NC}"
python3 -m pip install -r agy-telegram-bot/requirements.txt --quiet --break-system-packages 2>/dev/null || python3 -m pip install -r agy-telegram-bot/requirements.txt --quiet

# 4. Check PM2
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}[*] Installing PM2 Process Manager globally...${NC}"
    sudo npm install -g pm2
fi

# 5. Start with PM2
echo -e "${YELLOW}[*] Launching services with PM2...${NC}"
pm2 start ecosystem.config.js
pm2 save

echo ""
echo -e "${GREEN}==============================================================${NC}"
echo -e "${GREEN}  ✓ Deployment Completed Successfully!                       ${NC}"
echo -e "${GREEN}==============================================================${NC}"
echo -e "  🌐 Web Dashboard  : ${CYAN}http://localhost:5678${NC}"
echo -e "  🔑 Default Login  : Username: ${YELLOW}admin${NC} | Password: ${YELLOW}admin@prime2026!${NC}"
echo -e "  🤖 Telegram Bot   : Running in background via PM2"
echo -e "  🔄 Auto-Fallback  : Active & Monitoring Quotas"
echo ""
