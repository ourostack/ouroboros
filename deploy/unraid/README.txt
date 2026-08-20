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
      awk '$1 != "ouro-butler" && $1 != "ouro-butler-staging" && $1 != "ouro-butler-rollback" && $1 != "ouro-butler-legacy-evidence"' "$AUTOSTART_FILE" >"$AUTOSTART_TMP" || return $?
      chown 0:0 "$AUTOSTART_TMP" || return $?
      chmod 0644 "$AUTOSTART_TMP" || return $?
      sync -f "$AUTOSTART_TMP" || return $?
      mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE" || return $?
      sync -f /var/lib/docker || return $?
      trap - EXIT || return $?
      AUTOSTART_COUNTS=$(awk '
        $1 == "ouro-butler" { production++ }
        $1 == "ouro-butler-staging" { staging++ }
        $1 == "ouro-butler-rollback" { rollback++ }
        $1 == "ouro-butler-legacy-evidence" { legacy++ }
        END { printf "%d %d %d %d", production + 0, staging + 0, rollback + 0, legacy + 0 }
      ' "$AUTOSTART_FILE") || return $?
      test "$AUTOSTART_COUNTS" = "0 0 0 0" || return $?
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
      awk '$1 != "ouro-butler" && $1 != "ouro-butler-staging" && $1 != "ouro-butler-rollback" && $1 != "ouro-butler-legacy-evidence"' "$AUTOSTART_FILE" >"$AUTOSTART_TMP" || return $?
      printf '%s\n' ouro-butler >>"$AUTOSTART_TMP" || return $?
      chown 0:0 "$AUTOSTART_TMP" || return $?
      chmod 0644 "$AUTOSTART_TMP" || return $?
      sync -f "$AUTOSTART_TMP" || return $?
      mv -f -- "$AUTOSTART_TMP" "$AUTOSTART_FILE" || return $?
      sync -f /var/lib/docker || return $?
      trap - EXIT || return $?
      AUTOSTART_COUNTS=$(awk '
        $1 == "ouro-butler" { production++ }
        $1 == "ouro-butler-staging" { staging++ }
        $1 == "ouro-butler-rollback" { rollback++ }
        $1 == "ouro-butler-legacy-evidence" { legacy++ }
        END { printf "%d %d %d %d", production + 0, staging + 0, rollback + 0, legacy + 0 }
      ' "$AUTOSTART_FILE") || return $?
      test "$AUTOSTART_COUNTS" = "1 0 0 0" || return $?
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
  Define these fail-closed image and topology helpers in the same shell. They use
  exact Docker image IDs and exact container names; no mutation is performed:
    validate_exact_image_id() {
      VALIDATE_IMAGE_ID=$1
      case "$VALIDATE_IMAGE_ID" in
        sha256:*) VALIDATE_IMAGE_HEX=${VALIDATE_IMAGE_ID#sha256:} ;;
        *) return 1 ;;
      esac
      test "${#VALIDATE_IMAGE_HEX}" -eq 64 || return $?
      case "$VALIDATE_IMAGE_HEX" in
        *[!0-9a-f]*) return 1 ;;
      esac
      docker image inspect "$VALIDATE_IMAGE_ID" >/dev/null || return $?
    }
    assert_only_running_butler() {
      EXPECTED_RUNNING_BUTLER=$1
      RUNNING_BUTLER_NAMES=$(docker container ls --format '{{.Names}}') || return $?
      RUNNING_BUTLER_COUNTS=$(printf '%s\n' "$RUNNING_BUTLER_NAMES" | awk -v expected="$EXPECTED_RUNNING_BUTLER" '
        {
          if ($0 == "ouro-butler" || $0 == "ouro-butler-staging" || $0 == "ouro-butler-rollback" || $0 == "ouro-butler-legacy-evidence") {
            butlers++
            if ($0 == expected) matching++
          }
        }
        END { printf "%d %d", butlers + 0, matching + 0 }
      ') || return $?
      test "$RUNNING_BUTLER_COUNTS" = "1 1" || return $?
    }
    assert_update_topology() {
      EXPECTED_ROLLBACK_IMAGE_ID=$1
      UPDATE_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      UPDATE_NAME_COUNTS=$(printf '%s\n' "$UPDATE_CONTAINER_NAMES" | awk '
        $0 == "ouro-butler" { production++ }
        $0 == "ouro-butler-staging" { staging++ }
        $0 == "ouro-butler-rollback" { rollback++ }
        $0 == "ouro-butler-legacy-evidence" { legacy++ }
        END {
          printf "%d %d %d %d", production + 0, staging + 0, rollback + 0, legacy + 0
        }
      ') || return $?
      case "$UPDATE_NAME_COUNTS" in
        "1 0 0 0"|"1 0 1 0"|"1 0 0 1"|"1 0 1 1") ;;
        *) return 1 ;;
      esac
      UPDATE_PRODUCTION_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler) || return $?
      test "$UPDATE_PRODUCTION_RUNNING" = true || return $?
      UPDATE_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
      test "$UPDATE_PRODUCTION_IMAGE_ID" = "$EXPECTED_ROLLBACK_IMAGE_ID" || return $?
      case "$UPDATE_NAME_COUNTS" in
        "1 0 1 0"|"1 0 1 1")
        UPDATE_ROLLBACK_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback) || return $?
        test "$UPDATE_ROLLBACK_RUNNING" = false || return $?
        UPDATE_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback) || return $?
        test "$UPDATE_ROLLBACK_IMAGE_ID" = "$EXPECTED_ROLLBACK_IMAGE_ID" || return $?
        ;;
      esac
      case "$UPDATE_NAME_COUNTS" in
        "1 0 0 1"|"1 0 1 1")
        UPDATE_LEGACY_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence) || return $?
        test "$UPDATE_LEGACY_RUNNING" = false || return $?
        UPDATE_LEGACY_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) || return $?
        validate_exact_image_id "$UPDATE_LEGACY_IMAGE_ID" || return $?
        ;;
      esac
      assert_only_running_butler ouro-butler || return $?
    }
    assert_restore_preflight() {
      (
      test -n "${BACKUP_ROOT-}" || return 1
      test -n "${IMAGE_ID-}" || return 1
      case "$BACKUP_ROOT" in
        /*) ;;
        *) return 1 ;;
      esac
      test "$BACKUP_ROOT" != / || return $?
      RESTORE_BACKUP_ROOT=$(cd -- "$BACKUP_ROOT" && pwd -P) || return $?
      test "$RESTORE_BACKUP_ROOT" = "$BACKUP_ROOT" || return $?
      test -d "$BACKUP_ROOT/runtime/.ouro-cli" || return $?
      test -d "$BACKUP_ROOT/agent/sanctuary.ouro" || return $?
      validate_exact_image_id "$IMAGE_ID" || return $?
      RESTORE_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      RESTORE_NAME_COUNTS=$(printf '%s\n' "$RESTORE_CONTAINER_NAMES" | awk '
        $0 == "ouro-butler" { production++ }
        $0 == "ouro-butler-staging" { staging++ }
        $0 == "ouro-butler-rollback" { rollback++ }
        $0 == "ouro-butler-legacy-evidence" { legacy++ }
        END {
          printf "%d %d %d %d", production + 0, staging + 0, rollback + 0, legacy + 0
        }
      ') || return $?
      case "$RESTORE_NAME_COUNTS" in
        "1 0 0 0"|"1 0 0 1") ;;
        *) return 1 ;;
      esac
      RESTORE_PRODUCTION_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler) || return $?
      test "$RESTORE_PRODUCTION_RUNNING" = true || return $?
      RESTORE_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
      validate_exact_image_id "$RESTORE_PRODUCTION_IMAGE_ID" || return $?
      if test "$RESTORE_NAME_COUNTS" = "1 0 0 1"; then
        RESTORE_LEGACY_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence) || return $?
        test "$RESTORE_LEGACY_RUNNING" = false || return $?
        RESTORE_LEGACY_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) || return $?
        validate_exact_image_id "$RESTORE_LEGACY_IMAGE_ID" || return $?
      fi
      assert_only_running_butler ouro-butler || return $?
      )
    }
    install_from_legacy_staging() {
      ADOPTION_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      ADOPTION_NAME_COUNTS=$(printf '%s\n' "$ADOPTION_CONTAINER_NAMES" | awk '
        $0 == "ouro-butler" { production++ }
        $0 == "ouro-butler-staging" { staging++ }
        $0 == "ouro-butler-rollback" { rollback++ }
        $0 == "ouro-butler-legacy-evidence" { legacy++ }
        END {
          printf "%d %d %d %d", production + 0, staging + 0, rollback + 0, legacy + 0
        }
      ') || return $?
      test "$ADOPTION_NAME_COUNTS" = "0 1 0 0" || return $?
      assert_only_running_butler ouro-butler-staging || return $?
      LEGACY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging) || return $?
      validate_exact_image_id "$LEGACY_STAGING_IMAGE_ID" || return $?
      validate_exact_image_id "$IMAGE_ID" || return $?
      LEGACY_EVIDENCE_ROOT=/mnt/user/appdata/ouro-butler/legacy-evidence
      LEGACY_EVIDENCE_DIR="$LEGACY_EVIDENCE_ROOT/${LEGACY_STAGING_IMAGE_ID#sha256:}"
      install -d -m 0700 -o 10001 -g 10001 /mnt/user/appdata/ouro-butler/runtime/.ouro-cli || return $?
      install -d -m 0700 -o 10001 -g 10001 /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro || return $?
      install -d -m 0700 -o 0 -g 0 "$LEGACY_EVIDENCE_ROOT" || return $?
      mkdir -m 0700 "$LEGACY_EVIDENCE_DIR" || return $?
      docker container inspect ouro-butler-staging >"$LEGACY_EVIDENCE_DIR/container.json" || return $?
      docker image inspect "$LEGACY_STAGING_IMAGE_ID" >"$LEGACY_EVIDENCE_DIR/image.json" || return $?
      chmod 0600 "$LEGACY_EVIDENCE_DIR/container.json" "$LEGACY_EVIDENCE_DIR/image.json" || return $?
      sync -f "$LEGACY_EVIDENCE_DIR/container.json" || return $?
      sync -f "$LEGACY_EVIDENCE_DIR/image.json" || return $?
      sync -f "$LEGACY_EVIDENCE_DIR" || return $?
      disable_butler_autostart || return $?
      if docker stop ouro-butler-staging \
        && CURRENT_LEGACY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging) \
        && test "$CURRENT_LEGACY_STAGING_IMAGE_ID" = "$LEGACY_STAGING_IMAGE_ID" \
        && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-staging)" = false \
        && docker rename ouro-butler-staging ouro-butler-legacy-evidence \
        && CURRENT_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) \
        && test "$CURRENT_LEGACY_EVIDENCE_IMAGE_ID" = "$LEGACY_STAGING_IMAGE_ID" \
        && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence)" = false \
        && docker create --name ouro-butler-staging --network host --restart unless-stopped --user 10001:10001 \
          --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
          --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
          "$IMAGE_ID" \
        && audit_effective ouro-butler-staging "$IMAGE_ID" \
        && docker start ouro-butler-staging \
        && assert_only_running_butler ouro-butler-staging \
        && wait_butler_ready ouro-butler-staging \
        && docker stop ouro-butler-staging \
        && test "$(docker inspect --format '{{.Image}}' ouro-butler-staging)" = "$IMAGE_ID" \
        && docker rm ouro-butler-staging \
        && docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
          --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
          --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
          "$IMAGE_ID" \
        && audit_effective ouro-butler "$IMAGE_ID" \
        && docker start ouro-butler \
        && assert_only_running_butler ouro-butler \
        && wait_butler_ready ouro-butler \
        && enable_butler_autostart; then
        return 0
      else
        ADOPTION_STATUS=$?
      fi
      ADOPTION_RECOVERY_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      case "
$ADOPTION_RECOVERY_NAMES
" in
        *"
ouro-butler
"*)
          ADOPTION_PARTIAL_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
          test "$ADOPTION_PARTIAL_IMAGE_ID" = "$IMAGE_ID" || return $?
          docker stop ouro-butler >/dev/null 2>&1 || true
          docker rm --force ouro-butler || return $?
          ;;
      esac
      ADOPTION_RECOVERY_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      case "
$ADOPTION_RECOVERY_NAMES
" in
        *"
ouro-butler-staging
"*)
          CURRENT_LEGACY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging) || return $?
          case "$CURRENT_LEGACY_STAGING_IMAGE_ID" in
            "$IMAGE_ID")
              docker stop ouro-butler-staging >/dev/null 2>&1 || true
              docker rm --force ouro-butler-staging || return $?
              ;;
            "$LEGACY_STAGING_IMAGE_ID")
              docker stop ouro-butler-staging >/dev/null 2>&1 || return $?
              test "$(docker inspect --format '{{.State.Running}}' ouro-butler-staging)" = false || return $?
              docker rename ouro-butler-staging ouro-butler-legacy-evidence || return $?
              ;;
            *) return 1 ;;
          esac
          ;;
      esac
      CURRENT_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) || return $?
      test "$CURRENT_LEGACY_EVIDENCE_IMAGE_ID" = "$LEGACY_STAGING_IMAGE_ID" || return $?
      test "$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence)" = false || return $?
      return "$ADOPTION_STATUS"
    }
    bootstrap_sanctuary_vault() {
      VAULT_STATUS=$(ouro vault status --agent sanctuary) || return $?
      case "
$VAULT_STATUS
" in
        *"
vault locator: not configured in agent.json
"*) ouro vault create --agent sanctuary || return $? ;;
        *"
vault locator: agent.json
"*) ouro vault unlock --agent sanctuary || return $? ;;
        *) return 1 ;;
      esac
      VERIFIED_VAULT_STATUS=$(ouro vault status --agent sanctuary) || return $?
      case "
$VERIFIED_VAULT_STATUS
" in
        *"
vault locator: agent.json
"*) ;;
        *) return 1 ;;
      esac
      case "
$VERIFIED_VAULT_STATUS
" in
        *"
local unlock: available
"*) ;;
        *) return 1 ;;
      esac
      ouro auth verify --agent sanctuary || return $?
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
  Initial install/adoption is a separate terminal path for the verified live
  legacy state: no production or rollback, exactly one running (possibly
  unhealthy) ouro-butler-staging, and no legacy-evidence container. Run this and
  stop; do not continue into the normal update below:
    install_from_legacy_staging
  That function never applies the canonical auditor to the known-noncanonical
  legacy container or restarts it. It verifies and pins the legacy image,
  provisions the absent canonical roots, and durably snapshots both exact
  container and image inspect records before disabling autostart or stopping
  anything. It then stops and rechecks the legacy container and renames it to
  stopped ouro-butler-legacy-evidence. A fresh canonical staging container is
  created from exact IMAGE_ID and canonical binds, audited, started, proven to
  be the only running Butler, readiness-checked, then stopped and removed only
  after its image is rechecked. Only then is fresh canonical production created,
  audited, started, readiness-checked, and placed in bare production autostart.
  Failure removes only partial target-image staging/production containers,
  quarantines the exact legacy container without deletion or restart, leaves
  autostart disabled, and propagates the original status.
  For a normal update, preflight the canonical topology before any autostart or
  container mutation. Production must be the only running Butler poller;
  staging must be absent; rollback may be absent or one stopped container with
  the exact production image. A stopped legacy-evidence container is preserved.
  Disable every Butler name in Unraid's array-autostart file and verify that
  result before stopping production. First resolve and validate the exact image
  ID of the known-good production container while it is still running, so a
  lookup failure cannot strand a renamed container:
    ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
    validate_exact_image_id "$ROLLBACK_IMAGE_ID"
    audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
    if assert_update_topology "$ROLLBACK_IMAGE_ID"; then
      :
    else
      UPDATE_PREFLIGHT_STATUS=$?
      (exit "$UPDATE_PREFLIGHT_STATUS")
    fi
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
      EXPECTED_STALE_ROLLBACK_IMAGE_ID=$1
      ROLLBACK_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      case "
$ROLLBACK_CONTAINER_NAMES
" in
        *"
ouro-butler-rollback
"*)
        ROLLBACK_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback) || return $?
        test "$ROLLBACK_RUNNING" = false || return $?
        CURRENT_STALE_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback) || return $?
        test "$CURRENT_STALE_ROLLBACK_IMAGE_ID" = "$EXPECTED_STALE_ROLLBACK_IMAGE_ID" || return $?
        docker rm ouro-butler-rollback || return $?
        ;;
      esac
    }
  Stop production, remove only a stopped stale rollback, rename the known-good
  container, and verify it remains stopped in one explicit preparation guard:
    if docker stop ouro-butler \
      && remove_stopped_rollback_if_present "$ROLLBACK_IMAGE_ID" \
      && docker rename ouro-butler ouro-butler-rollback \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false; then
      :
    else
      PRODUCTION_PREPARATION_STATUS=$?
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
          docker stop ouro-butler-rollback >/dev/null 2>&1 || true
          CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)
          test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"
          docker rm --force ouro-butler-rollback >/dev/null 2>&1 || true
        fi
        ! docker container inspect ouro-butler-rollback >/dev/null 2>&1
        audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
        docker start ouro-butler
        assert_only_running_butler ouro-butler
        wait_butler_ready ouro-butler
        enable_butler_autostart
      elif docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
        docker stop ouro-butler-rollback >/dev/null 2>&1 || true
        test "$(docker inspect --format '{{.Image}}' ouro-butler-rollback)" = "$ROLLBACK_IMAGE_ID"
        docker rename ouro-butler-rollback ouro-butler
        audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
        docker start ouro-butler
        assert_only_running_butler ouro-butler
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
      && assert_only_running_butler ouro-butler-staging \
      && wait_butler_ready ouro-butler-staging \
      && docker stop ouro-butler-staging \
      && docker rm ouro-butler-staging; then
      :
    else
      STAGING_ACTIVATION_STATUS=$?
      if docker container inspect ouro-butler-staging >/dev/null 2>&1; then
        docker stop ouro-butler-staging >/dev/null 2>&1 || true
        PARTIAL_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging)
        test "$PARTIAL_STAGING_IMAGE_ID" = "$IMAGE_ID"
        docker rm --force ouro-butler-staging >/dev/null 2>&1 || true
      fi
      ! docker container inspect ouro-butler-staging >/dev/null 2>&1
      CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)
      test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"
      docker rename ouro-butler-rollback ouro-butler
      audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
      docker start ouro-butler
      assert_only_running_butler ouro-butler
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
      && assert_only_running_butler ouro-butler \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false \
      && wait_butler_ready ouro-butler \
      && enable_butler_autostart; then
      :
    else
      PRODUCTION_ACTIVATION_STATUS=$?
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        docker stop ouro-butler >/dev/null 2>&1 || true
        PARTIAL_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
        test "$PARTIAL_PRODUCTION_IMAGE_ID" = "$IMAGE_ID"
        docker rm --force ouro-butler >/dev/null 2>&1 || true
      fi
      ! docker container inspect ouro-butler >/dev/null 2>&1
      CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)
      test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"
      docker rename ouro-butler-rollback ouro-butler
      audit_effective ouro-butler "$ROLLBACK_IMAGE_ID"
      docker start ouro-butler
      assert_only_running_butler ouro-butler
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
  Before any autostart, root, or container mutation, run the nounset-safe input,
  backup-root, image, and topology preflight. It requires a nonempty canonical
  absolute BACKUP_ROOT (not /), both exact required directories, an exact local
  sha256 image ID, canonical production as the only running Butler poller, no
  staging or rollback, and at most one exact stopped legacy-evidence container:
    if assert_restore_preflight; then
      :
    else
      RESTORE_PREFLIGHT_STATUS=$?
      (exit "$RESTORE_PREFLIGHT_STATUS")
    fi
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
      && assert_only_running_butler ouro-butler \
      && wait_butler_ready ouro-butler \
      && enable_butler_autostart; then
      :
    else
      RESTORE_ACTIVATION_STATUS=$?
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        docker stop ouro-butler >/dev/null 2>&1 || true
        PARTIAL_RESTORE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
        test "$PARTIAL_RESTORE_IMAGE_ID" = "$IMAGE_ID"
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
  The one canonical Telegram identity is display name `Mendelow Cloud Butler`,
  username `MendelowCloudButlerBot`, numeric bot ID `8541786263`. Treat any
  different display name, username, numeric ID, or fallback handle as a hard
  preflight failure; do not start polling or send a test message.
  Run bootstrap_sanctuary_vault interactively before installing credentials.
  Its first read-only `vault status` is authoritative: it runs `vault create`
  only when the locator is absent, runs `vault unlock` only when the locator
  already exists, then requires the configured locator, available local unlock,
  and successful auth verification. Never guess from a failed status command.
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
  Inventory Unraid API keys by exact immutable key ID before changing any key.
  Record only IDs, names, and permission sets; never raw key values. Verify the
  new read-only and bounded-write keys through their vault-backed Butler paths
  first: the read key must perform required reads and reject a harmless Docker
  mutation, while the write key must perform its one typed approved action and
  reject out-of-scope writes. Fail closed if inventory deltas are ambiguous,
  either expected key is missing/duplicated, or any unintended write-capable key
  exists. Only after those checks may the operator revoke the exact recorded
  legacy key ID. Re-inventory, prove that exact ID is absent, prove its old
  credential now receives an authentication rejection, and repeat the
  no-unintended-write-key audit. Do not pass raw keys in argv, files, shell
  history, or logs; verification adapters must read them directly from the
  Sanctuary vault.
