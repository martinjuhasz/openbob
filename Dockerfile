# yetaclaw Host Container
# Stage 1: Build TypeScript
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build && npm prune --production

# Stage 2: Runtime — lean image with docker CLI
FROM node:22-slim

# Docker CLI (to spawn agent containers via mounted socket)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY package.json ./

# Data and workspace directories
RUN mkdir -p /data /workspace/groups

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('fs').existsSync('/data') || process.exit(1)"

ENTRYPOINT ["node", "dist/index.js"]
