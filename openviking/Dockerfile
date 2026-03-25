# yetaclaw OpenViking Container
# Provides memory storage and retrieval for agents
FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir openviking

WORKDIR /app

COPY ov.conf ./

RUN mkdir -p /data

EXPOSE 1933

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:1933/health || exit 1

CMD ["python", "-m", "openviking.server", "--config", "/app/ov.conf", "--port", "1933"]
