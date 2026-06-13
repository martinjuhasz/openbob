# openbob Agent Container
# Runs OpenCode SDK in isolated container, one per active session
FROM node:22-slim

# System dependencies for media tools
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary for YouTube audio/subtitle extraction
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Install opencode CLI globally
RUN npm install -g opencode-ai

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Chromium for local PDF generation (separate from CloakBrowser)
RUN npx playwright install chromium --with-deps

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Install create-pdf CLI tool
RUN ln -s /app/scripts/create-pdf.mjs /usr/local/bin/create-pdf

# All runtime directories live under /workspace (mounted at runtime)
RUN mkdir -p \
    /workspace/data/project \
    /workspace/data/opencode \
    /workspace/data/telegram \
    /workspace/data/ipc/messages \
    /workspace/data/ipc/tasks \
    /workspace/data/ipc/input \
    /workspace/skills \
    /home/node/.local/share

RUN chown -R node:node /workspace /home/node && chmod 777 /home/node
USER node

WORKDIR /workspace/data/project

# Symlink ~/.local/share/opencode → /workspace/data/opencode so OpenCode finds its auth + config
ENTRYPOINT ["sh", "-c", "ln -sfn /workspace/data/opencode /home/node/.local/share/opencode && exec node /app/dist/index.js"]
