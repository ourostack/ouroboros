#!/usr/bin/env bash
# Self-restart wrapper for Ouroboros.
# Runs the agent; if it exits with code 42, rebuilds and restarts.
# Usage: ./scripts/teams-sense/self-restart.sh [--agent ouroboros] [extra args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

MAX_RESTARTS=5
restart_count=0

while true; do
  echo "[self-restart] Building..."
  npm run build

  echo "[self-restart] Starting agent (restart #$restart_count)..."
  set +e
  node dist/cli-entry.js "$@"
  exit_code=$?
  set -e

  if [ "$exit_code" -eq 42 ]; then
    restart_count=$((restart_count + 1))
    if [ "$restart_count" -ge "$MAX_RESTARTS" ]; then
      echo "[self-restart] Max restarts ($MAX_RESTARTS) reached. Stopping."
      exit 1
    fi
    echo "[self-restart] Exit code 42 — self-deploy restart requested. Pulling and rebuilding..."
    git pull --ff-only || echo "[self-restart] git pull failed, continuing with local code"
    continue
  else
    echo "[self-restart] Agent exited with code $exit_code"
    exit "$exit_code"
  fi
done
