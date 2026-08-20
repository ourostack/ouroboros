Mendelow Cloud Butler operator runbook

The production container is ouro-butler. It runs as UID/GID 10001, publishes no
ports, uses host networking only so its loopback-only Unraid GraphQL client can
reach 127.0.0.1, mounts only the runtime and sanctuary.ouro bundle paths from
the Unraid template, and uses restart policy unless-stopped.

Start/stop:
  docker start ouro-butler
  docker stop ouro-butler

Status and health:
  docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' ouro-butler
  docker logs --tail 200 ouro-butler

Effective-spec audit helper:
  Run Update and Restore command sequences from a root shell with `set -eu`.
  Before either sequence, define this helper. It captures one actual container
  inspect and its reviewed image inspect without printing either, invokes the
  packaged auditor from IMAGE_ID, and removes its mode-0600 inputs on success
  or shell exit:
    audit_effective() {
      AUDIT_CONTAINER=$1
      AUDIT_EXPECTED_IMAGE=$2
      INSPECT_DIR=$(mktemp -d /mnt/user/appdata/ouro-butler/staging/inspect.XXXXXX)
      chmod 0700 "$INSPECT_DIR"
      trap 'rm -f -- "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json"; rmdir -- "$INSPECT_DIR"' EXIT
      umask 077
      docker inspect "$AUDIT_CONTAINER" >"$INSPECT_DIR/container.json"
      docker image inspect "$AUDIT_EXPECTED_IMAGE" >"$INSPECT_DIR/image.json"
      chmod 0600 "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json"
      docker run --rm --pull=never --network=none \
        --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
        --mount "type=bind,src=$INSPECT_DIR/container.json,dst=/audit/container.json,readonly" \
        --mount "type=bind,src=$INSPECT_DIR/image.json,dst=/audit/image.json,readonly" \
        "$IMAGE_ID" --inspect /audit/container.json --image-inspect /audit/image.json --expected-image "$AUDIT_EXPECTED_IMAGE"
      rm -f -- "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json"
      rmdir -- "$INSPECT_DIR"
      trap - EXIT
    }
  Define these helpers in the same root shell. Each autostart change refuses an
  unexpected file, atomically replaces it through a same-directory temporary
  file, fsyncs the replacement and directory, and reads back the exact result:
    disable_butler_autostart() {
      AUTOSTART_FILE=/var/lib/docker/unraid-autostart
      test -f "$AUTOSTART_FILE"
      test "$(stat -c '%u:%g %a' "$AUTOSTART_FILE")" = "0:0 644"
      AUTOSTART_TMP=$(mktemp "${AUTOSTART_FILE}.tmp.XXXXXX")
      trap 'rm -f -- "$AUTOSTART_TMP"' EXIT
      awk '$0 != "ouro-butler" && $0 != "ouro-butler-staging" && $0 != "ouro-butler-rollback"' "$AUTOSTART_FILE" >"$AUTOSTART_TMP"
      chown 0:0 "$AUTOSTART_TMP"
      chmod 0644 "$AUTOSTART_TMP"
      sync -f "$AUTOSTART_TMP"
      mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE"
      sync -f /var/lib/docker
      trap - EXIT
      ! grep -Fxq "ouro-butler" "$AUTOSTART_FILE"
      ! grep -Fxq "ouro-butler-staging" "$AUTOSTART_FILE"
      ! grep -Fxq "ouro-butler-rollback" "$AUTOSTART_FILE"
    }
    enable_butler_autostart() {
      AUTOSTART_FILE=/var/lib/docker/unraid-autostart
      test -f "$AUTOSTART_FILE"
      test "$(stat -c '%u:%g %a' "$AUTOSTART_FILE")" = "0:0 644"
      AUTOSTART_TMP=$(mktemp "${AUTOSTART_FILE}.tmp.XXXXXX")
      trap 'rm -f -- "$AUTOSTART_TMP"' EXIT
      awk '$0 != "ouro-butler" && $0 != "ouro-butler-staging" && $0 != "ouro-butler-rollback"' "$AUTOSTART_FILE" >"$AUTOSTART_TMP"
      printf '%s\n' ouro-butler >>"$AUTOSTART_TMP"
      chown 0:0 "$AUTOSTART_TMP"
      chmod 0644 "$AUTOSTART_TMP"
      sync -f "$AUTOSTART_TMP"
      mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE"
      sync -f /var/lib/docker
      trap - EXIT
      test "$(grep -Fxc "ouro-butler" "$AUTOSTART_FILE")" = 1
      ! grep -Fxq "ouro-butler-staging" "$AUTOSTART_FILE"
      ! grep -Fxq "ouro-butler-rollback" "$AUTOSTART_FILE"
    }
  This bounded wait accepts only Docker's healthy state. The image healthcheck
  verifies fresh daemon state plus exactly one managed Telegram process and one
  managed scheduler process. It fails immediately on an exited, dead, or
  unhealthy container and times out after four minutes:
    wait_butler_ready() {
      WAIT_CONTAINER=$1
      WAIT_DEADLINE=$(( $(date +%s) + 240 ))
      while test "$(date +%s)" -lt "$WAIT_DEADLINE"; do
        WAIT_STATE=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$WAIT_CONTAINER")
        test "$WAIT_STATE" = "running healthy" && return 0
        case "$WAIT_STATE" in
          exited\ *|dead\ *|*\ unhealthy) return 1 ;;
        esac
        sleep 5
      done
      return 1
    }

Update:
  Build and verify a new ouro-butler:<version> image first. The tag is only a
  lookup handle and never authorizes container creation. Resolve and validate
  the exact local Docker image ID before staging:
    IMAGE_TAG=ouro-butler:<version>
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
    printf '%s\n' "$IMAGE_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'
    docker image inspect "$IMAGE_ID" >/dev/null
  Stage copies of the packaged template and runtime policy at these paths:
    STAGED_TEMPLATE=/mnt/user/appdata/ouro-butler/staging/sanctuary.xml
    STAGED_RUNTIME_POLICY=/mnt/user/appdata/ouro-butler/staging/container-runtime.json
  Replace sha256:REPLACE_WITH_EXACT_LOCAL_IMAGE_ID in the staged template at
  $STAGED_TEMPLATE with exactly $IMAGE_ID. Before docker create, run the
  packaged auditor from that exact image ID with both staged inputs mounted
  read-only:
    docker run --rm --pull=never --network=none \
      --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
      --mount "type=bind,src=$STAGED_TEMPLATE,dst=/audit/sanctuary.xml,readonly" \
      --mount "type=bind,src=$STAGED_RUNTIME_POLICY,dst=/audit/container-runtime.json,readonly" \
      "$IMAGE_ID" --template /audit/sanctuary.xml --runtime-policy /audit/container-runtime.json --expected-image "$IMAGE_ID"
  Disable every Butler name in Unraid's array-autostart file and verify that
  result before stopping production:
    disable_butler_autostart
  Stop production and retain that known-good container as the rollback target:
    docker stop ouro-butler
    if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
      test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false
      docker rm ouro-butler-rollback
    fi
    docker rename ouro-butler ouro-butler-rollback
    test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false
  Create staging from the exact image ID with no command, environment, port,
  device, capability, privilege, or extra mount override:
    docker create --name ouro-butler-staging --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      "$IMAGE_ID"
  Before start, audit the actual effective staging spec:
    audit_effective ouro-butler-staging "$IMAGE_ID"
  Only after that effective audit passes, start staging:
    docker start ouro-butler-staging
    wait_butler_ready ouro-butler-staging
  At no point may production and staging run together against the same Telegram token.
  If staging fails its health or Telegram checks, stop and remove staging,
  then restore the stopped known-good container:
    docker stop ouro-butler-staging
    docker rm ouro-butler-staging
    docker rename ouro-butler-rollback ouro-butler
    ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
    audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
    docker start ouro-butler
    wait_butler_ready ouro-butler
    enable_butler_autostart
  If staging passes, stop and remove it. This is the poller handoff boundary:
    docker stop ouro-butler-staging
    docker rm ouro-butler-staging
  Create production from the same exact image ID and exact authority:
    docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      "$IMAGE_ID"
  Audit the actual effective production spec before starting it, then require
  healthy Telegram readiness while rollback remains stopped:
    audit_effective ouro-butler "$IMAGE_ID"
    docker start ouro-butler
    test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false
    wait_butler_ready ouro-butler
  Only after production acceptance, atomically enable exactly ouro-butler in
  Unraid array autostart and read back the exact result:
    enable_butler_autostart
  Keep ouro-butler-rollback stopped until the new production container is proven.
  Never create a container from the mutable lookup tag.

Backup:
  Stop ouro-butler, then snapshot both of these directories together:
    /mnt/user/appdata/ouro-butler/runtime/.ouro-cli
    /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
  A routine backup must not contain container-credentials.json or
  container-credentials.json.consuming. If either exists, credential migration
  is pending or failed and must be reconciled before taking the backup.

Restore:
  Set BACKUP_ROOT to the exact verified snapshot containing `runtime/.ouro-cli`
  and `agent/sanctuary.ouro`, and set IMAGE_ID to its recorded local image ID.
  Disable/read back autostart before stopping or removing any Butler container.
  Stop and remove only ouro-butler, restore the two roots without retaining
  stale files, and restore exact ownership:
    disable_butler_autostart
    docker stop ouro-butler
    docker rm ouro-butler
    rsync -a --delete "$BACKUP_ROOT/runtime/.ouro-cli/" /mnt/user/appdata/ouro-butler/runtime/.ouro-cli/
    rsync -a --delete "$BACKUP_ROOT/agent/sanctuary.ouro/" /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/
    chown -R 10001:10001 /mnt/user/appdata/ouro-butler/runtime/.ouro-cli /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
    docker image inspect "$IMAGE_ID" >/dev/null
  Recreate with the exact production command, not a mutable tag:
    docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      "$IMAGE_ID"
  Audit the actual effective restored spec before starting it:
    audit_effective ouro-butler "$IMAGE_ID"
    docker start ouro-butler
    wait_butler_ready ouro-butler
  Only after healthy Telegram readiness, atomically enable and read back the
  exact production-only autostart entry:
    enable_butler_autostart

Credential recovery:
  Restore or unlock the Sanctuary agent vault, then run provider refresh.
  /mnt/user/appdata/ouro-butler/runtime/.ouro-cli/container-credentials.json
  exists only for a one-time migration: if
  used, install it atomically as root with ownership 10001:10001 and mode 0600.
  Startup atomically claims it as container-credentials.json.consuming and
  writes every credential class into the unlocked Sanctuary vault before deleting the claimed envelope.
  Only then does it refresh the daemon's in-memory credentials.
  If validation or any vault write fails, startup fails closed and preserves
  container-credentials.json.consuming for the next startup to reconcile.
  Restore or create/unlock the configured agent vault, then restart the same
  reviewed image and let it retry the preserved claim. If both the source and
  claimed envelope exist and they are safe regular 0600 files owned by the
  runtime user, startup resumes automatically only when they are byte-for-byte identical:
  it durably removes the redundant unclaimed source and continues the existing claim.
  If they differ, the repair is human-required: stop the Butler, securely compare and quarantine
  the two envelopes, then restore exactly one reviewed envelope at the source path.
  Never print either envelope's contents or place them in logs or command arguments.
  After successful import, both files
  are absent and the vault is the only credential source of truth.
  Never print or place credential values in logs, templates, command arguments,
  backups, or this runbook.

Audit and safety verification:
  Inspect AgentBundles/sanctuary.ouro/state/approvals for durable approval and
  restart-attempt receipts. Confirm no Docker socket/device/host-root mounts and
  no published ports with docker inspect. Confirm Config.Image equals the exact
  reviewed local image ID, not the build tag. The read key must reject Docker
  stop and restart mutations; only the separate write key may perform the one
  typed approved restart action.
