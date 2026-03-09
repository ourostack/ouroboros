#!/usr/bin/env bash
# Azure App Service startup script.
# Writes secrets from the OUROBOROS_SECRETS app setting to disk,
# then starts the bot.

set -euo pipefail

SECRETS_DIR="$HOME/.agentsecrets/ouroboros"
SECRETS_FILE="$SECRETS_DIR/secrets.json"

if [ -n "${OUROBOROS_SECRETS:-}" ]; then
  mkdir -p "$SECRETS_DIR"
  echo "$OUROBOROS_SECRETS" > "$SECRETS_FILE"
  echo "Wrote secrets to $SECRETS_FILE"
else
  echo "WARNING: OUROBOROS_SECRETS not set — bot will use defaults"
fi

exec node dist/teams-entry.js --agent ouroboros
