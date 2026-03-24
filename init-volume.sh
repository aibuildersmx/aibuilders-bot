#!/bin/bash
set -e

echo "🤖 Initializing volume..."

mkdir -p /data/agent/extensions /data/.pi /data/sessions /data/baileys-auth

# Always update agent files from app bundle
cp /app/agent/AGENTS.md /data/agent/ 2>/dev/null || true
cp /app/agent/settings.json /data/agent/ 2>/dev/null || true

# Auth — copy from env var if file doesn't exist
if [ ! -f /data/agent/auth.json ] && [ -n "$BOT_AUTH_JSON" ]; then
  echo "$BOT_AUTH_JSON" > /data/agent/auth.json
  echo "🤖 auth.json written from env var"
fi

# Baileys auth — restore from base64 env var if dir is empty
if [ -z "$(ls -A /data/baileys-auth 2>/dev/null)" ] && [ -n "$BAILEYS_AUTH_B64" ]; then
  echo "$BAILEYS_AUTH_B64" | base64 -d | tar xzf - -C /data/baileys-auth
  echo "🤖 Baileys auth restored from env var"
fi

# API keys — always regenerate from env vars
rm -f /data/.pi/.env
touch /data/.pi/.env
[ -n "$BRAVE_API_KEY" ] && echo "BRAVE_API_KEY=$BRAVE_API_KEY" >> /data/.pi/.env
[ -n "$FIRECRAWL_API_KEY" ] && echo "FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY" >> /data/.pi/.env
echo "🤖 .pi/.env written from env vars"

echo "🤖 Volume ready."
