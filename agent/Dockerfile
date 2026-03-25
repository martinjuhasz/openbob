# yetaclaw Agent Container
# Runs OpenCode SDK in isolated container, one per active session
FROM node:22-slim

# System dependencies for Chromium (agent-browser)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally
RUN npm install -g agent-browser

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Skills are mounted at /skills at runtime (read-only)
# Workspace is mounted at /workspace at runtime (read-write per group)
RUN mkdir -p \
    /workspace/group \
    /workspace/global \
    /workspace/ipc/messages \
    /workspace/ipc/tasks \
    /workspace/ipc/input \
    /skills \
    /home/node/.local/share

RUN chown -R node:node /workspace /home/node && chmod 777 /home/node
USER node

WORKDIR /workspace/group

# Symlink ~/.local/share/opencode → /data/opencode so OpenCode finds its auth + config
# /data is mounted at runtime from the shared yetaclaw-data volume
ENTRYPOINT ["sh", "-c", "mkdir -p /data/opencode && ln -sfn /data/opencode /home/node/.local/share/opencode && exec node /app/dist/index.js"]
