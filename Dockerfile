# Antigravity Orchestrator Pro - Production Container
FROM node:20-slim

# Install system dependencies & Python 3 for Telegram bot & utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    git \
    sqlite3 \
    procps \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy Project Manager dependencies & install
COPY agy-project-manager/package*.json ./agy-project-manager/
RUN cd agy-project-manager && npm ci --production

# Copy Telegram Bot requirements & install
COPY agy-telegram-bot/requirements.txt ./agy-telegram-bot/
RUN python3 -m pip install --no-cache-dir -r ./agy-telegram-bot/requirements.txt --break-system-packages

# Copy all application code
COPY . .

# Expose web control center port
EXPOSE 5678

# Environment variables
ENV NODE_ENV=production
ENV PORT=5678
ENV WORKSPACE_DIR=/app/workspace

RUN mkdir -p /app/workspace /app/agy-project-manager/data /app/agy-project-manager/uploads

# Start with script
CMD ["node", "agy-project-manager/server.js"]
