#!/bin/bash
# Supervised by launchd; command paths can be overridden for isolated tests.
set -u
STATE="${OURO_TEAMS_TUNNEL_STATE:-$HOME/.local/state/ouro-teams-tunnel}"
LOG="$STATE/cloudflared.log"
BOT_RG="${OURO_TEAMS_BOT_RG:?set OURO_TEAMS_BOT_RG}"
BOT_NAME="${OURO_TEAMS_BOT_NAME:?set OURO_TEAMS_BOT_NAME}"
SUBSCRIPTION="${OURO_TEAMS_SUBSCRIPTION:?set OURO_TEAMS_SUBSCRIPTION}"
CLOUDFLARED="${OURO_TEAMS_CLOUDFLARED:-$HOME/.local/bin/cloudflared-ouro}"
AZ="${OURO_TEAMS_AZ:-az}"
CURL="${OURO_TEAMS_CURL:-curl}"
PORT="${OURO_TEAMS_PORT:-3978}"
POLL="${OURO_TEAMS_TUNNEL_POLL_SECONDS:-1}"
METRICS="${OURO_TEAMS_TUNNEL_METRICS:-127.0.0.1:20246}"
mkdir -p "$STATE" || exit 1
: > "$LOG"
"$CLOUDFLARED" tunnel --no-autoupdate --metrics "$METRICS" --url "http://localhost:$PORT" >> "$LOG" 2>&1 &
CF=$!
trap 'kill "$CF" 2>/dev/null; wait "$CF" 2>/dev/null' EXIT
trap 'exit 1' TERM INT
fail() {
  echo "$(date -u +%FT%TZ) $1" >> "$STATE/events.log"
  exit 1
}
alive() {
  kill -0 "$CF" 2>/dev/null || fail "tunnel process exited"
  if grep -q 'Unauthorized: Tunnel not found' "$LOG"; then
    fail "permanent tunnel rejection"
  fi
}
ready() {
  "$CURL" --fail --silent --max-time 5 "http://$METRICS/ready" > /dev/null 2>> "$STATE/events.log"
}
URL=""
READY=0
for _ in $(seq 1 60); do
  alive
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1)
  if [ -n "$URL" ] && ready; then READY=1; break; fi
  sleep "$POLL"
done
[ "$READY" = 1 ] || fail "tunnel did not become ready"
WANT="$URL/api/messages"
REGISTERED=0
for attempt in 1 2 3 4 5; do
  alive
  ready || fail "tunnel lost readiness before registration"
  if HAVE=$("$AZ" bot show --subscription "$SUBSCRIPTION" -g "$BOT_RG" -n "$BOT_NAME" --query properties.endpoint -o tsv 2>>"$STATE/events.log"); then
    if [ "$HAVE" = "$WANT" ]; then REGISTERED=1; break; fi
    if "$AZ" bot update --subscription "$SUBSCRIPTION" -g "$BOT_RG" -n "$BOT_NAME" --endpoint "$WANT" -o none 2>>"$STATE/events.log"; then
      HAVE=$("$AZ" bot show --subscription "$SUBSCRIPTION" -g "$BOT_RG" -n "$BOT_NAME" --query properties.endpoint -o tsv 2>>"$STATE/events.log") || HAVE=""
      if [ "$HAVE" = "$WANT" ]; then REGISTERED=1; break; fi
    fi
  fi
  sleep "$POLL"
done
[ "$REGISTERED" = 1 ] || fail "endpoint registration not confirmed"
echo "$URL" > "$STATE/url.txt" || fail "cannot record tunnel URL"
echo "$(date -u +%FT%TZ) endpoint confirmed $WANT" >> "$STATE/events.log"
MISSES=0
while true; do
  sleep "$POLL"
  alive
  if ready; then MISSES=0; else MISSES=$((MISSES + 1)); fi
  [ "$MISSES" -lt 3 ] || fail "tunnel lost readiness"
done
