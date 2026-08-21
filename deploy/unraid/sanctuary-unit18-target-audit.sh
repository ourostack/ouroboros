#!/bin/sh
set -eu

IMAGE_ID=${1:-}
test "$#" -eq 1 || exit 2
IMAGE_DIGEST=${IMAGE_ID#sha256:}
test "$IMAGE_DIGEST" != "$IMAGE_ID" && test "${#IMAGE_DIGEST}" -eq 64 || exit 2
case "$IMAGE_DIGEST" in *[!0-9a-f]*) exit 2 ;; esac

AUDIT_ROOT=$(mktemp -d /run/ouro-unit18-target.XXXXXX)
AUDITOR=$AUDIT_ROOT/sanctuary-deployment-target.mjs
cleanup() {
  STATUS=$?
  rm -f -- "$AUDITOR"
  rmdir -- "$AUDIT_ROOT" 2>/dev/null || STATUS=1
  return "$STATUS"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/timeout -s KILL 20 /usr/bin/docker run --rm --pull=never --network none \
  --entrypoint /bin/cat "$IMAGE_ID" /opt/ouro/deploy/unraid/sanctuary-deployment-target.mjs >"$AUDITOR"
chmod 0500 "$AUDITOR"
chown 0:0 "$AUDITOR"
/usr/local/bin/node "$AUDITOR" final "$IMAGE_ID"
