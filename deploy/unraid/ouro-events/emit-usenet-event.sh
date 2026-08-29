#!/bin/bash
set -euo pipefail

PRODUCER="/boot/config/custom/ouro-events/emit-event.mjs"

if [ "$#" -ne 9 ]; then
  echo "usage: emit-usenet-event.sh <action> <incident> <transition> <receipt> <summary> <evidence> <verified> <verification-digest> <observed-at>" >&2
  exit 2
fi

ACTION="$1"
INCIDENT="$2"
TRANSITION="$3"
RECEIPT="$4"
SUMMARY="$5"
EVIDENCE="$6"
VERIFIED="$7"
VERIFICATION_DIGEST="$8"
VERIFIED_AT="$9"

case "$ACTION" in
  sabnzbd.pause|prowlarr.disable-indexer) ;;
  *) echo "usenet event adapter: action is not allowlisted" >&2; exit 2 ;;
esac
case "$VERIFIED" in true|false) ;; *) echo "usenet event adapter: verification state is invalid" >&2; exit 2 ;; esac
[[ "$VERIFICATION_DIGEST" =~ ^[a-f0-9]{64}$ ]] || { echo "usenet event adapter: verification digest is invalid" >&2; exit 2; }

REVISION="$(printf '%s\0%s\0%s\0%s' "$ACTION" "$INCIDENT" "$TRANSITION" "$RECEIPT" | sha256sum | cut -d' ' -f1)"

exec /usr/local/bin/node "$PRODUCER" \
  "--agent" "sanctuary" \
  "--source" "sanctuary-usenet" \
  "--event-type" "usenet.protective_action" \
  "--incident-key" "$INCIDENT" \
  "--transition-id" "$TRANSITION" \
  "--revision" "$REVISION" \
  "--action" "$ACTION" \
  "--action-receipt" "$RECEIPT" \
  "--summary" "$SUMMARY" \
  "--evidence" "$EVIDENCE" \
  "--protective-state-verified" "$VERIFIED" \
  "--protective-state-digest" "$VERIFICATION_DIGEST" \
  "--protective-state-observed-at" "$VERIFIED_AT"
