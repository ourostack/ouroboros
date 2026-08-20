#!/bin/sh
set -eu

CONFIG_ROOT=/mnt/user/appdata/ouro-butler/acceptance/configs
EVIDENCE_ROOT=/mnt/user/appdata/ouro-butler/acceptance/evidence
IMAGE_ID=${1:-}
COMMAND=${2:-}
CONFIG_NAME=${3:-}

test "$#" -eq 3 || exit 2
IMAGE_DIGEST=${IMAGE_ID#sha256:}
test "$IMAGE_DIGEST" != "$IMAGE_ID" || exit 2
test "${#IMAGE_DIGEST}" -eq 64 || exit 2
case "$IMAGE_DIGEST" in *[!0-9a-f]*) exit 2 ;; esac
case "$COMMAND" in
  telegram-bootstrap|cursor-snapshot|cursor-delta|callback-inject|unraid-key-rotate|evidence-snapshot|reboot-request|reboot-resume|evidence-bundle-index|evidence-bundle-verify) ;;
  *) exit 2 ;;
esac
test "$CONFIG_NAME" = "$COMMAND.json" || exit 2
case "$CONFIG_NAME" in *[!A-Za-z0-9._-]*) exit 2 ;; esac

CONFIG_PATH=$CONFIG_ROOT/$CONFIG_NAME
test -d "$CONFIG_ROOT" && test ! -L "$CONFIG_ROOT" || exit 1
test -d "$EVIDENCE_ROOT" && test ! -L "$EVIDENCE_ROOT" || exit 1
test -f "$CONFIG_PATH" && test ! -L "$CONFIG_PATH" || exit 1
test "$(stat -c '%u:%g %a' "$CONFIG_ROOT")" = "10001:10001 700" || exit 1
test "$(stat -c '%u:%g %a' "$EVIDENCE_ROOT")" = "10001:10001 700" || exit 1
test "$(stat -c '%u:%g %a' "$CONFIG_PATH")" = "10001:10001 600" || exit 1
test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" || exit 1
/usr/local/bin/node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!value || value.allowedRoot !== "/evidence") process.exit(1);
' "$CONFIG_PATH"

exec /usr/bin/timeout -s KILL 30 /usr/bin/docker run --rm -i --pull=never --network host \
  --user 10001:10001 --read-only \
  --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
  --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
  --mount type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli,readonly \
  --mount type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly \
  --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh \
  "$IMAGE_ID" "$COMMAND" --config /run/ouro-acceptance/config.json
