#!/usr/bin/env bash
# Azure App Service startup script.
#
# Architecture:
#   - Harness code: installed from npm (@ouro.bot/cli@alpha) into /home/ouro-harness/
#   - Agent bundle: manually uploaded to /home/AgentBundles/ouroboros.ouro/
#   - Credentials: read from the agent's Bitwarden/Vaultwarden vault after the
#     host has been explicitly unlocked with `ouro vault unlock`.
#
# This script is idempotent and safe for frequent Azure App Service restarts.

set -euo pipefail

HARNESS_DIR="/home/ouro-harness"
BUNDLE_DIR="/home/AgentBundles/ouroboros.ouro"
LEGACY_STATE_DIR="/home/.agentstate/ouroboros"
ENTRY="$HARNESS_DIR/node_modules/@ouro.bot/cli/dist/senses/teams-entry.js"

# --- 1. Bootstrap bundle from wwwroot if not yet in persistent storage ---
# On first deploy, the bundle is included in the wwwroot zip. We copy it to
# /home/AgentBundles/ (persistent) so it survives future deploys that wipe wwwroot.
WWWROOT_BUNDLE="/home/site/wwwroot/AgentBundles/ouroboros.ouro"
if [ -d "$WWWROOT_BUNDLE" ] && [ ! -f "$BUNDLE_DIR/agent.json" ]; then
  echo "Bootstrapping bundle from wwwroot to persistent storage"
  mkdir -p "$(dirname "$BUNDLE_DIR")"
  cp -r "$WWWROOT_BUNDLE" "$BUNDLE_DIR"
fi

# --- 2. One-time state migration from legacy paths ---
if [ -d "$LEGACY_STATE_DIR/friends" ] && [ ! -d "$BUNDLE_DIR/friends" ]; then
  echo "Migrating friends from $LEGACY_STATE_DIR/friends to $BUNDLE_DIR/friends"
  cp -r "$LEGACY_STATE_DIR/friends" "$BUNDLE_DIR/friends"
fi

if [ -d "$LEGACY_STATE_DIR/sessions" ] && [ ! -d "$BUNDLE_DIR/state/sessions" ]; then
  echo "Migrating sessions from $LEGACY_STATE_DIR/sessions to $BUNDLE_DIR/state/sessions"
  mkdir -p "$BUNDLE_DIR/state"
  cp -r "$LEGACY_STATE_DIR/sessions" "$BUNDLE_DIR/state/sessions"
fi

# --- 3. Install/update harness from npm ---
mkdir -p "$HARNESS_DIR"
cd "$HARNESS_DIR"

# Ensure package.json exists (prevents npm "idealTree" tracker errors)
if [ ! -f "package.json" ]; then
  echo '{"private":true}' > package.json
fi

INSTALLED_VERSION=""
if [ -f "node_modules/@ouro.bot/cli/package.json" ]; then
  INSTALLED_VERSION=$(node -p "require('@ouro.bot/cli/package.json').version" 2>/dev/null || echo "")
fi

CHANNEL_VERSION=$(npm view "@ouro.bot/cli@alpha" version 2>/dev/null || echo "")

if [ -z "$INSTALLED_VERSION" ] || [ "$INSTALLED_VERSION" != "$CHANNEL_VERSION" ]; then
  echo "Installing @ouro.bot/cli@alpha (installed: ${INSTALLED_VERSION:-none}, alpha: ${CHANNEL_VERSION:-unknown})"
  # Clean any stale npm state that causes "idealTree already exists" errors
  rm -rf package-lock.json node_modules
  npm cache clean --force 2>/dev/null || true
  npm install @ouro.bot/cli@alpha 2>&1
else
  echo "Harness up to date (v$INSTALLED_VERSION)"
fi

# --- 4. Symlink ouro CLI into PATH so the agent can use it via shell ---
ln -sf "$HARNESS_DIR/node_modules/.bin/ouro" /usr/local/bin/ouro

# --- 6. Start the bot ---
if [ ! -f "$ENTRY" ]; then
  echo "ERROR: teams-entry.js not found at $ENTRY"
  exit 1
fi

echo "Starting bot from $ENTRY"
exec node "$ENTRY" --agent ouroboros
