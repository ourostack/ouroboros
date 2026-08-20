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
      (
      AUDIT_CONTAINER=$1
      AUDIT_EXPECTED_IMAGE=$2
      INSPECT_DIR=$(mktemp -d /mnt/user/appdata/ouro-butler/staging/inspect.XXXXXX) || return $?
      trap 'rm -f -- "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json"; rmdir -- "$INSPECT_DIR"' EXIT || return $?
      chmod 0700 "$INSPECT_DIR" || return $?
      umask 077 || return $?
      docker inspect "$AUDIT_CONTAINER" >"$INSPECT_DIR/container.json" || return $?
      docker image inspect "$AUDIT_EXPECTED_IMAGE" >"$INSPECT_DIR/image.json" || return $?
      chmod 0600 "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json" || return $?
      docker run --rm --pull=never --network=none \
        --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
        --mount "type=bind,src=$INSPECT_DIR/container.json,dst=/audit/container.json,readonly" \
        --mount "type=bind,src=$INSPECT_DIR/image.json,dst=/audit/image.json,readonly" \
        "$IMAGE_ID" --inspect /audit/container.json --image-inspect /audit/image.json --expected-image "$AUDIT_EXPECTED_IMAGE" || return $?
      rm -f -- "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json" || return $?
      rmdir -- "$INSPECT_DIR" || return $?
      trap - EXIT || return $?
      )
    }
  Define these helpers in the same root shell. Each autostart change refuses an
  unexpected file, atomically replaces it through a same-directory temporary
  file, fsyncs the replacement and directory, and reads back the exact result:
    disable_butler_autostart() {
      (
      AUTOSTART_FILE=/var/lib/docker/unraid-autostart
      test -f "$AUTOSTART_FILE" || return $?
      AUTOSTART_METADATA=$(stat -c '%u:%g %a' "$AUTOSTART_FILE") || return $?
      test "$AUTOSTART_METADATA" = "0:0 644" || return $?
      AUTOSTART_TMP=$(mktemp "${AUTOSTART_FILE}.tmp.XXXXXX") || return $?
      trap 'rm -f -- "$AUTOSTART_TMP"' EXIT || return $?
      awk '$0 != "ouro-butler" && $0 != "ouro-butler-staging" && $0 != "ouro-butler-rollback"' "$AUTOSTART_FILE" >"$AUTOSTART_TMP" || return $?
      chown 0:0 "$AUTOSTART_TMP" || return $?
      chmod 0644 "$AUTOSTART_TMP" || return $?
      sync -f "$AUTOSTART_TMP" || return $?
      mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE" || return $?
      sync -f /var/lib/docker || return $?
      trap - EXIT || return $?
      AUTOSTART_COUNTS=$(awk '
        $0 == "ouro-butler" { production++ }
        $0 == "ouro-butler-staging" { staging++ }
        $0 == "ouro-butler-rollback" { rollback++ }
        END { printf "%d %d %d", production + 0, staging + 0, rollback + 0 }
      ' "$AUTOSTART_FILE") || return $?
      test "$AUTOSTART_COUNTS" = "0 0 0" || return $?
      )
    }
    enable_butler_autostart() {
      (
      AUTOSTART_FILE=/var/lib/docker/unraid-autostart
      test -f "$AUTOSTART_FILE" || return $?
      AUTOSTART_METADATA=$(stat -c '%u:%g %a' "$AUTOSTART_FILE") || return $?
      test "$AUTOSTART_METADATA" = "0:0 644" || return $?
      AUTOSTART_TMP=$(mktemp "${AUTOSTART_FILE}.tmp.XXXXXX") || return $?
      trap 'rm -f -- "$AUTOSTART_TMP"' EXIT || return $?
      awk '$0 != "ouro-butler" && $0 != "ouro-butler-staging" && $0 != "ouro-butler-rollback"' "$AUTOSTART_FILE" >"$AUTOSTART_TMP" || return $?
      printf '%s\n' ouro-butler >>"$AUTOSTART_TMP" || return $?
      chown 0:0 "$AUTOSTART_TMP" || return $?
      chmod 0644 "$AUTOSTART_TMP" || return $?
      sync -f "$AUTOSTART_TMP" || return $?
      mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE" || return $?
      sync -f /var/lib/docker || return $?
      trap - EXIT || return $?
      AUTOSTART_COUNTS=$(awk '
        $0 == "ouro-butler" { production++ }
        $0 == "ouro-butler-staging" { staging++ }
        $0 == "ouro-butler-rollback" { rollback++ }
        END { printf "%d %d %d", production + 0, staging + 0, rollback + 0 }
      ' "$AUTOSTART_FILE") || return $?
      test "$AUTOSTART_COUNTS" = "1 0 0" || return $?
      )
    }
  This bounded wait accepts only Docker's healthy state. The image healthcheck
  verifies fresh daemon state plus exactly one managed Telegram process and one
  managed scheduler process. It fails immediately on an exited, dead, or
  unhealthy container and times out after four minutes:
    wait_butler_ready() {
      WAIT_CONTAINER=$1
      WAIT_NOW=$(date +%s) || return $?
      WAIT_DEADLINE=$(( WAIT_NOW + 240 ))
      while :; do
        WAIT_NOW=$(date +%s) || return $?
        test "$WAIT_NOW" -lt "$WAIT_DEADLINE" || break
        WAIT_STATE=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$WAIT_CONTAINER") || return $?
        if test "$WAIT_STATE" = "running healthy"; then
          return 0
        fi
        case "$WAIT_STATE" in
          exited\ *|dead\ *|*\ unhealthy) return 1 ;;
        esac
        sleep 5 || return $?
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
  result before stopping production. First resolve and validate the exact image
  ID of the known-good production container while it is still running, so a
  lookup failure cannot strand a renamed container:
    ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
    printf '%s\n' "$ROLLBACK_IMAGE_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'
    docker image inspect "$ROLLBACK_IMAGE_ID" >/dev/null
  Guard the atomic autostart disable separately. If it fails, production has not
  been touched and the captured status is propagated:
    if disable_butler_autostart; then
      :
    else
      AUTOSTART_DISABLE_STATUS=$?
      (exit "$AUTOSTART_DISABLE_STATUS")
    fi
  Define the stale-rollback cleanup used by the preparation guard:
    remove_stopped_rollback_if_present() {
      ROLLBACK_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      case "
$ROLLBACK_CONTAINER_NAMES
" in
        *"
ouro-butler-rollback
"*)
        ROLLBACK_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback) || return $?
        test "$ROLLBACK_RUNNING" = false || return $?
        docker rm ouro-butler-rollback || return $?
        ;;
      esac
    }
  Stop production, remove only a stopped stale rollback, rename the known-good
  container, and verify it remains stopped in one explicit preparation guard:
    if docker stop ouro-butler \
      && remove_stopped_rollback_if_present \
      && docker rename ouro-butler ouro-butler-rollback \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false; then
      :
    else
      PRODUCTION_PREPARATION_STATUS=$?
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
          docker stop ouro-butler-rollback >/dev/null 2>&1 || true
          docker rm --force ouro-butler-rollback >/dev/null 2>&1 || true
        fi
        ! docker container inspect ouro-butler-rollback >/dev/null 2>&1
        audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
        docker start ouro-butler
        wait_butler_ready ouro-butler
        enable_butler_autostart
      elif docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
        docker stop ouro-butler-rollback >/dev/null 2>&1 || true
        test "$(docker inspect --format '{{.Image}}' ouro-butler-rollback)" = "$ROLLBACK_IMAGE_ID"
        docker rename ouro-butler-rollback ouro-butler
        audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
        docker start ouro-butler
        wait_butler_ready ouro-butler
        enable_butler_autostart
      fi
      (exit "$PRODUCTION_PREPARATION_STATUS")
    fi
  Preparation failure therefore either restores the still-named exact production
  after removing any stale rollback, or renames the exact stopped rollback back;
  both recoveries re-audit, start, bounded-wait, atomically restore production-only
  autostart, and propagate the original failure. If neither exact container can
  be found, the failure propagates with Butler autostart disabled.
  Put the entire post-rename staging phase in one explicit conditional so
  `set -eu` cannot bypass rollback at the create, effective-audit, start, or
  bounded-readiness boundary. Staging uses the exact image ID with no command,
  environment, port, device, capability, privilege, or extra mount override.
  A passing staging container is stopped and removed inside the same condition,
  completing the poller handoff before production creation:
    if docker create --name ouro-butler-staging --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      "$IMAGE_ID" \
      && audit_effective ouro-butler-staging "$IMAGE_ID" \
      && docker start ouro-butler-staging \
      && wait_butler_ready ouro-butler-staging \
      && docker stop ouro-butler-staging \
      && docker rm ouro-butler-staging; then
      :
    else
      STAGING_ACTIVATION_STATUS=$?
      if docker container inspect ouro-butler-staging >/dev/null 2>&1; then
        docker stop ouro-butler-staging >/dev/null 2>&1 || true
        docker rm --force ouro-butler-staging >/dev/null 2>&1 || true
      fi
      ! docker container inspect ouro-butler-staging >/dev/null 2>&1
      docker rename ouro-butler-rollback ouro-butler
      audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
      docker start ouro-butler
      wait_butler_ready ouro-butler
      enable_butler_autostart
      (exit "$STAGING_ACTIVATION_STATUS")
    fi
  The failure arm safely handles staging that was never created, remains
  stopped, is running, or exited: it force-removes any partial staging state,
  verifies the name is absent, restores and re-audits the old production against
  its exact pre-recorded image ID, starts and bounded-waits it, atomically
  restores production-only autostart, and propagates the original failure.
  At no point may production and staging run together against the same Telegram token.
  Create and activate production from the same exact image ID and exact authority
  in one explicit conditional so `set -eu` cannot exit before rollback. Only a
  successful create, effective audit, start, stopped rollback assertion, and
  bounded readiness wait may enable production autostart. Any failure captures
  the activation status, safely removes a partially created new production if it
  exists, restores the stopped rollback container, audits it against its exact
  old image ID, proves it ready, atomically enables only production autostart,
  and then propagates the original activation failure:
    if docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      "$IMAGE_ID" \
      && audit_effective ouro-butler "$IMAGE_ID" \
      && docker start ouro-butler \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false \
      && wait_butler_ready ouro-butler \
      && enable_butler_autostart; then
      :
    else
      PRODUCTION_ACTIVATION_STATUS=$?
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        docker stop ouro-butler >/dev/null 2>&1 || true
        docker rm --force ouro-butler >/dev/null 2>&1 || true
      fi
      ! docker container inspect ouro-butler >/dev/null 2>&1
      ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)
      printf '%s\n' "$ROLLBACK_IMAGE_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'
      docker image inspect "$ROLLBACK_IMAGE_ID" >/dev/null
      docker rename ouro-butler-rollback ouro-butler
      audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
      docker start ouro-butler
      wait_butler_ready ouro-butler
      enable_butler_autostart
      (exit "$PRODUCTION_ACTIVATION_STATUS")
    fi
  Keep ouro-butler-rollback stopped until the new production container is proven
  or the explicit rollback arm restores it.
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
  Guard the atomic autostart disable before stopping or removing any Butler
  container. Failure propagates while the existing production remains untouched:
    if disable_butler_autostart; then
      :
    else
      RESTORE_AUTOSTART_DISABLE_STATUS=$?
      (exit "$RESTORE_AUTOSTART_DISABLE_STATUS")
    fi
  Stop and remove only ouro-butler, restore both roots without stale files,
  restore exact ownership, validate the image, and create/audit/start/bounded-wait
  the restored production inside one explicit condition. The initial tolerant
  stop plus inspected force-removal safely handles an already absent or stopped
  container:
    if { docker stop ouro-butler >/dev/null 2>&1 || true; } \
      && {
        if docker container inspect ouro-butler >/dev/null 2>&1; then
          docker rm --force ouro-butler
        else
          :
        fi
      } \
      && ! docker container inspect ouro-butler >/dev/null 2>&1 \
      && rsync -a --delete "$BACKUP_ROOT/runtime/.ouro-cli/" /mnt/user/appdata/ouro-butler/runtime/.ouro-cli/ \
      && rsync -a --delete "$BACKUP_ROOT/agent/sanctuary.ouro/" /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/ \
      && chown -R 10001:10001 /mnt/user/appdata/ouro-butler/runtime/.ouro-cli /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro \
      && docker image inspect "$IMAGE_ID" >/dev/null \
      && docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      "$IMAGE_ID" \
      && audit_effective ouro-butler "$IMAGE_ID" \
      && docker start ouro-butler \
      && wait_butler_ready ouro-butler \
      && enable_butler_autostart; then
      :
    else
      RESTORE_ACTIVATION_STATUS=$?
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        docker stop ouro-butler >/dev/null 2>&1 || true
        docker rm --force ouro-butler >/dev/null 2>&1 || true
      fi
      ! docker container inspect ouro-butler >/dev/null 2>&1
      (exit "$RESTORE_ACTIVATION_STATUS")
    fi
  A restore has no retained old container or pre-restore data root to roll back
  to. Any stop/remove, data replacement, ownership, image validation, create,
  audit, start, or readiness failure therefore reaches the same cleanup arm,
  leaves all Butler autostart entries disabled, and propagates the captured
  failure for operator repair or a verified restore retry.

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
