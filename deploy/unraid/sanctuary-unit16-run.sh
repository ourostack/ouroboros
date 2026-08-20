#!/bin/sh
set -eu

CONFIG_ROOT=/mnt/user/appdata/ouro-butler/acceptance/configs
EVIDENCE_ROOT=/mnt/user/appdata/ouro-butler/acceptance/evidence
RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
BUNDLE_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
PRODUCTION_CONTAINER=ouro-butler
IMAGE_ID=${1:-}
MODE=${2:-}
BROKER_PID=
PRIVATE_ROOT=
PRODUCTION_STOPPED=no
HOST_REBOOT_COMMITTED=no

cleanup_unit16() {
  CLEANUP_STATUS=$?
  if test -n "$BROKER_PID"; then kill "$BROKER_PID" 2>/dev/null || true; wait "$BROKER_PID" 2>/dev/null || true; fi
  if test "$PRODUCTION_STOPPED" = yes && test "$HOST_REBOOT_COMMITTED" = no; then
    if ! restore_production_container; then CLEANUP_STATUS=1; fi
    PRODUCTION_STOPPED=no
  fi
  if test -n "$PRIVATE_ROOT" && test -d "$PRIVATE_ROOT"; then rm -rf -- "$PRIVATE_ROOT"; fi
  return "$CLEANUP_STATUS"
}
trap cleanup_unit16 EXIT HUP INT TERM

IMAGE_DIGEST=${IMAGE_ID#sha256:}
test "$IMAGE_DIGEST" != "$IMAGE_ID" || exit 2
test "${#IMAGE_DIGEST}" -eq 64 || exit 2
case "$IMAGE_DIGEST" in *[!0-9a-f]*) exit 2 ;; esac
test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" || exit 1
test -d "$CONFIG_ROOT" && test ! -L "$CONFIG_ROOT" || exit 1
test -d "$EVIDENCE_ROOT" && test ! -L "$EVIDENCE_ROOT" || exit 1
test "$(stat -c '%u:%g %a' "$CONFIG_ROOT")" = "10001:10001 700" || exit 1
test "$(stat -c '%u:%g %a' "$EVIDENCE_ROOT")" = "10001:10001 700" || exit 1

case "$MODE" in
  materialize)
    test "$#" -eq 3 || { test "$#" -eq 4 && test "$3" = cursor-snapshot; } || exit 2
    COMMAND=${3:-}
    PHASE=${4:-}
    ;;
  *)
    test "$#" -eq 3 || exit 2
    COMMAND=$MODE
    CONFIG_NAME=${3:-}
    ;;
esac
case "$COMMAND" in
  telegram-bootstrap|cursor-snapshot|cursor-delta|callback-inject|unraid-key-rotate|evidence-snapshot|reboot-request|reboot-resume|evidence-bundle-index|evidence-bundle-verify) ;;
  *) exit 2 ;;
esac

PRIVATE_ROOT=$(mktemp -d /run/ouro-unit16.XXXXXX)
chmod 0750 "$PRIVATE_ROOT"
chown 0:10001 "$PRIVATE_ROOT"
SOCKET_ROOT=$PRIVATE_ROOT/socket
install -d -m 0750 -o 0 -g 10001 "$SOCKET_ROOT"
BROKER_SOCKET=$SOCKET_ROOT/adapter.sock
CLOSED_INVENTORY=$PRIVATE_ROOT/closed-inventory.json
BROKER_SNAPSHOT=$PRIVATE_ROOT/broker-container-inspect.json
BROKER_PROGRAM=$PRIVATE_ROOT/sanctuary-unit16-host-broker.mjs
IMAGE_FACT=$PRIVATE_ROOT/image-digest
CONTAINER_FACT=$PRIVATE_ROOT/container-digest
HEALTH_FACT=$PRIVATE_ROOT/postboot-health.json
POLLER_FACT=$PRIVATE_ROOT/telegram-poller-count.json
CONTAINER_INSPECT_FACT=$PRIVATE_ROOT/container-inspect.json

start_broker() {
  /usr/bin/timeout -s KILL 20 /usr/bin/docker run --rm --pull=never --network none \
    --entrypoint /bin/cat "$IMAGE_ID" /opt/ouro/deploy/unraid/sanctuary-unit16-host-broker.mjs >"$BROKER_PROGRAM"
  chmod 0500 "$BROKER_PROGRAM"
  chown 0:0 "$BROKER_PROGRAM"
  /usr/local/bin/node "$BROKER_PROGRAM" "$BROKER_SOCKET" "$CLOSED_INVENTORY" "$IMAGE_ID" "$BROKER_SNAPSHOT" </dev/null >/dev/null 2>&1 &
  BROKER_PID=$!
  ATTEMPT=0
  while test "$ATTEMPT" -lt 600 && { test ! -S "$BROKER_SOCKET" || test ! -f "$CLOSED_INVENTORY" || test ! -f "$BROKER_SNAPSHOT"; }; do
    kill -0 "$BROKER_PID" 2>/dev/null || return 1
    ATTEMPT=$((ATTEMPT + 1))
    sleep 0.1
  done
  test -S "$BROKER_SOCKET" || return 1
  test "$(stat -c '%u:%g %a' "$BROKER_SOCKET")" = "0:10001 660" || return 1
  test "$(stat -c '%u:%g %a' "$CLOSED_INVENTORY")" = "0:0 600" || return 1
  test "$(stat -c '%u:%g %a' "$BROKER_SNAPSHOT")" = "0:0 600" || return 1
}

prepare_live_facts() {
  install -m 0444 -o 0 -g 0 "$BROKER_SNAPSHOT" "$CONTAINER_INSPECT_FACT"
  /usr/local/bin/node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const expectedKeys = ["autostartExact", "containerId", "health", "imageId", "manualAuthRequired", "mountCount", "mountsDigest", "networkMode", "publishedPortCount", "readOnlyRoot", "restartCount", "restartPolicy", "running", "schemaVersion", "updaterDisabled", "user", "vaultUnlocked"];
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) || value.schemaVersion !== 1
        || value.imageId !== process.argv[2] || !/^[0-9a-f]{64}$/.test(value.containerId)
        || !/^[0-9a-f]{64}$/.test(value.mountsDigest) || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0
        || typeof value.autostartExact !== "boolean" || typeof value.updaterDisabled !== "boolean"
        || typeof value.vaultUnlocked !== "boolean" || typeof value.manualAuthRequired !== "boolean") process.exit(1);
      fs.writeFileSync(process.argv[3], `${value.imageId.slice("sha256:".length)}\n`);
      fs.writeFileSync(process.argv[4], `${value.containerId}\n`);
      fs.writeFileSync(process.argv[5], `${JSON.stringify({ healthy: value.health === "healthy" })}\n`);
    ' "$CONTAINER_INSPECT_FACT" "$IMAGE_ID" "$IMAGE_FACT" "$CONTAINER_FACT" "$HEALTH_FACT"
  chmod 0444 "$IMAGE_FACT" "$CONTAINER_FACT" "$HEALTH_FACT" "$CONTAINER_INSPECT_FACT"
  chown 0:0 "$IMAGE_FACT" "$CONTAINER_FACT" "$HEALTH_FACT" "$CONTAINER_INSPECT_FACT"
}

restore_production_container() {
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$PRODUCTION_CONTAINER")" = "$IMAGE_ID" || return 1
  /usr/bin/timeout -s KILL 30 /usr/bin/docker start "$PRODUCTION_CONTAINER" >/dev/null || return 1
  RESTORE_ATTEMPT=0
  while test "$RESTORE_ATTEMPT" -lt 120; do
    test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$PRODUCTION_CONTAINER")" = "$IMAGE_ID" || return 1
    RESTORE_RUNNING=$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$PRODUCTION_CONTAINER") || return 1
    RESTORE_HEALTH=$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$PRODUCTION_CONTAINER") || return 1
    if test "$RESTORE_RUNNING" = true && test "$RESTORE_HEALTH" = healthy; then return 0; fi
    RESTORE_ATTEMPT=$((RESTORE_ATTEMPT + 1))
    sleep 1
  done
  return 1
}

quiesce_production_telegram_poller() {
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$PRODUCTION_CONTAINER")" = "$IMAGE_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$PRODUCTION_CONTAINER")" = true || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$PRODUCTION_CONTAINER")" = healthy || return 1
  PRODUCTION_STOPPED=yes
  /usr/bin/timeout -s KILL 45 /usr/bin/docker stop --time 30 "$PRODUCTION_CONTAINER" >/dev/null
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$PRODUCTION_CONTAINER")" = "$IMAGE_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$PRODUCTION_CONTAINER")" = false || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Pid}}' "$PRODUCTION_CONTAINER")" = 0 || return 1
  printf '%s\n' '{"activePollers":0,"productionContainerStopped":true}' >"$POLLER_FACT"
  chmod 0444 "$POLLER_FACT"
  chown 0:0 "$POLLER_FACT"
}

materialize_config() {
  OUTPUT=$1
  SNAPSHOT_PHASE=${2:-}
  EXTRA_MOUNT=
  if test "$COMMAND" = unraid-key-rotate; then
    test -f "$CLOSED_INVENTORY" || return 1
    install -m 0400 -o 10001 -g 10001 "$CLOSED_INVENTORY" "$PRIVATE_ROOT/container-inventory.json"
    EXTRA_MOUNT=$PRIVATE_ROOT/container-inventory.json
  fi
  if test -n "$EXTRA_MOUNT"; then
    /usr/bin/timeout -s KILL 30 /usr/bin/docker run --rm --pull=never --network none \
      --user 10001:10001 --read-only \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence,readonly" \
      --mount "type=bind,src=$EXTRA_MOUNT,dst=/run/ouro-acceptance/closed-inventory.json,readonly" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh \
      "$IMAGE_ID" materialize-config "$COMMAND" >"$OUTPUT"
  elif test -n "$SNAPSHOT_PHASE"; then
    /usr/bin/timeout -s KILL 30 /usr/bin/docker run --rm --pull=never --network none \
      --user 10001:10001 --read-only \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence,readonly" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh \
      "$IMAGE_ID" materialize-config "$COMMAND" "$SNAPSHOT_PHASE" >"$OUTPUT"
  else
    /usr/bin/timeout -s KILL 30 /usr/bin/docker run --rm --pull=never --network none \
      --user 10001:10001 --read-only \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence,readonly" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh \
      "$IMAGE_ID" materialize-config "$COMMAND" >"$OUTPUT"
  fi
  /usr/local/bin/node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!value || value.allowedRoot !== "/evidence") process.exit(1);
  ' "$OUTPUT"
}

if test "$MODE" = materialize; then
  CONFIG_NAME=$COMMAND.json
  if test "$COMMAND" = unraid-key-rotate; then start_broker; fi
  CONFIG_TMP=$(mktemp "$CONFIG_ROOT/.$CONFIG_NAME.tmp.XXXXXX")
  materialize_config "$CONFIG_TMP" "${PHASE:-}"
  install -m 0600 -o 10001 -g 10001 "$CONFIG_TMP" "$CONFIG_ROOT/$CONFIG_NAME"
  sync -f "$CONFIG_ROOT/$CONFIG_NAME"
  sync -f "$CONFIG_ROOT"
  rm -f -- "$CONFIG_TMP"
  exit 0
fi

test "$CONFIG_NAME" = "$COMMAND.json" || exit 2
case "$CONFIG_NAME" in *[!A-Za-z0-9._-]*) exit 2 ;; esac
CONFIG_PATH=$CONFIG_ROOT/$CONFIG_NAME
test -f "$CONFIG_PATH" && test ! -L "$CONFIG_PATH" || exit 1
test "$(stat -c '%u:%g %a' "$CONFIG_PATH")" = "10001:10001 600" || exit 1

start_broker
EXPECTED_CONFIG=$PRIVATE_ROOT/expected-config.json
SNAPSHOT_PHASE=
if test "$COMMAND" = cursor-snapshot; then
  SNAPSHOT_PHASE=$(/usr/local/bin/node -e '
    const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.evidencePath === "/evidence/cursor-before.json") process.stdout.write("before");
    else if (value.evidencePath === "/evidence/cursor-after.json") process.stdout.write("after");
    else process.exit(1);
  ' "$CONFIG_PATH")
fi
materialize_config "$EXPECTED_CONFIG" "$SNAPSHOT_PHASE"
cmp -s "$EXPECTED_CONFIG" "$CONFIG_PATH" || exit 1
case "$COMMAND" in telegram-bootstrap|callback-inject) test -r /proc/self/fd/3 || exit 2 ;; esac
prepare_live_facts
if test "$COMMAND" = telegram-bootstrap; then quiesce_production_telegram_poller; fi

case "$COMMAND" in
  telegram-bootstrap) TIME_LIMIT=900; NETWORK=host; INPUT=yes; BUNDLE_MODE=readonly; BROKER=no ;;
  callback-inject) TIME_LIMIT=120; NETWORK=host; INPUT=yes; BUNDLE_MODE=rw; BROKER=no ;;
  unraid-key-rotate) TIME_LIMIT=600; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  evidence-snapshot) TIME_LIMIT=1860; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  reboot-request) TIME_LIMIT=120; NETWORK=none; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  reboot-resume) TIME_LIMIT=660; NETWORK=none; INPUT=no; BUNDLE_MODE=readonly; BROKER=no ;;
  *) TIME_LIMIT=120; NETWORK=none; INPUT=no; BUNDLE_MODE=readonly; BROKER=no ;;
esac

run_harness() {
  if test "$BUNDLE_MODE" = rw; then BUNDLE_SUFFIX=; else BUNDLE_SUFFIX=,readonly; fi
  if test "$COMMAND" = telegram-bootstrap; then
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm -i --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX" \
      --mount "type=bind,src=$POLLER_FACT,dst=/run/ouro-acceptance/telegram-poller-count.json,readonly" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$HEALTH_FACT,dst=/run/ouro-acceptance/postboot-health.json,readonly" \
      --mount "type=bind,src=$CONTAINER_INSPECT_FACT,dst=/run/ouro-acceptance/container-inspect.json,readonly" \
      --mount "type=bind,src=/proc/sys/kernel/random/boot_id,dst=/run/ouro-acceptance/boot-id,readonly" \
      --entrypoint /bin/sh "$IMAGE_ID" -ceu \
      'exec 3<&0; exec /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh "$@" 3<&3' \
      sanctuary-unit16 "$COMMAND" --config /run/ouro-acceptance/config.json <&3
  elif test "$COMMAND" = callback-inject; then
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm -i --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$HEALTH_FACT,dst=/run/ouro-acceptance/postboot-health.json,readonly" \
      --mount "type=bind,src=$CONTAINER_INSPECT_FACT,dst=/run/ouro-acceptance/container-inspect.json,readonly" \
      --mount "type=bind,src=/proc/sys/kernel/random/boot_id,dst=/run/ouro-acceptance/boot-id,readonly" \
      --entrypoint /bin/sh "$IMAGE_ID" -ceu \
      'exec 3<&0; exec /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh "$@" 3<&3' \
      sanctuary-unit16 "$COMMAND" --config /run/ouro-acceptance/config.json <&3
  elif test "$BROKER" = yes; then
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX" \
      --mount "type=bind,src=$SOCKET_ROOT,dst=/run/ouro-host-acceptance,readonly" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$HEALTH_FACT,dst=/run/ouro-acceptance/postboot-health.json,readonly" \
      --mount "type=bind,src=$CONTAINER_INSPECT_FACT,dst=/run/ouro-acceptance/container-inspect.json,readonly" \
      --mount "type=bind,src=/proc/sys/kernel/random/boot_id,dst=/run/ouro-acceptance/boot-id,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh \
      "$IMAGE_ID" "$COMMAND" --config /run/ouro-acceptance/config.json
  else
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$HEALTH_FACT,dst=/run/ouro-acceptance/postboot-health.json,readonly" \
      --mount "type=bind,src=$CONTAINER_INSPECT_FACT,dst=/run/ouro-acceptance/container-inspect.json,readonly" \
      --mount "type=bind,src=/proc/sys/kernel/random/boot_id,dst=/run/ouro-acceptance/boot-id,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh \
      "$IMAGE_ID" "$COMMAND" --config /run/ouro-acceptance/config.json
  fi
}

run_harness

if test "$COMMAND" = reboot-request; then
  /usr/local/bin/node -e '
    const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.operation !== "reboot" || value.phase !== "requested" || !/^[0-9a-f]{64}$/.test(value.requestId)) process.exit(1);
  ' "$EVIDENCE_ROOT/reboot.json"
  sync -f "$EVIDENCE_ROOT/reboot.json"
  sync -f "$EVIDENCE_ROOT"
  HOST_REBOOT_COMMITTED=yes
  cleanup_unit16
  BROKER_PID=
  PRIVATE_ROOT=
  /sbin/reboot
fi
