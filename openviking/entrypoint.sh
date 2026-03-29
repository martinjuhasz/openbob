#!/bin/sh
# Generate ov.conf from environment variables and start OpenViking server

set -e

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is required}"

EMBEDDING_API_BASE="${EMBEDDING_API_BASE:-https://openrouter.ai/api/v1}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-openai/text-embedding-3-small}"
EMBEDDING_DIMENSION="${EMBEDDING_DIMENSION:-1536}"
LLM_API_BASE="${LLM_API_BASE:-https://openrouter.ai/api/v1}"
OPENVIKING_LLM_MODEL="${OPENVIKING_LLM_MODEL:-openai/gpt-4o-mini}"

OPENVIKING_API_KEY="${OPENVIKING_API_KEY:-yetaclaw-local}"
OV_ACCOUNT_ID="${OV_ACCOUNT_ID:-yetaclaw}"
OV_USER_ID="${OV_USER_ID:-default}"
OV_USER_KEY_FILE="/data/ov_user.key"

cat > /app/ov.conf << EOF
{
  "storage": {
    "workspace": "/data"
  },
  "server": {
    "host": "0.0.0.0",
    "root_api_key": "${OPENVIKING_API_KEY}"
  },
  "embedding": {
    "dense": {
      "provider": "openai",
      "api_base": "${EMBEDDING_API_BASE}",
      "api_key": "${OPENROUTER_API_KEY}",
      "model": "${EMBEDDING_MODEL}",
      "dimension": ${EMBEDDING_DIMENSION}
    }
  },
  "vlm": {
    "provider": "openai",
    "api_base": "${LLM_API_BASE}",
    "api_key": "${OPENROUTER_API_KEY}",
    "model": "${OPENVIKING_LLM_MODEL}"
  }
}
EOF

export OPENVIKING_CONFIG_FILE=/app/ov.conf

# Start web console on port 8020 if OPENVIKING_CONSOLE=1 (default: enabled)
if [ "${OPENVIKING_CONSOLE:-1}" = "1" ]; then
  python -m openviking.console.bootstrap \
    --openviking-url "http://localhost:1933" \
    --host 0.0.0.0 \
    --port 8020 &
fi

# Start server in background for provisioning, then bring to foreground
openviking-server &
SERVER_PID=$!

# Wait for server to be ready (up to 30s)
echo "[entrypoint] Waiting for OpenViking server..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:1933/health > /dev/null 2>&1; then
    echo "[entrypoint] Server ready."
    break
  fi
  sleep 1
done

# Provision account + user if user key file doesn't exist yet
if [ ! -f "$OV_USER_KEY_FILE" ]; then
  echo "[entrypoint] Provisioning account '${OV_ACCOUNT_ID}' and user '${OV_USER_ID}'..."
  RESPONSE=$(curl -sf -X POST http://localhost:1933/api/v1/admin/accounts \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${OPENVIKING_API_KEY}" \
    -d "{\"account_id\": \"${OV_ACCOUNT_ID}\", \"admin_user_id\": \"${OV_USER_ID}\"}" 2>&1) || true

  USER_KEY=$(echo "$RESPONSE" | grep -o '"user_key":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$USER_KEY" ]; then
    echo "$USER_KEY" > "$OV_USER_KEY_FILE"
    echo "[entrypoint] User key saved to ${OV_USER_KEY_FILE}"
    echo "[entrypoint] Web console API key: ${USER_KEY}"
  else
    echo "[entrypoint] Warning: could not provision user key. Response: ${RESPONSE}"
  fi
else
  USER_KEY=$(cat "$OV_USER_KEY_FILE")
  echo "[entrypoint] Using existing user key from ${OV_USER_KEY_FILE}"
  echo "[entrypoint] Web console API key: ${USER_KEY}"
fi

# Keep server in foreground
wait $SERVER_PID
