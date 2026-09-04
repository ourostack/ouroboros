#!/bin/sh
set -eu

RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
BUNDLE_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
test "$#" -ge 1 || exit 2
IMAGE_ID=$1
shift
TARGET_PROFILE=staging
if test "${1:-}" = --profile; then
  test "$#" -ge 2 || exit 2
  TARGET_PROFILE=$2
  shift 2
fi
case "$TARGET_PROFILE" in
  staging)
    CONFIG_ROOT=/mnt/user/appdata/ouro-butler/acceptance/configs
    EVIDENCE_ROOT=/mnt/user/appdata/ouro-butler/acceptance/evidence
    PRODUCTION_CONTAINER=ouro-butler-staging
    ;;
  final)
    CONFIG_ROOT=/mnt/user/appdata/ouro-butler/acceptance/final/configs
    EVIDENCE_ROOT=/mnt/user/appdata/ouro-butler/acceptance/final/evidence
    PRODUCTION_CONTAINER=ouro-butler
    ;;
  *) exit 2 ;;
esac
TARGET_CONTAINER_ID=
MODE=${1:-}
case "$MODE" in --*) exit 2 ;; esac
BROKER_PID=
PRIVATE_ROOT=
PRODUCTION_STOPPED=no
HOST_REBOOT_COMMIT_STATE=not_sent
ACCEPTANCE_ALIAS_MOUNTED=no
ACCEPTANCE_CANONICAL_PINNED=no
ACCEPTANCE_PIN_ROOT=
ACCEPTANCE_STATE_ROOT=

assert_health_probe_cleanup() {
  /usr/bin/timeout -s KILL 10 /usr/local/bin/node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const acceptance = process.argv[1];
    for (const name of ["health-probe-workspaces", "health-probe-pending", "health-probe-processes"]) {
      const target = path.join(acceptance, name);
      if (fs.existsSync(target) && fs.readdirSync(target).length !== 0) process.exit(1);
    }
    if (fs.existsSync(process.argv[2])) process.exit(1);
  ' "$ACCEPTANCE_STATE_ROOT" "$BUNDLE_ROOT/state/health/sanctuary-health.json.lease"
}

terminate_broker() {
  test -n "$BROKER_PID" || return 0
  kill "$BROKER_PID" 2>/dev/null || true
  BROKER_WAIT=0
  while kill -0 "$BROKER_PID" 2>/dev/null && test "$BROKER_WAIT" -lt 10; do
    sleep 1
    BROKER_WAIT=$(( BROKER_WAIT + 1 ))
  done
  if kill -0 "$BROKER_PID" 2>/dev/null; then kill -KILL "$BROKER_PID" 2>/dev/null || true; fi
  wait "$BROKER_PID" 2>/dev/null || true
  BROKER_PID=
}

cleanup_unit16() {
  CLEANUP_STATUS=$?
  terminate_broker
  if test "$ACCEPTANCE_CANONICAL_PINNED" = yes && ! assert_health_probe_cleanup; then CLEANUP_STATUS=1; fi
  if test "$PRODUCTION_STOPPED" = yes && test "$HOST_REBOOT_COMMIT_STATE" = not_sent; then
    if ! restore_production_container; then CLEANUP_STATUS=1; fi
    PRODUCTION_STOPPED=no
  fi
  if test "$ACCEPTANCE_CANONICAL_PINNED" = yes; then
    if /usr/bin/timeout -s KILL 10 /bin/umount "$ACCEPTANCE_STATE_ROOT"; then
      ACCEPTANCE_CANONICAL_PINNED=no
    else CLEANUP_STATUS=1
    fi
  fi
  if test "$ACCEPTANCE_ALIAS_MOUNTED" = yes; then
    if /usr/bin/timeout -s KILL 10 /bin/umount "$ACCEPTANCE_PIN_ROOT"; then
      ACCEPTANCE_ALIAS_MOUNTED=no
    else CLEANUP_STATUS=1
    fi
  fi
  if test "$ACCEPTANCE_ALIAS_MOUNTED" = no && test -n "$PRIVATE_ROOT" && test -d "$PRIVATE_ROOT"; then rm -rf -- "$PRIVATE_ROOT"; fi
  return "$CLEANUP_STATUS"
}
trap cleanup_unit16 EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$MODE" in
  materialize)
    test "$#" -eq 2 || { test "$#" -eq 3 && test "$2" = cursor-snapshot; } || exit 2
    COMMAND=${2:-}
    PHASE=${3:-}
    ;;
  *)
    test "$#" -eq 2 || exit 2
    COMMAND=$MODE
    CONFIG_NAME=${2:-}
    ;;
esac
case "$COMMAND" in
  telegram-bootstrap|cursor-snapshot|cursor-delta|callback-inject|unraid-key-rotate|evidence-snapshot|reboot-request|reboot-resume|evidence-bundle-index|evidence-bundle-verify) ;;
  *) exit 2 ;;
esac

IMAGE_DIGEST=${IMAGE_ID#sha256:}
test "$IMAGE_DIGEST" != "$IMAGE_ID" || exit 2
test "${#IMAGE_DIGEST}" -eq 64 || exit 2
case "$IMAGE_DIGEST" in *[!0-9a-f]*) exit 2 ;; esac
test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" || exit 1
test -d "$CONFIG_ROOT" && test ! -L "$CONFIG_ROOT" || exit 1
test -d "$EVIDENCE_ROOT" && test ! -L "$EVIDENCE_ROOT" || exit 1
test "$(stat -c '%u:%g %a' "$CONFIG_ROOT")" = "10001:10001 700" || exit 1
test "$(stat -c '%u:%g %a' "$EVIDENCE_ROOT")" = "10001:10001 700" || exit 1

PRIVATE_ROOT=$(mktemp -d /run/ouro-unit16.XXXXXX)
chmod 0700 "$PRIVATE_ROOT"
chown 0:0 "$PRIVATE_ROOT"
SOCKET_ROOT=$PRIVATE_ROOT/socket
install -d -m 0750 -o 0 -g 10001 "$SOCKET_ROOT"
BROKER_SOCKET=$SOCKET_ROOT/adapter.sock
CLOSED_INVENTORY=$PRIVATE_ROOT/closed-inventory.json
BROKER_SNAPSHOT=$PRIVATE_ROOT/broker-container-inspect.json
BROKER_PROGRAM=$PRIVATE_ROOT/sanctuary-unit16-host-broker.mjs
TARGET_AUDITOR=$PRIVATE_ROOT/sanctuary-deployment-target.mjs
IMAGE_FACT=$PRIVATE_ROOT/image-digest
CONTAINER_FACT=$PRIVATE_ROOT/container-digest
PROCESS_BINDING_FACT=$PRIVATE_ROOT/process-binding-digest
HEALTH_FACT=$PRIVATE_ROOT/postboot-health.json
POLLER_FACT=$PRIVATE_ROOT/telegram-poller-count.json
CONTAINER_INSPECT_FACT=$PRIVATE_ROOT/container-inspect.json

start_broker() {
  /usr/bin/timeout -s KILL 20 /usr/bin/docker run --rm --pull=never --network none \
    --entrypoint /bin/cat "$IMAGE_ID" /opt/ouro/deploy/unraid/sanctuary-deployment-target.mjs >"$TARGET_AUDITOR"
  /usr/bin/timeout -s KILL 20 /usr/bin/docker run --rm --pull=never --network none \
    --entrypoint /bin/cat "$IMAGE_ID" /opt/ouro/deploy/unraid/sanctuary-unit16-host-broker.mjs >"$BROKER_PROGRAM"
  chmod 0500 "$BROKER_PROGRAM" "$TARGET_AUDITOR"
  chown 0:0 "$BROKER_PROGRAM" "$TARGET_AUDITOR"
  /usr/local/bin/node "$TARGET_AUDITOR" "$TARGET_PROFILE" "$IMAGE_ID" >"$PRIVATE_ROOT/deployment-target.json"
  chmod 0400 "$PRIVATE_ROOT/deployment-target.json"
  chown 0:0 "$PRIVATE_ROOT/deployment-target.json"
  TARGET_CONTAINER_BINDING=$(/usr/local/bin/node -e '
    const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const deployment = value && value.deployment;
    if (value?.schemaVersion !== "sanctuary-effective-deployment-v1" || deployment?.schemaVersion !== "sanctuary-deployment-target-v1"
      || deployment.profile !== process.argv[3] || deployment.targetContainerName !== process.argv[4]
      || deployment.targetImageId !== process.argv[2] || !/^[0-9a-f]{64}$/.test(deployment.targetContainerId)
      || !Number.isSafeInteger(deployment.targetPid) || deployment.targetPid <= 0 || deployment.targetPid > 4_194_304) process.exit(1);
    process.stdout.write(`${deployment.targetContainerId} ${deployment.targetPid}`);
  ' "$PRIVATE_ROOT/deployment-target.json" "$IMAGE_ID" "$TARGET_PROFILE" "$PRODUCTION_CONTAINER")
  set -- $TARGET_CONTAINER_BINDING
  test "$#" -eq 2 || return 1
  TARGET_CONTAINER_ID=$1
  TARGET_CONTAINER_PID=$2
  /usr/local/bin/node "$BROKER_PROGRAM" "$TARGET_PROFILE" "$TARGET_CONTAINER_ID" "$BROKER_SOCKET" "$CLOSED_INVENTORY" "$IMAGE_ID" "$BROKER_SNAPSHOT" </dev/null >/dev/null 2>&1 &
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
  await_post_audit_health
  refresh_live_facts
}

await_post_audit_health() {
  POST_AUDIT_ATTEMPT=0
  while test "$POST_AUDIT_ATTEMPT" -lt 120; do
    POST_AUDIT_STATE=$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Id}} {{.Name}} {{.Image}} {{.State.Running}} {{.State.Paused}} {{.State.Restarting}} {{.State.Dead}} {{.State.Pid}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$TARGET_CONTAINER_ID") || return 1
    set -- $POST_AUDIT_STATE
    test "$#" -eq 9 || return 1
    test "$1" = "$TARGET_CONTAINER_ID" && test "$2" = "/$PRODUCTION_CONTAINER" && test "$3" = "$IMAGE_ID" || return 1
    test "$4" = true && test "$6" = false && test "$7" = false || return 1
    test "$8" = "$TARGET_CONTAINER_PID" || return 1
    if test "$5" = false && test "$9" = healthy; then return 0; fi
    test "$5" = true || test "$5" = false || return 1
    test "$9" = starting || test "$9" = unhealthy || return 1
    POST_AUDIT_ATTEMPT=$((POST_AUDIT_ATTEMPT + 1))
    sleep 1
  done
  return 1
}

prepare_live_facts() {
  install -m 0444 -o 0 -g 0 "$BROKER_SNAPSHOT" "$CONTAINER_INSPECT_FACT"
  /usr/local/bin/node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const expectedKeys = ["autostartExact", "containerId", "health", "imageId", "liveProcessUser", "manualAuthRequired", "mountCount", "mountsDigest", "mountsExact", "networkMode", "processBindingDigest", "publishedPortCount", "readOnlyRoot", "recoveryMilestones", "restartCount", "restartPolicy", "running", "schemaVersion", "securityExact", "updaterDisabled", "user", "vaultUnlocked", "writableKeyExposure"];
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) || value.schemaVersion !== 1
        || value.imageId !== process.argv[2] || !/^[0-9a-f]{64}$/.test(value.containerId)
        || value.liveProcessUser !== "10001:10001" || !/^[0-9a-f]{64}$/.test(value.processBindingDigest)
        || !/^[0-9a-f]{64}$/.test(value.mountsDigest) || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0
        || typeof value.autostartExact !== "boolean" || typeof value.updaterDisabled !== "boolean"
        || typeof value.vaultUnlocked !== "boolean" || typeof value.manualAuthRequired !== "boolean"
        || typeof value.mountsExact !== "boolean" || typeof value.securityExact !== "boolean" || typeof value.writableKeyExposure !== "boolean") process.exit(1);
      const milestones = value.recoveryMilestones;
      if (!milestones || JSON.stringify(Object.keys(milestones).sort()) !== JSON.stringify(["arrayReady", "butlerReady", "dockerReady", "hostReady", "sshReady", "tailscaleReady"])
        || !Object.values(milestones).every((entry) => typeof entry === "boolean")) process.exit(1);
      fs.writeFileSync(process.argv[3], `${value.imageId.slice("sha256:".length)}\n`);
      fs.writeFileSync(process.argv[4], `${value.containerId}\n`);
      fs.writeFileSync(process.argv[5], `${JSON.stringify({ healthy: value.health === "healthy" })}\n`);
      fs.writeFileSync(process.argv[6], `${value.processBindingDigest}\n`);
    ' "$CONTAINER_INSPECT_FACT" "$IMAGE_ID" "$IMAGE_FACT" "$CONTAINER_FACT" "$HEALTH_FACT" "$PROCESS_BINDING_FACT"
  chmod 0444 "$IMAGE_FACT" "$CONTAINER_FACT" "$PROCESS_BINDING_FACT" "$HEALTH_FACT" "$CONTAINER_INSPECT_FACT"
  chown 0:0 "$IMAGE_FACT" "$CONTAINER_FACT" "$PROCESS_BINDING_FACT" "$HEALTH_FACT" "$CONTAINER_INSPECT_FACT"
}

refresh_live_facts() {
  REFRESHED_SNAPSHOT=$PRIVATE_ROOT/broker-container-inspect.refresh.json
  rm -f -- "$REFRESHED_SNAPSHOT"
  /usr/bin/timeout -s KILL 60 /usr/local/bin/node -e '
    const fs = require("node:fs");
    const net = require("node:net");
    const [socketPath, outputPath] = process.argv.slice(1);
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(JSON.stringify({ operation: "container_snapshot", targetId: "sanctuary" })));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > 1024 * 1024) socket.destroy(new Error("container snapshot response exceeds its bound"));
    });
    socket.on("end", () => {
      const envelope = JSON.parse(response);
      if (!envelope || envelope.ok !== true || !envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) process.exit(1);
      fs.writeFileSync(outputPath, `${JSON.stringify(envelope.result)}\n`, { flag: "wx", mode: 0o600 });
    });
    socket.on("error", () => process.exit(1));
  ' "$BROKER_SOCKET" "$REFRESHED_SNAPSHOT"
  test "$(stat -c '%u:%g %a' "$REFRESHED_SNAPSHOT")" = "0:0 600" || return 1
  mv -f -- "$REFRESHED_SNAPSHOT" "$BROKER_SNAPSHOT"
  prepare_live_facts
}

restore_production_container() {
  EXPECTED_CONTAINER_ID=$(cat "$CONTAINER_FACT") || return 1
  test "$EXPECTED_CONTAINER_ID" = "$TARGET_CONTAINER_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Id}}' "$EXPECTED_CONTAINER_ID")" = "$EXPECTED_CONTAINER_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Name}}' "$EXPECTED_CONTAINER_ID")" = "/$PRODUCTION_CONTAINER" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$EXPECTED_CONTAINER_ID")" = "$IMAGE_ID" || return 1
  if test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$EXPECTED_CONTAINER_ID")" = false; then
    /usr/bin/timeout -s KILL 30 /usr/bin/docker start "$EXPECTED_CONTAINER_ID" >/dev/null || return 1
  fi
  RESTORE_ATTEMPT=0
  while test "$RESTORE_ATTEMPT" -lt 120; do
    test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Id}}' "$EXPECTED_CONTAINER_ID")" = "$EXPECTED_CONTAINER_ID" || return 1
    RESTORE_RUNNING=$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$EXPECTED_CONTAINER_ID") || return 1
    RESTORE_HEALTH=$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$EXPECTED_CONTAINER_ID") || return 1
    if test "$RESTORE_RUNNING" = true && test "$RESTORE_HEALTH" = healthy; then return 0; fi
    RESTORE_ATTEMPT=$((RESTORE_ATTEMPT + 1))
    sleep 1
  done
  return 1
}

stop_exact_production_container() {
  EXPECTED_CONTAINER_ID=$(cat "$CONTAINER_FACT") || return 1
  test "$EXPECTED_CONTAINER_ID" = "$TARGET_CONTAINER_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Id}}' "$EXPECTED_CONTAINER_ID")" = "$EXPECTED_CONTAINER_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Name}}' "$EXPECTED_CONTAINER_ID")" = "/$PRODUCTION_CONTAINER" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$EXPECTED_CONTAINER_ID")" = "$IMAGE_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$EXPECTED_CONTAINER_ID")" = true || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$EXPECTED_CONTAINER_ID")" = healthy || return 1
  PRODUCTION_STOPPED=yes
  /usr/bin/timeout -s KILL 45 /usr/bin/docker stop --time 30 "$EXPECTED_CONTAINER_ID" >/dev/null || true
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Id}}' "$EXPECTED_CONTAINER_ID")" = "$EXPECTED_CONTAINER_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Image}}' "$EXPECTED_CONTAINER_ID")" = "$IMAGE_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Running}}' "$EXPECTED_CONTAINER_ID")" = false || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.State.Pid}}' "$EXPECTED_CONTAINER_ID")" = 0 || return 1
}

quiesce_production_telegram_poller() {
  stop_exact_production_container
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
case "$COMMAND" in callback-inject) test -r /proc/self/fd/3 || exit 2 ;; esac
prepare_live_facts
if test "$COMMAND" = telegram-bootstrap; then quiesce_production_telegram_poller; fi
if test "$COMMAND" = unraid-key-rotate; then stop_exact_production_container; fi

case "$COMMAND" in
  telegram-bootstrap) TIME_LIMIT=900; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=no ;;
  callback-inject) TIME_LIMIT=120; NETWORK=host; INPUT=yes; BUNDLE_MODE=rw; BROKER=no ;;
  unraid-key-rotate) TIME_LIMIT=600; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  evidence-snapshot) TIME_LIMIT=5700; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  reboot-request) TIME_LIMIT=300; NETWORK=none; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  reboot-resume) TIME_LIMIT=780; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;
  *) TIME_LIMIT=120; NETWORK=none; INPUT=no; BUNDLE_MODE=readonly; BROKER=no ;;
esac

assert_acceptance_state_inode() {
  ACCEPTANCE_PIN_INODE=$(stat -Lc '%d:%i' "$ACCEPTANCE_PIN_ROOT") || return 1
  test "$(stat -Lc '%d:%i' "$ACCEPTANCE_STATE_ROOT")" = "$ACCEPTANCE_PIN_INODE" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker inspect --format '{{.Name}} {{.Image}}' "$TARGET_CONTAINER_ID")" = "/$PRODUCTION_CONTAINER $IMAGE_ID" || return 1
  test "$(/usr/bin/timeout -s KILL 20 /usr/bin/docker exec "$TARGET_CONTAINER_ID" stat -Lc '%d:%i' /home/ouro/AgentBundles/sanctuary.ouro/state/acceptance)" = "$ACCEPTANCE_PIN_INODE" || return 1
}

if test "$COMMAND" = evidence-snapshot || test "$COMMAND" = reboot-request || test "$COMMAND" = reboot-resume; then
  stop_exact_production_container
  BUNDLE_STATE_ROOT=$BUNDLE_ROOT/state
  test -d "$BUNDLE_STATE_ROOT" && test ! -L "$BUNDLE_STATE_ROOT" || exit 1
  test "$(stat -c '%u:%g %a' "$BUNDLE_STATE_ROOT")" = "10001:10001 700" || exit 1
  ACCEPTANCE_STATE_ROOT=$BUNDLE_ROOT/state/acceptance
  if test ! -e "$ACCEPTANCE_STATE_ROOT"; then
    install -d -m 0700 -o 10001 -g 10001 "$ACCEPTANCE_STATE_ROOT"
  fi
  test -d "$ACCEPTANCE_STATE_ROOT" && test ! -L "$ACCEPTANCE_STATE_ROOT" || exit 1
  test "$(stat -c '%u:%g %a' "$ACCEPTANCE_STATE_ROOT")" = "10001:10001 700" || exit 1
  ACCEPTANCE_PIN_ROOT=$PRIVATE_ROOT/pinned-acceptance-state
  install -d -m 0700 -o 0 -g 0 "$ACCEPTANCE_PIN_ROOT"
  ! /bin/mountpoint -q "$ACCEPTANCE_PIN_ROOT" || exit 1
  ! /bin/mountpoint -q "$ACCEPTANCE_STATE_ROOT" || exit 1
  ACCEPTANCE_ALIAS_MOUNTED=yes
  /usr/bin/timeout -s KILL 20 /usr/local/bin/node -e '
    const { spawnSync } = require("node:child_process");
    const { closeSync, constants, fstatSync, openSync } = require("node:fs");
    const [sourcePath, target] = process.argv.slice(1);
    const source = openSync(sourcePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(source);
      if (!metadata.isDirectory() || metadata.uid !== 10001 || (metadata.mode & 0o777) !== 0o700) process.exit(1);
      const result = spawnSync("/bin/mount", ["--bind", "/proc/self/fd/3", target], {
        cwd: "/", timeout: 10_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        stdio: ["ignore", "ignore", "ignore", source],
      });
      if (result.error || result.status !== 0) process.exit(1);
    } finally { closeSync(source); }
  ' "$ACCEPTANCE_STATE_ROOT" "$ACCEPTANCE_PIN_ROOT"
  ACCEPTANCE_CANONICAL_PINNED=yes
  /usr/bin/timeout -s KILL 10 /bin/mount --bind "$ACCEPTANCE_PIN_ROOT" "$ACCEPTANCE_STATE_ROOT"
  restore_production_container
  PRODUCTION_STOPPED=no
  refresh_live_facts
  assert_acceptance_state_inode
fi

run_harness() {
  if test "$BUNDLE_MODE" = rw; then BUNDLE_SUFFIX=; else BUNDLE_SUFFIX=,readonly; fi
  if test "$COMMAND" = telegram-bootstrap; then
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX" \
      --mount "type=bind,src=$POLLER_FACT,dst=/run/ouro-acceptance/telegram-poller-count.json,readonly" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$PROCESS_BINDING_FACT,dst=/run/ouro-acceptance/process-binding-digest,readonly" \
      --mount "type=bind,src=$HEALTH_FACT,dst=/run/ouro-acceptance/postboot-health.json,readonly" \
      --mount "type=bind,src=$CONTAINER_INSPECT_FACT,dst=/run/ouro-acceptance/container-inspect.json,readonly" \
      --mount "type=bind,src=/proc/sys/kernel/random/boot_id,dst=/run/ouro-acceptance/boot-id,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh "$IMAGE_ID" \
      "$COMMAND" --config /run/ouro-acceptance/config.json
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
  elif test "$COMMAND" = evidence-snapshot; then
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly" \
      --mount "type=bind,src=$ACCEPTANCE_PIN_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance" \
      --mount "type=bind,src=$SOCKET_ROOT,dst=/run/ouro-host-acceptance,readonly" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$PROCESS_BINDING_FACT,dst=/run/ouro-acceptance/process-binding-digest,readonly" \
      --mount "type=bind,src=$HEALTH_FACT,dst=/run/ouro-acceptance/postboot-health.json,readonly" \
      --mount "type=bind,src=$CONTAINER_INSPECT_FACT,dst=/run/ouro-acceptance/container-inspect.json,readonly" \
      --mount "type=bind,src=/proc/sys/kernel/random/boot_id,dst=/run/ouro-acceptance/boot-id,readonly" \
      --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh \
      "$IMAGE_ID" "$COMMAND" --config /run/ouro-acceptance/config.json
  elif test "$BROKER" = yes; then
    if test "$COMMAND" = reboot-request || test "$COMMAND" = reboot-resume; then ACCEPTANCE_MOUNT="--mount type=bind,src=$ACCEPTANCE_PIN_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance"; else ACCEPTANCE_MOUNT=; fi
    /usr/bin/timeout -s KILL "$TIME_LIMIT" /usr/bin/docker run --rm --pull=never --network "$NETWORK" \
      --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,src=$CONFIG_PATH,dst=/run/ouro-acceptance/config.json,readonly" \
      --mount "type=bind,src=$EVIDENCE_ROOT,dst=/evidence" \
      --mount "type=bind,src=$RUNTIME_ROOT,dst=/home/ouro/.ouro-cli,readonly" \
      --mount "type=bind,src=$BUNDLE_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro$BUNDLE_SUFFIX" \
      $ACCEPTANCE_MOUNT \
      --mount "type=bind,src=$SOCKET_ROOT,dst=/run/ouro-host-acceptance,readonly" \
      --mount "type=bind,src=$IMAGE_FACT,dst=/run/ouro-acceptance/image-digest,readonly" \
      --mount "type=bind,src=$CONTAINER_FACT,dst=/run/ouro-acceptance/container-digest,readonly" \
      --mount "type=bind,src=$PROCESS_BINDING_FACT,dst=/run/ouro-acceptance/process-binding-digest,readonly" \
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
if test "$COMMAND" = evidence-snapshot || test "$COMMAND" = reboot-request || test "$COMMAND" = reboot-resume; then assert_acceptance_state_inode; fi

if test "$COMMAND" = reboot-request; then
  /usr/local/bin/node -e '
    const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.operation !== "reboot" || value.phase !== "requested" || !/^[0-9a-f]{64}$/.test(value.requestId)
      || !/^[0-9a-f]{64}$/.test(value.reservationId) || !/^[0-9a-f]{64}$/.test(value.processBindingDigest)) process.exit(1);
  ' "$EVIDENCE_ROOT/reboot.json"
  PRODUCTION_STOPPED=yes
  /usr/bin/timeout -s KILL 60 /usr/local/bin/node -e '
    const fs = require("node:fs"); const net = require("node:net");
    const checkpoint = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const request = JSON.stringify({ operation: "stop_reboot_owner", targetId: "sanctuary", requestId: checkpoint.requestId, reservationId: checkpoint.reservationId, processBindingDigest: checkpoint.processBindingDigest });
    let raw = ""; const socket = net.createConnection(process.argv[1]);
    socket.setEncoding("utf8"); socket.setTimeout(55000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => { raw += chunk; if (Buffer.byteLength(raw) > 65536) socket.destroy(new Error("oversize")); });
    socket.on("end", () => {
      const envelope = JSON.parse(raw); const result = envelope && envelope.ok === true ? envelope.result : null;
      if (!result || result.stopped !== true || result.targetId !== "sanctuary" || result.requestId !== checkpoint.requestId
        || result.reservationId !== checkpoint.reservationId || result.processBindingDigest !== checkpoint.processBindingDigest) process.exitCode = 1;
    });
    socket.on("error", () => { process.exitCode = 1; });
  ' "$BROKER_SOCKET" "$EVIDENCE_ROOT/reboot.json"
  sync -f "$EVIDENCE_ROOT/reboot.json"
  sync -f "$EVIDENCE_ROOT"
  HOST_REBOOT_COMMIT_STATE=attempting
  /usr/bin/timeout -s KILL 20 /usr/local/bin/node -e '
    const fs = require("node:fs"); const net = require("node:net");
    const checkpoint = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (checkpoint.operation !== "reboot" || checkpoint.phase !== "requested"
      || !/^[0-9a-f]{64}$/.test(checkpoint.requestId) || !/^[0-9a-f]{64}$/.test(checkpoint.reservationId)) process.exit(1);
    const request = JSON.stringify({ operation: "commit_reboot", targetId: "sanctuary", requestId: checkpoint.requestId, reservationId: checkpoint.reservationId, processBindingDigest: checkpoint.processBindingDigest });
    let raw = ""; const socket = net.createConnection(process.argv[1]);
    socket.setEncoding("utf8"); socket.setTimeout(15000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => { raw += chunk; if (Buffer.byteLength(raw) > 65536) socket.destroy(new Error("oversize")); });
    socket.on("end", () => {
      const envelope = JSON.parse(raw); const result = envelope && envelope.ok === true ? envelope.result : null;
      if (!result || result.committed !== true || result.targetId !== "sanctuary"
        || result.requestId !== checkpoint.requestId || result.reservationId !== checkpoint.reservationId
        || result.processBindingDigest !== checkpoint.processBindingDigest) process.exitCode = 1;
    });
    socket.on("error", () => { process.exitCode = 1; });
  ' "$BROKER_SOCKET" "$EVIDENCE_ROOT/reboot.json"
  HOST_REBOOT_COMMIT_STATE=confirmed
  cleanup_unit16
  BROKER_PID=
  PRIVATE_ROOT=
  exit 0
fi
