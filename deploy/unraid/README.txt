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
  Run Update, Backup, and Restore command sequences from a root shell with `set -eu`.
  Before any sequence, define this helper. It captures one actual container
  inspect and its reviewed image inspect without printing either, invokes the
  packaged auditor from the explicit validated runner image argument, and
  removes its mode-0600 inputs on success or shell exit:
    audit_effective() {
      (
      AUDIT_CONTAINER=$1
      AUDIT_EXPECTED_IMAGE=$2
      AUDIT_RUNNER_IMAGE_ID=$3
      AUDIT_MOUNT_CONTRACT=${4-canonical}
      validate_exact_image_id "$AUDIT_EXPECTED_IMAGE" || return $?
      validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID" || return $?
      test "$AUDIT_RUNNER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return $?
      case "$AUDIT_MOUNT_CONTRACT" in
        canonical) set -- ;;
        legacy-alpha742) set -- --mount-contract legacy-alpha742 ;;
        *) return 1 ;;
      esac
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
        "$AUDIT_RUNNER_IMAGE_ID" --inspect /audit/container.json --image-inspect /audit/image.json --expected-image "$AUDIT_EXPECTED_IMAGE" "$@" || return $?
      rm -f -- "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json" || return $?
      rmdir -- "$INSPECT_DIR" || return $?
      trap - EXIT || return $?
      )
    }
  Define these helpers in the same root shell. Each autostart change uses
  Unraid's authenticated loopback WebGUI endpoint with the live root-session
  CSRF token supplied only on request stdin. Requests have hard connection and
  total timeouts, discard response bodies, and read back the durable array
  autostart state without writing its backing file directly:
    set_butler_autostart() {
      (
      AUTOSTART_CONTAINER=$1
      AUTOSTART_ENABLED=$2
      case "$AUTOSTART_CONTAINER" in
        ouro-butler|ouro-butler-staging|ouro-butler-rollback|ouro-butler-legacy-evidence) ;;
        *) return 1 ;;
      esac
      case "$AUTOSTART_ENABLED" in true|false) ;; *) return 1 ;; esac
      AUTOSTART_CSRF_FILE=/var/local/emhttp/var.ini
      test -f "$AUTOSTART_CSRF_FILE" || return $?
      AUTOSTART_CSRF_TOKEN=$(awk -F= '$1 == "csrf_token" {
        value = $2
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        print value
      }' "$AUTOSTART_CSRF_FILE") || return $?
      test -n "$AUTOSTART_CSRF_TOKEN" || return $?
      case "$AUTOSTART_CSRF_TOKEN" in *[!A-Za-z0-9._-]*) return 1 ;; esac
      printf '%s' "action=autostart&container=$AUTOSTART_CONTAINER&auto=$AUTOSTART_ENABLED&wait=0&csrf_token=$AUTOSTART_CSRF_TOKEN" | \
        curl --silent --show-error --fail --request POST \
          --connect-timeout 5 --max-time 15 \
          --header 'Content-Type: application/x-www-form-urlencoded' \
          --data-binary @- --output /dev/null \
          http://127.0.0.1/plugins/dynamix.docker.manager/include/UpdateConfig.php || return $?
      )
    }
    butler_autostart_counts() {
      (
      AUTOSTART_FILE=/var/lib/docker/unraid-autostart
      test -f "$AUTOSTART_FILE" || return $?
      awk '
        $1 == "ouro-butler" { production++ }
        $1 == "ouro-butler-staging" { staging++ }
        $1 == "ouro-butler-rollback" { rollback++ }
        $1 == "ouro-butler-legacy-evidence" { legacy++ }
        END { printf "%d %d %d %d", production + 0, staging + 0, rollback + 0, legacy + 0 }
      ' "$AUTOSTART_FILE"
      )
    }
    verify_butler_autostart() {
      (
      EXPECTED_AUTOSTART_COUNTS=$1
      AUTOSTART_COUNTS=$(butler_autostart_counts) || return $?
      test "$AUTOSTART_COUNTS" = "$EXPECTED_AUTOSTART_COUNTS" || return $?
      )
    }
    disable_butler_autostart() {
      set_butler_autostart ouro-butler-staging false || return $?
      set_butler_autostart ouro-butler-rollback false || return $?
      set_butler_autostart ouro-butler-legacy-evidence false || return $?
      set_butler_autostart ouro-butler false || return $?
      verify_butler_autostart "0 0 0 0" || return $?
    }
    enable_butler_autostart() {
      set_butler_autostart ouro-butler-staging false || return $?
      set_butler_autostart ouro-butler-rollback false || return $?
      set_butler_autostart ouro-butler-legacy-evidence false || return $?
      set_butler_autostart ouro-butler true || return $?
      verify_butler_autostart "1 0 0 0" || return $?
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
    assert_legacy_alpha742_source() {
      EXPECTED_SOURCE_IMAGE_ID=$1
      AUDIT_RUNNER_IMAGE_ID=$2
      test "$EXPECTED_SOURCE_IMAGE_ID" = sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return $?
      audit_effective ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" legacy-alpha742
    }
    assert_update_source() {
      EXPECTED_SOURCE_IMAGE_ID=$1
      AUDIT_RUNNER_IMAGE_ID=$2
      if test "$EXPECTED_SOURCE_IMAGE_ID" = sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d; then
        assert_legacy_alpha742_source "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
      else
        audit_effective ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
      fi
    }
    validate_sanctuary_roots() {
      (
      VALIDATE_RUNTIME_ROOT=$1
      VALIDATE_AGENT_ROOT=$2
      test -d "$VALIDATE_RUNTIME_ROOT" || return $?
      test -d "$VALIDATE_AGENT_ROOT" || return $?
      VALIDATE_BAD_SHAPE=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev \( -type l -o \( ! -type d -a ! -type f \) \) -print -quit) || return $?
      test -z "$VALIDATE_BAD_SHAPE" || return $?
      VALIDATE_UNEXPECTED_SOCKET=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev -type s -print -quit) || return $?
      test -z "$VALIDATE_UNEXPECTED_SOCKET" || return $?
      for VALIDATE_REQUIRED_FILE in \
        agent.json bundle-meta.json provider-readiness.json tool-profiles.json \
        psyche/SOUL.md habits/sanctuary-health.md; do
        test -s "$VALIDATE_AGENT_ROOT/$VALIDATE_REQUIRED_FILE" || return $?
      done
      test -d "$VALIDATE_RUNTIME_ROOT/vault-unlock" || return $?
      VALIDATE_UNLOCK_FILES=$(find "$VALIDATE_RUNTIME_ROOT/vault-unlock" -xdev -mindepth 1 -maxdepth 1 -type f -name '*.secret' -size +0c -print) || return $?
      test "$(printf '%s\n' "$VALIDATE_UNLOCK_FILES" | awk 'NF { count++ } END { print count + 0 }')" = 1 || return $?
      test ! -e "$VALIDATE_RUNTIME_ROOT/container-credentials.json" || return $?
      test ! -e "$VALIDATE_RUNTIME_ROOT/container-credentials.json.consuming" || return $?
      test ! -S "$VALIDATE_AGENT_ROOT/state/acceptance/telegram-control.sock" || return $?
      VALIDATE_WRONG_OWNER=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev \( ! -user 10001 -o ! -group 10001 \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_OWNER" || return $?
      VALIDATE_WRONG_RUNTIME_DIR_MODE=$(find "$VALIDATE_RUNTIME_ROOT" -xdev -type d ! -perm 0700 \
        ! \( -perm 0755 \( \
          -path "$VALIDATE_RUNTIME_ROOT/scheduler" -o -path "$VALIDATE_RUNTIME_ROOT/scheduler/*" -o \
          -path "$VALIDATE_RUNTIME_ROOT/daemon/logs" -o -path "$VALIDATE_RUNTIME_ROOT/daemon/logs/*" \
        \) \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_RUNTIME_DIR_MODE" || return $?
      VALIDATE_WRONG_AGENT_DIR_MODE=$(find "$VALIDATE_AGENT_ROOT" -xdev -type d ! -perm 0700 \
        ! \( -perm 0755 \( \
          -path "$VALIDATE_AGENT_ROOT/arc/flight-recorder" -o -path "$VALIDATE_AGENT_ROOT/arc/flight-recorder/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/health" -o -path "$VALIDATE_AGENT_ROOT/state/health/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/logs" -o -path "$VALIDATE_AGENT_ROOT/state/logs/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/habits" -o -path "$VALIDATE_AGENT_ROOT/state/habits/*" \
        \) \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_AGENT_DIR_MODE" || return $?
      VALIDATE_WRONG_RUNTIME_FILE_MODE=$(find "$VALIDATE_RUNTIME_ROOT" -xdev -type f ! -perm 0600 \
        ! \( -perm 0644 \( \
          -path "$VALIDATE_RUNTIME_ROOT/daemon/logs/*" -o \
          -path "$VALIDATE_RUNTIME_ROOT/scheduler/*" -o \
          -path "$VALIDATE_RUNTIME_ROOT/pulse.json" -o \
          -path "$VALIDATE_RUNTIME_ROOT/pulse-delivered.json" -o \
          -path "$VALIDATE_RUNTIME_ROOT/daemon.pids" -o \
          -path "$VALIDATE_RUNTIME_ROOT/daemon-health.json" \
        \) \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_RUNTIME_FILE_MODE" || return $?
      VALIDATE_WRONG_AGENT_FILE_MODE=$(find "$VALIDATE_AGENT_ROOT" -xdev -type f ! -perm 0600 \
        ! \( -perm 0644 \( \
          -path "$VALIDATE_AGENT_ROOT/arc/flight-recorder/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/health/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/logs/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/habits/*" \
        \) \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_AGENT_FILE_MODE" || return $?
      )
    }
    verify_sanctuary_snapshot_provenance() {
      (
      SNAPSHOT_ROOT=$1
      EXPECTED_SNAPSHOT_IMAGE_ID=$2
      SNAPSHOT_PROVENANCE_ROOT=$SNAPSHOT_ROOT/provenance
      for SNAPSHOT_TOP_LEVEL_DIRECTORY in runtime agent provenance; do
        test -d "$SNAPSHOT_ROOT/$SNAPSHOT_TOP_LEVEL_DIRECTORY" || return $?
        test ! -L "$SNAPSHOT_ROOT/$SNAPSHOT_TOP_LEVEL_DIRECTORY" || return 1
      done
      test "$(find "$SNAPSHOT_ROOT" -xdev -mindepth 1 -maxdepth 1 -print | wc -l)" -eq 3 || return $?
      test -d "$SNAPSHOT_PROVENANCE_ROOT" || return $?
      test ! -L "$SNAPSHOT_PROVENANCE_ROOT" || return 1
      test "$(stat -c '%u:%g:%a' "$SNAPSHOT_PROVENANCE_ROOT")" = 0:0:700 || return $?
      SNAPSHOT_BAD_PROVENANCE_ENTRY=$(find "$SNAPSHOT_PROVENANCE_ROOT" -xdev -mindepth 1 ! -type f -print -quit) || return $?
      test -z "$SNAPSHOT_BAD_PROVENANCE_ENTRY" || return $?
      for SNAPSHOT_PROVENANCE_FILE in image-id container-inspect.json manifest.sha256; do
        test -f "$SNAPSHOT_PROVENANCE_ROOT/$SNAPSHOT_PROVENANCE_FILE" || return $?
        test ! -L "$SNAPSHOT_PROVENANCE_ROOT/$SNAPSHOT_PROVENANCE_FILE" || return 1
        test "$(stat -c '%u:%g:%a' "$SNAPSHOT_PROVENANCE_ROOT/$SNAPSHOT_PROVENANCE_FILE")" = 0:0:600 || return $?
      done
      test "$(find "$SNAPSHOT_PROVENANCE_ROOT" -xdev -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 3 || return $?
      test "$(wc -l <"$SNAPSHOT_PROVENANCE_ROOT/image-id")" -eq 1 || return $?
      IFS= read -r SNAPSHOT_IMAGE_ID <"$SNAPSHOT_PROVENANCE_ROOT/image-id" || return $?
      test "$SNAPSHOT_IMAGE_ID" = "$EXPECTED_SNAPSHOT_IMAGE_ID" || return $?
      case "$SNAPSHOT_IMAGE_ID" in sha256:????????????????????????????????????????????????????????????????) ;; *) return 1 ;; esac
      case "${SNAPSHOT_IMAGE_ID#sha256:}" in *[!0-9a-f]*) return 1 ;; esac
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (!Array.isArray(value) || value.length !== 1 || !value[0] || value[0].Image !== process.argv[2]) process.exit(1);
      ' "$SNAPSHOT_PROVENANCE_ROOT/container-inspect.json" "$SNAPSHOT_IMAGE_ID" || return $?
      SNAPSHOT_VERIFY_ROOT=$(mktemp -d /tmp/ouro-snapshot-verify.XXXXXX) || return $?
      trap 'rm -f -- "$SNAPSHOT_VERIFY_ROOT/current-files" "$SNAPSHOT_VERIFY_ROOT/manifest-files"; rmdir -- "$SNAPSHOT_VERIFY_ROOT"' EXIT || return $?
      (
        cd "$SNAPSHOT_ROOT" || return $?
        find runtime agent provenance -xdev -type f ! -path provenance/manifest.sha256 -print | LC_ALL=C sort >"$SNAPSHOT_VERIFY_ROOT/current-files" || return $?
        grep -E '^[0-9a-f]{64}  [^/].+$' provenance/manifest.sha256 >/dev/null || return $?
        ! grep -Ev '^[0-9a-f]{64}  [^/].+$' provenance/manifest.sha256 >/dev/null || return 1
        sed 's/^[0-9a-f]\{64\}  //' provenance/manifest.sha256 | LC_ALL=C sort >"$SNAPSHOT_VERIFY_ROOT/manifest-files" || return $?
        cmp -s "$SNAPSHOT_VERIFY_ROOT/current-files" "$SNAPSHOT_VERIFY_ROOT/manifest-files" || return $?
        sha256sum -c -- provenance/manifest.sha256 >/dev/null || return $?
      ) || return $?
      rm -f -- "$SNAPSHOT_VERIFY_ROOT/current-files" "$SNAPSHOT_VERIFY_ROOT/manifest-files" || return $?
      rmdir -- "$SNAPSHOT_VERIFY_ROOT" || return $?
      trap - EXIT || return $?
      )
    }
    assert_restore_preflight() {
      (
      test -n "${BACKUP_ROOT-}" || return 1
      test -n "${IMAGE_ID-}" || return 1
      test -n "${AUDIT_RUNNER_IMAGE_ID-}" || return 1
      case "$BACKUP_ROOT" in
        /*) ;;
        *) return 1 ;;
      esac
      test "$BACKUP_ROOT" != / || return $?
      RESTORE_BACKUP_ROOT=$(cd -- "$BACKUP_ROOT" && pwd -P) || return $?
      test "$RESTORE_BACKUP_ROOT" = "$BACKUP_ROOT" || return $?
      test -d "$BACKUP_ROOT/runtime/.ouro-cli" || return $?
      test -d "$BACKUP_ROOT/agent/sanctuary.ouro" || return $?
      verify_sanctuary_snapshot_provenance "$BACKUP_ROOT" "$IMAGE_ID" || return $?
      validate_sanctuary_roots "$BACKUP_ROOT/runtime/.ouro-cli" "$BACKUP_ROOT/agent/sanctuary.ouro" || return $?
      validate_exact_image_id "$IMAGE_ID" || return $?
      validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID" || return $?
      test "$AUDIT_RUNNER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return $?
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
    ensure_sanctuary_machine_identity() {
      MACHINE_PATH=$1
      test ! -L "$MACHINE_PATH" || return 1
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const path = process.argv[1];
        const valid = value => value && value.schemaVersion === 1 && value.machineId === "sanctuary"
          && typeof value.createdAt === "string" && typeof value.updatedAt === "string"
          && Array.isArray(value.hostnameAliases);
        if (fs.existsSync(path)) {
          if (!valid(JSON.parse(fs.readFileSync(path, "utf8")))) process.exit(1);
          process.exit(0);
        }
        const now = new Date().toISOString();
        const value = { schemaVersion: 1, machineId: "sanctuary", createdAt: now, updatedAt: now, hostnameAliases: [] };
        const temporary = `${path}.tmp.${process.pid}`;
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, path);
      ' "$MACHINE_PATH" || return $?
      chown 10001:10001 "$MACHINE_PATH" || return $?
      chmod 0600 "$MACHINE_PATH" || return $?
      sync -f "$MACHINE_PATH" || return $?
    }
    prepare_canonical_sanctuary_roots() {
      PREPARE_IMAGE_ID=$1
      validate_exact_image_id "$PREPARE_IMAGE_ID" || return $?
      PREPARE_RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
      PREPARE_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      install -d -m 0700 -o 10001 -g 10001 "$PREPARE_RUNTIME_ROOT" || return $?
      install -d -m 0700 -o 10001 -g 10001 "$PREPARE_AGENT_ROOT" || return $?
      ensure_sanctuary_machine_identity "$PREPARE_RUNTIME_ROOT/machine.json" || return $?
      if test ! -f "$PREPARE_AGENT_ROOT/agent.json"; then
        PREPARE_EXISTING_ENTRY=$(find "$PREPARE_AGENT_ROOT" -mindepth 1 -print -quit) || return $?
        test -z "$PREPARE_EXISTING_ENTRY" || return $?
        ! docker container inspect ouro-butler-bundle-bootstrap >/dev/null 2>&1 || return 1
        docker run --rm --pull=never --network=none --name ouro-butler-bundle-bootstrap --user 10001:10001 \
          --mount "type=bind,src=$PREPARE_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
          --mount "type=bind,src=$PREPARE_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
          --entrypoint /bin/sh "$PREPARE_IMAGE_ID" -ceu '
            cp -R /opt/ouro/deploy/unraid/sanctuary.ouro/. /home/ouro/AgentBundles/sanctuary.ouro/
            find /home/ouro/AgentBundles/sanctuary.ouro -type d -exec chmod 0700 {} +
            find /home/ouro/AgentBundles/sanctuary.ouro -type f -exec chmod 0600 {} +
          ' || return $?
        ! docker container inspect ouro-butler-bundle-bootstrap >/dev/null 2>&1 || return 1
      fi
      for PREPARE_REQUIRED_FILE in \
        agent.json bundle-meta.json provider-readiness.json tool-profiles.json \
        psyche/SOUL.md habits/sanctuary-health.md; do
        test -f "$PREPARE_AGENT_ROOT/$PREPARE_REQUIRED_FILE" || return $?
      done
      PREPARE_WRONG_OWNER=$(find "$PREPARE_RUNTIME_ROOT" "$PREPARE_AGENT_ROOT" \( ! -user 10001 -o ! -group 10001 \) -print -quit) || return $?
      test -z "$PREPARE_WRONG_OWNER" || return $?
      PREPARE_WRONG_DIR_MODE=$(find "$PREPARE_RUNTIME_ROOT" "$PREPARE_AGENT_ROOT" -type d ! -perm 0700 -print -quit) || return $?
      test -z "$PREPARE_WRONG_DIR_MODE" || return $?
      PREPARE_WRONG_FILE_MODE=$(find "$PREPARE_RUNTIME_ROOT" "$PREPARE_AGENT_ROOT" -type f ! -perm 0600 -print -quit) || return $?
      test -z "$PREPARE_WRONG_FILE_MODE" || return $?
    }
    validate_sanctuary_legacy_staging() {
      EXPECTED_LEGACY_CONTAINER_ID=${1-}
      EXPECTED_LEGACY_IMAGE_ID=${2-}
      LEGACY_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      LEGACY_NAME_COUNTS=$(printf '%s\n' "$LEGACY_CONTAINER_NAMES" | awk '
        /butler/ { butlers++ }
        $0 == "ouro-butler-staging" { staging++ }
        END { printf "%d %d", butlers + 0, staging + 0 }
      ') || return $?
      test "$LEGACY_NAME_COUNTS" = "1 1" || return $?
      assert_only_running_butler ouro-butler-staging || return $?
      LEGACY_STAGING_RUNNING=$(docker inspect --format '{{.State.Running}}' ouro-butler-staging) || return $?
      test "$LEGACY_STAGING_RUNNING" = true || return $?
      LEGACY_STAGING_CONTAINER_ID=$(docker inspect --format '{{.Id}}' ouro-butler-staging) || return $?
      case "$LEGACY_STAGING_CONTAINER_ID" in *[!0-9a-f]*|'') return 1 ;; esac
      test "${#LEGACY_STAGING_CONTAINER_ID}" -eq 64 || return 1
      LEGACY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging) || return $?
      validate_exact_image_id "$LEGACY_STAGING_IMAGE_ID" || return $?
      if test -n "$EXPECTED_LEGACY_CONTAINER_ID"; then
        test "$LEGACY_STAGING_CONTAINER_ID" = "$EXPECTED_LEGACY_CONTAINER_ID" || return 1
        test "$LEGACY_STAGING_IMAGE_ID" = "$EXPECTED_LEGACY_IMAGE_ID" || return 1
      fi
    }
    prepare_sanctuary_legacy_adoption() {
      IMAGE_ID=$1
      validate_exact_image_id "$IMAGE_ID" || return $?
      validate_sanctuary_legacy_staging || return $?
      PREPARED_LEGACY_CONTAINER_ID=$LEGACY_STAGING_CONTAINER_ID
      PREPARED_LEGACY_IMAGE_ID=$LEGACY_STAGING_IMAGE_ID
      prepare_canonical_sanctuary_roots "$IMAGE_ID" || return $?
      bootstrap_sanctuary_vault "$IMAGE_ID" \
        /mnt/user/appdata/ouro-butler/runtime/container-credentials.json \
        sanctuary-unraid sanctuary || return $?
      validate_sanctuary_legacy_staging "$PREPARED_LEGACY_CONTAINER_ID" "$PREPARED_LEGACY_IMAGE_ID" || return $?
      LEGACY_STAGING_CONTAINER_ID=$PREPARED_LEGACY_CONTAINER_ID
      LEGACY_STAGING_IMAGE_ID=$PREPARED_LEGACY_IMAGE_ID
    }
    capture_sanctuary_legacy_evidence() {
      CAPTURED_LEGACY_CONTAINER_ID=$1
      CAPTURED_LEGACY_IMAGE_ID=$2
      LEGACY_EVIDENCE_ROOT=$3
      case "$CAPTURED_LEGACY_CONTAINER_ID" in *[!0-9a-f]*|'') return 1 ;; esac
      test "${#CAPTURED_LEGACY_CONTAINER_ID}" -eq 64 || return 1
      validate_exact_image_id "$CAPTURED_LEGACY_IMAGE_ID" || return $?
      case "$LEGACY_EVIDENCE_ROOT" in /*) ;; *) return 1 ;; esac
      if test -e "$LEGACY_EVIDENCE_ROOT" || test -L "$LEGACY_EVIDENCE_ROOT"; then
        /usr/local/bin/node -e '
          const fs = require("node:fs");
          const root = fs.lstatSync(process.argv[1]);
          if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700) process.exit(1);
          if (root.uid !== process.geteuid() || root.gid !== process.getegid()) process.exit(1);
        ' "$LEGACY_EVIDENCE_ROOT" || return $?
      else
        install -d -m 0700 -o 0 -g 0 "$LEGACY_EVIDENCE_ROOT" || return $?
      fi
      LEGACY_EVIDENCE_DIR="$LEGACY_EVIDENCE_ROOT/${CAPTURED_LEGACY_IMAGE_ID#sha256:}"
      if test -e "$LEGACY_EVIDENCE_DIR" || test -L "$LEGACY_EVIDENCE_DIR"; then
        test -d "$LEGACY_EVIDENCE_DIR" && test ! -L "$LEGACY_EVIDENCE_DIR" || return 1
      else
        mkdir -m 0700 "$LEGACY_EVIDENCE_DIR" || return $?
      fi
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const [rootPath, directoryPath] = process.argv.slice(1);
        const root = fs.lstatSync(rootPath);
        const directory = fs.lstatSync(directoryPath);
        const privateDirectory = value => value.isDirectory() && !value.isSymbolicLink() && (value.mode & 0o777) === 0o700;
        if (!privateDirectory(root) || !privateDirectory(directory)) process.exit(1);
        if (root.uid !== process.geteuid() || root.gid !== process.getegid()) process.exit(1);
        if (root.uid !== directory.uid || root.gid !== directory.gid) process.exit(1);
        const allowed = new Set(["container.json", "image.json"]);
        if (fs.readdirSync(directoryPath).some(name => !allowed.has(name))) process.exit(1);
      ' "$LEGACY_EVIDENCE_ROOT" "$LEGACY_EVIDENCE_DIR" || return $?
      validate_legacy_evidence_entry() {
        VALIDATED_EVIDENCE_KIND=$1
        VALIDATED_EVIDENCE_PATH=$2
        /usr/local/bin/node -e '
          const fs = require("node:fs");
          const [kind, filePath, rootPath, containerId, imageId] = process.argv.slice(1);
          const root = fs.lstatSync(rootPath);
          const entry = fs.lstatSync(filePath);
          if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== root.uid || entry.gid !== root.gid) process.exit(1);
          const mode = entry.mode & 0o777;
          if (mode !== 0o600 && mode !== 0o644) process.exit(1);
          const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
          if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") process.exit(1);
          if (kind === "container" && (value[0].Id !== containerId || value[0].Image !== imageId)) process.exit(1);
          if (kind === "image" && value[0].Id !== imageId) process.exit(1);
        ' "$VALIDATED_EVIDENCE_KIND" "$VALIDATED_EVIDENCE_PATH" "$LEGACY_EVIDENCE_ROOT" "$CAPTURED_LEGACY_CONTAINER_ID" "$CAPTURED_LEGACY_IMAGE_ID"
      }
      capture_missing_legacy_evidence_entry() {
        MISSING_EVIDENCE_KIND=$1
        MISSING_EVIDENCE_PATH=$2
        LEGACY_EVIDENCE_TMP=$(mktemp "$LEGACY_EVIDENCE_ROOT/.capture.XXXXXXXX") || return $?
        if test "$MISSING_EVIDENCE_KIND" = container; then
          docker container inspect "$CAPTURED_LEGACY_CONTAINER_ID" >"$LEGACY_EVIDENCE_TMP" || {
            CAPTURE_STATUS=$?
            rm -f "$LEGACY_EVIDENCE_TMP"
            return "$CAPTURE_STATUS"
          }
        else
          docker image inspect "$CAPTURED_LEGACY_IMAGE_ID" >"$LEGACY_EVIDENCE_TMP" || {
            CAPTURE_STATUS=$?
            rm -f "$LEGACY_EVIDENCE_TMP"
            return "$CAPTURE_STATUS"
          }
        fi
        chmod 0600 "$LEGACY_EVIDENCE_TMP" || {
          CAPTURE_STATUS=$?
          rm -f "$LEGACY_EVIDENCE_TMP"
          return "$CAPTURE_STATUS"
        }
        validate_legacy_evidence_entry "$MISSING_EVIDENCE_KIND" "$LEGACY_EVIDENCE_TMP" || {
          CAPTURE_STATUS=$?
          rm -f "$LEGACY_EVIDENCE_TMP"
          return "$CAPTURE_STATUS"
        }
        sync -f "$LEGACY_EVIDENCE_TMP" || {
          CAPTURE_STATUS=$?
          rm -f "$LEGACY_EVIDENCE_TMP"
          return "$CAPTURE_STATUS"
        }
        if ln "$LEGACY_EVIDENCE_TMP" "$MISSING_EVIDENCE_PATH"; then
          rm -f "$LEGACY_EVIDENCE_TMP" || return $?
        else
          rm -f "$LEGACY_EVIDENCE_TMP" || return $?
          validate_legacy_evidence_entry "$MISSING_EVIDENCE_KIND" "$MISSING_EVIDENCE_PATH" || return $?
        fi
      }
      for LEGACY_EVIDENCE_KIND in container image; do
        LEGACY_EVIDENCE_PATH="$LEGACY_EVIDENCE_DIR/$LEGACY_EVIDENCE_KIND.json"
        if test -e "$LEGACY_EVIDENCE_PATH" || test -L "$LEGACY_EVIDENCE_PATH"; then
          validate_legacy_evidence_entry "$LEGACY_EVIDENCE_KIND" "$LEGACY_EVIDENCE_PATH" || return $?
        else
          capture_missing_legacy_evidence_entry "$LEGACY_EVIDENCE_KIND" "$LEGACY_EVIDENCE_PATH" || return $?
        fi
        chmod 0600 "$LEGACY_EVIDENCE_PATH" || return $?
        validate_legacy_evidence_entry "$LEGACY_EVIDENCE_KIND" "$LEGACY_EVIDENCE_PATH" || return $?
      done
      sync -f "$LEGACY_EVIDENCE_DIR" || return $?
    }
    install_from_legacy_staging() {
      prepare_sanctuary_legacy_adoption "$IMAGE_ID" || return $?
      ADOPTION_PREPARED_CONTAINER_ID=$LEGACY_STAGING_CONTAINER_ID
      ADOPTION_PREPARED_IMAGE_ID=$LEGACY_STAGING_IMAGE_ID
      verify_sanctuary_provider_readiness "$IMAGE_ID" || return $?
      ADOPTION_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      ADOPTION_NAME_COUNTS=$(printf '%s\n' "$ADOPTION_CONTAINER_NAMES" | awk '
        /butler/ { butlers++ }
        $0 == "ouro-butler-staging" { staging++ }
        END { printf "%d %d", butlers + 0, staging + 0 }
      ') || return $?
      test "$ADOPTION_NAME_COUNTS" = "1 1" || return $?
      assert_only_running_butler ouro-butler-staging || return $?
      test "$(docker inspect --format '{{.State.Running}}' ouro-butler-staging)" = true || return $?
      test "$(docker inspect --format '{{.Id}}' ouro-butler-staging)" = "$ADOPTION_PREPARED_CONTAINER_ID" || return $?
      test "$(docker inspect --format '{{.Image}}' ouro-butler-staging)" = "$ADOPTION_PREPARED_IMAGE_ID" || return $?
      LEGACY_STAGING_CONTAINER_ID=$ADOPTION_PREPARED_CONTAINER_ID
      LEGACY_STAGING_IMAGE_ID=$ADOPTION_PREPARED_IMAGE_ID
      LEGACY_EVIDENCE_ROOT=/mnt/user/appdata/ouro-butler/legacy-evidence
      capture_sanctuary_legacy_evidence "$LEGACY_STAGING_CONTAINER_ID" "$LEGACY_STAGING_IMAGE_ID" "$LEGACY_EVIDENCE_ROOT" || return $?
      validate_sanctuary_legacy_staging "$ADOPTION_PREPARED_CONTAINER_ID" "$ADOPTION_PREPARED_IMAGE_ID" || return $?
      LEGACY_STAGING_CONTAINER_ID=$ADOPTION_PREPARED_CONTAINER_ID
      LEGACY_STAGING_IMAGE_ID=$ADOPTION_PREPARED_IMAGE_ID
      disable_butler_autostart || return $?
      if docker stop "$LEGACY_STAGING_CONTAINER_ID" \
        && CURRENT_LEGACY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$LEGACY_STAGING_CONTAINER_ID") \
        && test "$CURRENT_LEGACY_STAGING_IMAGE_ID" = "$LEGACY_STAGING_IMAGE_ID" \
        && test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_STAGING_CONTAINER_ID")" = false \
        && docker rename "$LEGACY_STAGING_CONTAINER_ID" ouro-butler-legacy-evidence \
        && CURRENT_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) \
        && test "$CURRENT_LEGACY_EVIDENCE_IMAGE_ID" = "$LEGACY_STAGING_IMAGE_ID" \
        && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence)" = false \
        && docker create --name ouro-butler-staging --network host --restart unless-stopped --user 10001:10001 \
          --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
          --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
          "$IMAGE_ID" \
        && audit_effective ouro-butler-staging "$IMAGE_ID" "$IMAGE_ID" \
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
        && audit_effective ouro-butler "$IMAGE_ID" "$IMAGE_ID" \
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
          CURRENT_LEGACY_STAGING_CONTAINER_ID=$(docker inspect --format '{{.Id}}' ouro-butler-staging) || return $?
          case "$CURRENT_LEGACY_STAGING_CONTAINER_ID" in *[!0-9a-f]*|'') return 1 ;; esac
          test "${#CURRENT_LEGACY_STAGING_CONTAINER_ID}" -eq 64 || return 1
          CURRENT_LEGACY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging) || return $?
          case "$CURRENT_LEGACY_STAGING_IMAGE_ID" in
            "$IMAGE_ID")
              docker stop ouro-butler-staging >/dev/null 2>&1 || true
              docker rm --force ouro-butler-staging || return $?
              ;;
            "$LEGACY_STAGING_IMAGE_ID")
              test "$CURRENT_LEGACY_STAGING_CONTAINER_ID" = "$LEGACY_STAGING_CONTAINER_ID" || return 1
              docker stop "$LEGACY_STAGING_CONTAINER_ID" >/dev/null 2>&1 || return $?
              test "$(docker inspect --format '{{.State.Running}}' "$LEGACY_STAGING_CONTAINER_ID")" = false || return $?
              docker rename "$LEGACY_STAGING_CONTAINER_ID" ouro-butler-legacy-evidence || return $?
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
    validate_sanctuary_legacy_import_marker() {
      IMPORT_MARKER=$1
      IMPORT_SOURCE=$2
      test -f "$IMPORT_MARKER" && test ! -L "$IMPORT_MARKER" || return 1
      test "$(stat -c '%u:%g %a' "$IMPORT_MARKER")" = "10001:10001 600" || return 1
      /usr/local/bin/node -e '
        const crypto = require("node:crypto");
        const fs = require("node:fs");
        const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const sourceDigest = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex")}`;
        if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["importedAt", "machineId", "schemaVersion", "sourceDigest"])) process.exit(1);
        if (marker.schemaVersion !== 1 || marker.machineId !== "sanctuary" || marker.sourceDigest !== sourceDigest) process.exit(1);
        if (!Number.isFinite(Date.parse(marker.importedAt))) process.exit(1);
      ' "$IMPORT_MARKER" "$IMPORT_SOURCE"
    }
    record_sanctuary_legacy_import_marker() {
      IMPORT_MARKER=$1
      IMPORT_SOURCE=$2
      test ! -e "$IMPORT_MARKER" || return 1
      IMPORT_MARKER_TMP=$(mktemp "${IMPORT_MARKER}.tmp.XXXXXX") || return $?
      trap 'rm -f -- "$IMPORT_MARKER_TMP"' EXIT || return $?
      /usr/local/bin/node -e '
        const crypto = require("node:crypto");
        const fs = require("node:fs");
        const sourceDigest = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex")}`;
        const marker = { schemaVersion: 1, machineId: "sanctuary", sourceDigest, importedAt: new Date().toISOString() };
        fs.writeFileSync(process.argv[1], `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "w" });
      ' "$IMPORT_MARKER_TMP" "$IMPORT_SOURCE" || return $?
      chown 10001:10001 "$IMPORT_MARKER_TMP" || return $?
      chmod 0600 "$IMPORT_MARKER_TMP" || return $?
      mv -f -- "$IMPORT_MARKER_TMP" "$IMPORT_MARKER" || return $?
      sync -f "$IMPORT_MARKER" || return $?
      sync -f "$(dirname "$IMPORT_MARKER")" || return $?
      trap - EXIT || return $?
    }
    bootstrap_sanctuary_vault() {
      BOOTSTRAP_IMAGE_ID=$1
      BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE=${2-}
      BOOTSTRAP_SOURCE_MACHINE_ID=${3-}
      BOOTSTRAP_TARGET_MACHINE_ID=${4-}
      validate_exact_image_id "$BOOTSTRAP_IMAGE_ID" || return $?
      case "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" in
        "")
          test -z "$BOOTSTRAP_SOURCE_MACHINE_ID" || return 1
          test -z "$BOOTSTRAP_TARGET_MACHINE_ID" || return 1
          ;;
        /mnt/user/appdata/ouro-butler/runtime/container-credentials.json)
          test "$BOOTSTRAP_SOURCE_MACHINE_ID" = sanctuary-unraid || return 1
          test "$BOOTSTRAP_TARGET_MACHINE_ID" = sanctuary || return 1
          ;;
        *) return 1 ;;
      esac
      BOOTSTRAP_RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
      BOOTSTRAP_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      for BOOTSTRAP_CONTAINER in ouro-butler-vault-status ouro-butler-vault-bootstrap ouro-butler-credential-bootstrap ouro-butler-provider-readiness; do
        ! docker container inspect "$BOOTSTRAP_CONTAINER" >/dev/null 2>&1 || return 1
      done
      VAULT_STATUS=$(docker run --rm --pull=never --network host --name ouro-butler-vault-status --user 10001:10001 \
        --mount "type=bind,src=$BOOTSTRAP_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=$BOOTSTRAP_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --entrypoint node "$BOOTSTRAP_IMAGE_ID" /opt/ouro/dist/heart/daemon/ouro-entry.js \
        vault status --agent sanctuary --store plaintext-file) || return $?
      ! docker container inspect ouro-butler-vault-status >/dev/null 2>&1 || return 1
      case "
$VAULT_STATUS
" in
        *"
vault locator: not configured in agent.json
"*) VAULT_ACTION=create ;;
        *"
vault locator: agent.json
"*)
          case "
$VAULT_STATUS
" in
            *"
local unlock: available
"*) VAULT_ACTION=none ;;
            *"
local unlock: missing
"*) VAULT_ACTION=unlock ;;
            *) return 1 ;;
          esac
          ;;
        *) return 1 ;;
      esac
      if test "$VAULT_ACTION" != none; then
        docker run --rm -it --pull=never --network host --name ouro-butler-vault-bootstrap --user 10001:10001 \
          --mount "type=bind,src=$BOOTSTRAP_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
          --mount "type=bind,src=$BOOTSTRAP_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
          --entrypoint node "$BOOTSTRAP_IMAGE_ID" /opt/ouro/dist/heart/daemon/ouro-entry.js \
          vault "$VAULT_ACTION" --agent sanctuary --store plaintext-file || return $?
        ! docker container inspect ouro-butler-vault-bootstrap >/dev/null 2>&1 || return 1
      fi
      VERIFIED_VAULT_STATUS=$(docker run --rm --pull=never --network host --name ouro-butler-vault-status --user 10001:10001 \
        --mount "type=bind,src=$BOOTSTRAP_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=$BOOTSTRAP_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --entrypoint node "$BOOTSTRAP_IMAGE_ID" /opt/ouro/dist/heart/daemon/ouro-entry.js \
        vault status --agent sanctuary --store plaintext-file) || return $?
      ! docker container inspect ouro-butler-vault-status >/dev/null 2>&1 || return 1
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
      if test -n "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE"; then
        BOOTSTRAP_CREDENTIAL_SOURCE="$BOOTSTRAP_RUNTIME_ROOT/container-credentials.json"
        BOOTSTRAP_CREDENTIAL_CLAIM="$BOOTSTRAP_CREDENTIAL_SOURCE.consuming"
        test -f "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
        test ! -L "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
        BOOTSTRAP_LEGACY_METADATA=$(stat -c '%u:%g %a' "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE") || return $?
        test "$BOOTSTRAP_LEGACY_METADATA" = "10001:10001 600" || return $?
        BOOTSTRAP_IMPORT_MARKER="$BOOTSTRAP_RUNTIME_ROOT/legacy-credentials-imported.json"
        if test -e "$BOOTSTRAP_IMPORT_MARKER"; then
          validate_sanctuary_legacy_import_marker "$BOOTSTRAP_IMPORT_MARKER" "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
          test ! -e "$BOOTSTRAP_CREDENTIAL_SOURCE" || return 1
          test ! -e "$BOOTSTRAP_CREDENTIAL_CLAIM" || return 1
        else
        if test -e "$BOOTSTRAP_CREDENTIAL_SOURCE"; then
          test -f "$BOOTSTRAP_CREDENTIAL_SOURCE" || return $?
          test ! -L "$BOOTSTRAP_CREDENTIAL_SOURCE" || return $?
          test "$(stat -c '%u:%g %a' "$BOOTSTRAP_CREDENTIAL_SOURCE")" = "10001:10001 600" || return $?
          cmp -s "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" "$BOOTSTRAP_CREDENTIAL_SOURCE" || return $?
        elif test -e "$BOOTSTRAP_CREDENTIAL_CLAIM"; then
          test -f "$BOOTSTRAP_CREDENTIAL_CLAIM" || return $?
          test ! -L "$BOOTSTRAP_CREDENTIAL_CLAIM" || return $?
          test "$(stat -c '%u:%g %a' "$BOOTSTRAP_CREDENTIAL_CLAIM")" = "10001:10001 600" || return $?
          cmp -s "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" "$BOOTSTRAP_CREDENTIAL_CLAIM" || return $?
        else
          BOOTSTRAP_CREDENTIAL_TMP=$(mktemp "$BOOTSTRAP_RUNTIME_ROOT/container-credentials.json.tmp.XXXXXX") || return $?
          trap 'rm -f -- "$BOOTSTRAP_CREDENTIAL_TMP"' EXIT || return $?
          install -m 0600 -o 10001 -g 10001 "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" "$BOOTSTRAP_CREDENTIAL_TMP" || return $?
          cmp -s "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" "$BOOTSTRAP_CREDENTIAL_TMP" || return $?
          sync -f "$BOOTSTRAP_CREDENTIAL_TMP" || return $?
          mv -f -- "$BOOTSTRAP_CREDENTIAL_TMP" "$BOOTSTRAP_CREDENTIAL_SOURCE" || return $?
          sync -f "$BOOTSTRAP_RUNTIME_ROOT" || return $?
          trap - EXIT || return $?
        fi
        docker run --rm --pull=never --network host --name ouro-butler-credential-bootstrap --user 10001:10001 \
          --mount "type=bind,src=$BOOTSTRAP_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
          --mount "type=bind,src=$BOOTSTRAP_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
          --entrypoint node "$BOOTSTRAP_IMAGE_ID" -e '
            const { loadContainerCredentialBootstrap } = require("/opt/ouro/dist/heart/daemon/container-credential-bootstrap.js")
            loadContainerCredentialBootstrap(["sanctuary"], {
              machineIdMigration: {
                sourceMachineId: process.argv[1],
                targetMachineId: process.argv[2],
              },
            }).then(
              () => process.exit(0),
              () => { process.stderr.write("credential bootstrap failed\n"); process.exit(1) },
            )
          ' "$BOOTSTRAP_SOURCE_MACHINE_ID" "$BOOTSTRAP_TARGET_MACHINE_ID" || return $?
        # The path-locked Sanctuary migration imports the legacy MiniMax provider
        # record into the agent vault before strict validation and persistence.
        # The original legacy envelope remains byte-for-byte unchanged and is the
        # sole digest authority.
        ! docker container inspect ouro-butler-credential-bootstrap >/dev/null 2>&1 || return 1
        test ! -e "$BOOTSTRAP_CREDENTIAL_SOURCE" || return $?
        test ! -e "$BOOTSTRAP_CREDENTIAL_CLAIM" || return $?
        record_sanctuary_legacy_import_marker "$BOOTSTRAP_IMPORT_MARKER" "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
        validate_sanctuary_legacy_import_marker "$BOOTSTRAP_IMPORT_MARKER" "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
        fi
        test -f "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
        test ! -L "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE" || return $?
        test "$(stat -c '%u:%g %a' "$BOOTSTRAP_LEGACY_CREDENTIAL_SOURCE")" = "$BOOTSTRAP_LEGACY_METADATA" || return $?
      fi
      validate_sanctuary_roots "$BOOTSTRAP_RUNTIME_ROOT" "$BOOTSTRAP_AGENT_ROOT" || return $?
    }
    authenticate_sanctuary_provider() {
      AUTH_IMAGE_ID=$1
      AUTH_PROVIDER=${2-}
      validate_exact_image_id "$AUTH_IMAGE_ID" || return $?
      case "$AUTH_PROVIDER" in
        openai-compatible) AUTH_CONTAINER=ouro-butler-provider-auth-glm ;;
        openai-compatible-gemini) AUTH_CONTAINER=ouro-butler-provider-auth-gemini ;;
        *) return 1 ;;
      esac
      AUTH_RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
      AUTH_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      ! docker container inspect "$AUTH_CONTAINER" >/dev/null 2>&1 || return 1
      docker run --rm -it --pull=never --network host --name "$AUTH_CONTAINER" --user 10001:10001 \
        --mount "type=bind,src=$AUTH_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=$AUTH_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --entrypoint node "$AUTH_IMAGE_ID" /opt/ouro/dist/heart/daemon/ouro-entry.js \
        auth --agent sanctuary --provider "$AUTH_PROVIDER" || return $?
      ! docker container inspect "$AUTH_CONTAINER" >/dev/null 2>&1 || return 1
    }
    verify_sanctuary_provider_readiness() {
      READINESS_IMAGE_ID=$1
      validate_exact_image_id "$READINESS_IMAGE_ID" || return $?
      READINESS_RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
      READINESS_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      ! docker container inspect ouro-butler-provider-readiness >/dev/null 2>&1 || return 1
      docker run --rm --pull=never --network host --name ouro-butler-provider-readiness --user 10001:10001 \
        --mount "type=bind,src=$READINESS_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=$READINESS_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --entrypoint /bin/sh "$READINESS_IMAGE_ID" -ceu '
          umask 077
          node /opt/ouro/dist/heart/daemon/ouro-entry.js check --agent sanctuary --lane outward
          node /opt/ouro/dist/heart/daemon/ouro-entry.js check --agent sanctuary --lane inner
          node - <<'"'"'NODE'"'"'
            (async () => {
              try {
                const fs = require("node:fs");
                const root = "/home/ouro/AgentBundles/sanctuary.ouro";
                const agent = JSON.parse(fs.readFileSync(`${root}/agent.json`, "utf8"));
                const policy = JSON.parse(fs.readFileSync(`${root}/provider-readiness.json`, "utf8"));
                const expectedPolicy = { version: 1, selectionPolicy: "explicit-same-lane-only" };
                const expected = new Map([
                  ["minimax", { provider: "minimax", model: "MiniMax-M3", vaultItem: "providers/minimax" }],
                ]);
                const exactLane = value => value && value.provider === "minimax" && value.model === "MiniMax-M3";
                if (!exactLane(agent.humanFacing) || !exactLane(agent.agentFacing)
                  || policy.version !== expectedPolicy.version || policy.selectionPolicy !== expectedPolicy.selectionPolicy
                  || !Array.isArray(policy.providers) || policy.providers.length !== expected.size) throw new Error();
                for (const entry of policy.providers) {
                  const wanted = expected.get(entry.provider);
                  if (!wanted || entry.model !== wanted.model || entry.vaultItem !== wanted.vaultItem) throw new Error();
                  expected.delete(entry.provider);
                }
                if (expected.size !== 0) throw new Error();
                const { refreshProviderCredentialPool } = require("/opt/ouro/dist/heart/provider-credentials.js");
                const refreshed = await refreshProviderCredentialPool("sanctuary", {
                  providers: ["minimax"],
                  skipCache: true,
                });
                if (!refreshed.ok) throw new Error();
                const minimax = refreshed.pool.providers["minimax"];
                const exactRecord = (record, provider) => record && record.provider === provider
                  && typeof record.revision === "string" && record.revision.length > 0
                  && typeof record.credentials?.apiKey === "string" && record.credentials.apiKey.trim().length > 0;
                if (!exactRecord(minimax, "minimax")) throw new Error();
                process.stdout.write("Sanctuary provider readiness verified.\n");
              } catch {
                process.stderr.write("Sanctuary provider readiness verification failed.\n");
                process.exitCode = 1;
              }
            })();
NODE
        ' || return $?
      ! docker container inspect ouro-butler-provider-readiness >/dev/null 2>&1 || return 1
      validate_sanctuary_roots "$READINESS_RUNTIME_ROOT" "$READINESS_AGENT_ROOT" || return $?
    }
    run_sanctuary_docker() {
      /usr/bin/timeout -s KILL 20 /usr/bin/docker "$@"
    }
    run_sanctuary_unraid_api() {
      /usr/bin/timeout -s KILL 20 /usr/local/sbin/unraid-api "$@"
    }
    run_sanctuary_node() {
      /usr/local/bin/node "$@"
    }
    resolve_sanctuary_unraid_key() {
      run_sanctuary_node -e '
        const fs = require("node:fs");
        const root = "/boot/config/plugins/dynamix.my.servers/keys";
        const expected = process.argv[1];
        const found = [];
        for (const name of fs.readdirSync(root)) {
          if (!/^[A-Za-z0-9._:-]+\.json$/.test(name)) process.exit(1);
          const path = `${root}/${name}`;
          const stat = fs.lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
          const value = JSON.parse(fs.readFileSync(path, "utf8"));
          if (value.id === expected) found.push({ path, name: value.name });
        }
        if (found.length !== 1 || typeof found[0].name !== "string" || !/^[A-Za-z0-9 ._:-]+$/.test(found[0].name)) process.exit(1);
        process.stdout.write(`${found[0].path}\t${found[0].name}`);
      ' "$1"
    }
    sanctuary_revoked_key_recovery_path() {
      case "$1" in ''|*[!A-Za-z0-9._:-]*) return 1 ;; esac
      printf '%s/%s.json' /mnt/user/appdata/ouro-butler/acceptance/revoked-key-proof "$1"
    }
    validate_sanctuary_revoked_key_recovery() {
      test -f "$1" && test ! -L "$1" || return 1
      test "$(stat -c '%u:%g %a' "$1")" = "0:0 600" || return 1
    }
    preserve_sanctuary_revoked_key() {
      KEY_ID=$1
      KEY_SOURCE=$2
      RECOVERY_ROOT=/mnt/user/appdata/ouro-butler/acceptance/revoked-key-proof
      test -f "$KEY_SOURCE" && test ! -L "$KEY_SOURCE" || return 1
      if test ! -e "$RECOVERY_ROOT"; then
        install -d -m 0700 -o root -g root "$RECOVERY_ROOT" || return $?
      fi
      test -d "$RECOVERY_ROOT" && test ! -L "$RECOVERY_ROOT" || return 1
      test "$(stat -c '%u:%g %a' "$RECOVERY_ROOT")" = "0:0 700" || return 1
      RECOVERY_PATH=$(sanctuary_revoked_key_recovery_path "$KEY_ID") || return $?
      test ! -e "$RECOVERY_PATH" || return 1
      RECOVERY_TMP=$(mktemp "$RECOVERY_ROOT/$KEY_ID.json.tmp.XXXXXX") || return $?
      trap 'rm -f -- "$RECOVERY_TMP"' EXIT || return $?
      install -m 0600 -o root -g root "$KEY_SOURCE" "$RECOVERY_TMP" || return $?
      cmp -s "$KEY_SOURCE" "$RECOVERY_TMP" || return 1
      mv -f -- "$RECOVERY_TMP" "$RECOVERY_PATH" || return $?
      sync -f "$RECOVERY_ROOT" || return $?
      trap - EXIT || return $?
    }
    clear_sanctuary_revoked_key() {
      RECOVERY_PATH=$(sanctuary_revoked_key_recovery_path "$1") || return $?
      test -f "$RECOVERY_PATH" && test ! -L "$RECOVERY_PATH" || return 1
      test "$(stat -c '%u:%g %a' "$RECOVERY_PATH")" = "0:0 600" || return 1
      rm -f -- "$RECOVERY_PATH" || return $?
      sync -f "$(dirname "$RECOVERY_PATH")" || return $?
    }
    verify_vault_backed_unraid_key() {
      KEY_ID=$1
      CAPABILITY=$2
      case "$KEY_ID" in ''|*[!A-Za-z0-9._:-]*) return 1 ;; esac
      case "$CAPABILITY" in read-only|bounded-write) ;; *) return 1 ;; esac
      IMAGE_DIGEST=${IMAGE_ID#sha256:}
      test "$IMAGE_DIGEST" != "$IMAGE_ID" || return 1
      test "${#IMAGE_DIGEST}" -eq 64 || return 1
      case "$IMAGE_DIGEST" in *[!0-9a-f]*) return 1 ;; esac
      test "$(run_sanctuary_docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" || return $?
      KEY_TARGET=$(resolve_sanctuary_unraid_key "$KEY_ID") || return $?
      KEY_PATH=${KEY_TARGET%%	*}
      test "$KEY_PATH" != "$KEY_TARGET" || return 1
      test -f "$KEY_PATH" && test ! -L "$KEY_PATH" || return 1
      VERIFY_RESULT=$(run_sanctuary_docker run --rm --pull=never --network host \
        --user 0:0 \
        --mount type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli,readonly \
        --mount type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly \
        --mount type=bind,src="$KEY_PATH",dst=/run/ouro-acceptance/unraid-key.json,readonly \
        --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh \
        "$IMAGE_ID" vault-probe "$KEY_ID" "$CAPABILITY") || return $?
      printf '%s' "$VERIFY_RESULT" | run_sanctuary_node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          const expectedId = process.argv[1];
          const expectedCapability = process.argv[2];
          const expectedProof = expectedCapability === "read-only"
            ? "read-authorized-write-denied"
            : "read-authorized-write-reached-not-found";
          if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["capability", "keyId", "proof", "valid"])) process.exit(1);
          if (value.valid !== true || value.keyId !== expectedId || value.capability !== expectedCapability) process.exit(1);
          if (value.proof !== expectedProof) process.exit(1);
        });
      ' "$KEY_ID" "$CAPABILITY" || return $?
    }
    inventory_unraid_key_ids() {
      IMAGE_DIGEST=${IMAGE_ID#sha256:}
      test "$IMAGE_DIGEST" != "$IMAGE_ID" || return 1
      test "${#IMAGE_DIGEST}" -eq 64 || return 1
      case "$IMAGE_DIGEST" in *[!0-9a-f]*) return 1 ;; esac
      test "$(run_sanctuary_docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" || return $?
      INVENTORY_RESULT=$(printf '%s' '{"operation":"closed-inventory"}' | \
        run_sanctuary_docker run --rm -i --pull=never --network none \
          --user 0:0 --read-only \
          --mount type=bind,src=/boot/config/plugins/dynamix.my.servers/keys,dst=/boot/config/plugins/dynamix.my.servers/keys,readonly \
          --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh "$IMAGE_ID") || return $?
      printf '%s' "$INVENTORY_RESULT" | run_sanctuary_node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (!value || JSON.stringify(Object.keys(value)) !== JSON.stringify(["keys"]) || !Array.isArray(value.keys)) process.exit(1);
          for (const key of value.keys) {
            if (!key || JSON.stringify(Object.keys(key).sort()) !== JSON.stringify(["id", "roles", "scope"])) process.exit(1);
            if (!/^[A-Za-z0-9._:-]+$/.test(key.id)) process.exit(1);
            if (!["read-only", "bounded-write", "legacy-write"].includes(key.scope) || key.roles !== "none") process.exit(1);
            process.stdout.write(`${key.id}\t${key.scope}\t${key.roles}\n`);
          }
        });
      ' || return $?
    }
    revoke_unraid_key_exact() {
      KEY_ID=$1
      case "$KEY_ID" in ''|*[!A-Za-z0-9._:-]*) return 1 ;; esac
      test "${REVOKED_KEY_FD_OPEN:-no}" = no || return 1
      KEY_TARGET=$(resolve_sanctuary_unraid_key "$KEY_ID") || return $?
      KEY_PATH=${KEY_TARGET%%	*}
      KEY_NAME=${KEY_TARGET#*	}
      test "$KEY_PATH" != "$KEY_TARGET" || return 1
      test -f "$KEY_PATH" && test ! -L "$KEY_PATH" || return $?
      preserve_sanctuary_revoked_key "$KEY_ID" "$KEY_PATH" || return $?
      if ! REVOKE_RESULT=$(run_sanctuary_unraid_api apikey --name "$KEY_NAME" --delete --json); then
        return 1
      fi
      if ! printf '%s' "$REVOKE_RESULT" | run_sanctuary_node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          const expectedId = process.argv[1];
          const expectedName = process.argv[2];
          if (value.deleted !== 1 || !Array.isArray(value.keys) || value.keys.length !== 1) process.exit(1);
          if (value.keys[0].id !== expectedId || value.keys[0].name !== expectedName) process.exit(1);
        });
      ' "$KEY_ID" "$KEY_NAME"; then
        return 1
      fi
    }
    verify_revoked_unraid_key_rejected() {
      KEY_ID=$1
      case "$KEY_ID" in ''|*[!A-Za-z0-9._:-]*) return 1 ;; esac
      REVOKED_KEY_RECOVERY_PATH=$(sanctuary_revoked_key_recovery_path "$KEY_ID") || return $?
      validate_sanctuary_revoked_key_recovery "$REVOKED_KEY_RECOVERY_PATH" || return $?
      IMAGE_DIGEST=${IMAGE_ID#sha256:}
      test "$IMAGE_DIGEST" != "$IMAGE_ID" || return 1
      test "${#IMAGE_DIGEST}" -eq 64 || return 1
      case "$IMAGE_DIGEST" in *[!0-9a-f]*) return 1 ;; esac
      test "$(run_sanctuary_docker image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" || return 1
      REJECT_ATTEMPT=0
      while test "$REJECT_ATTEMPT" -lt 3; do
        REJECT_ATTEMPT=$((REJECT_ATTEMPT + 1))
        if REJECT_RESULT=$(run_sanctuary_docker run --rm -i --pull=never --network host \
          --user 10001:10001 --read-only \
          --entrypoint /bin/sh "$IMAGE_ID" -ceu \
          'exec 3<&0; exec /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh revoked-probe "$1" "$2" 3<&3' \
          sanctuary-revoked-probe "$KEY_ID" http://127.0.0.1/graphql <"$REVOKED_KEY_RECOVERY_PATH") \
          && printf '%s' "$REJECT_RESULT" | run_sanctuary_node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["id", "rejected", "status"])) process.exit(1);
          if (value.rejected !== true || value.id !== process.argv[1] || ![401, 403].includes(value.status)) process.exit(1);
        });
      ' "$KEY_ID"; then
          clear_sanctuary_revoked_key "$KEY_ID" || return $?
          return 0
        fi
        test "$REJECT_ATTEMPT" -lt 3 || return 1
        sleep 2
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
    AUDIT_RUNNER_IMAGE_ID=$IMAGE_ID
    validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID"
  Initial install/adoption is a separate terminal path for the verified live
  legacy state: no production or rollback, exactly one running (possibly
  unhealthy) ouro-butler-staging, and no legacy-evidence container. After the
  helper definitions above are loaded and IMAGE_ID is resolved, run this exact
  sequence. MiniMax credentials are imported from the byte-verified legacy
  bootstrap envelope; do not place credentials in arguments, shell variables, or
  history.
  Sanctuary legacy adoption commands:
    prepare_sanctuary_legacy_adoption "$IMAGE_ID"
    verify_sanctuary_provider_readiness "$IMAGE_ID"
    install_from_legacy_staging
  These commands are one terminal path; after install succeeds, stop and do not
  continue into the normal update below. The final install is noninteractive:
  it reruns resumable preparation plus fresh readiness, but never authentication.
  That function never applies the canonical auditor to the known-noncanonical
  legacy container or restarts it. It verifies and pins the legacy image,
  provisions the absent canonical roots from the exact target image's packaged
  Sanctuary skeleton, proves required files plus exact ownership/modes, and runs
  same-image vault bootstrap and provider readiness before durably snapshotting
  both exact container and image inspect records. Any preparation, vault, or
  readiness failure returns while legacy remains running with autostart
  untouched. It then stops and rechecks the legacy container and renames it to
  stopped ouro-butler-legacy-evidence. A fresh canonical staging container is
  created from exact IMAGE_ID and canonical binds, audited, started, proven to
  be the only running Butler, readiness-checked, then stopped and removed only
  after its image is rechecked. Only then is fresh canonical production created,
  audited, started, readiness-checked, and placed in bare production autostart.
  Failure removes only partial target-image staging/production containers,
  quarantines the exact legacy container without deletion or restart, leaves
  autostart disabled, and propagates the original status.
  For this cutover, preflight either the exact known alpha.742 two-mount source
  or an already-canonical source before any autostart or container mutation.
  Production must be the only running Butler poller;
  staging must be absent; rollback may be absent or one stopped container with
  the exact production image. A stopped legacy-evidence container is preserved.
  Disable every Butler name in Unraid's array-autostart file and verify that
  result before stopping production. First resolve and validate the exact image
  ID of the known-good production container while it is still running, so a
  lookup failure cannot strand a renamed container:
    /boot/config/custom/ouro-events/bootstrap-spool.sh --mount
    test "$(findmnt -n -o FSTYPE --target /boot/config/custom/ouro-events/spool)" = tmpfs
    test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/spool)" = 0:0:755
    ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
    validate_exact_image_id "$ROLLBACK_IMAGE_ID"
    if assert_update_topology "$ROLLBACK_IMAGE_ID"; then
      :
    else
      UPDATE_PREFLIGHT_STATUS=$?
      (exit "$UPDATE_PREFLIGHT_STATUS")
    fi
    assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
  Only after that topology gate, stage copies of the packaged template and
  runtime policy at these paths:
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
        assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
        docker start ouro-butler
        assert_only_running_butler ouro-butler
        wait_butler_ready ouro-butler
        enable_butler_autostart
      elif docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
        docker stop ouro-butler-rollback >/dev/null 2>&1 || true
        test "$(docker inspect --format '{{.Image}}' ouro-butler-rollback)" = "$ROLLBACK_IMAGE_ID"
        docker rename ouro-butler-rollback ouro-butler
        assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
        docker start ouro-butler
        assert_only_running_butler ouro-butler
        wait_butler_ready ouro-butler
        enable_butler_autostart
      fi
      (exit "$PRODUCTION_PREPARATION_STATUS")
    fi
  Preparation failure therefore either restores the still-named exact production
  after removing any stale rollback, or renames the exact stopped rollback back;
  both recoveries revalidate, start, bounded-wait, atomically restore production-only
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
      --mount "type=bind,src=/boot/config/custom/ouro-events/spool,dst=/run/ouro-events,readonly" \
      "$IMAGE_ID" \
      && audit_effective ouro-butler-staging "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" \
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
      assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
      docker start ouro-butler
      assert_only_running_butler ouro-butler
      wait_butler_ready ouro-butler
      enable_butler_autostart
      (exit "$STAGING_ACTIVATION_STATUS")
    fi
  The failure arm safely handles staging that was never created, remains
  stopped, is running, or exited: it force-removes any partial staging state,
  verifies the name is absent, restores and revalidates the old production against
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
      --mount "type=bind,src=/boot/config/custom/ouro-events/spool,dst=/run/ouro-events,readonly" \
      "$IMAGE_ID" \
      && audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" \
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
      assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
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
  Set BACKUP_ROOT to a new absolute snapshot path on the destination filesystem.
  Set AUDIT_RUNNER_IMAGE_TAG to the reviewed new image containing the
  legacy-aware auditor; the alpha.742 source image cannot be the runner.
  Capture and validate the exact source image before stopping ouro-butler, then
  build a temporary snapshot with root-only provenance and atomically rename it into place:
    test -n "${BACKUP_ROOT-}"
    case "$BACKUP_ROOT" in /*) ;; *) exit 1 ;; esac
    test "$BACKUP_ROOT" != /
    test ! -e "$BACKUP_ROOT"
    BACKUP_PARENT=$(dirname -- "$BACKUP_ROOT")
    test "$(cd -- "$BACKUP_PARENT" && pwd -P)" = "$BACKUP_PARENT"
    BACKUP_TMP=$BACKUP_ROOT.tmp.$$
    test ! -e "$BACKUP_TMP"
    AUDIT_RUNNER_IMAGE_TAG=ouro-butler:<new-version>
    AUDIT_RUNNER_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$AUDIT_RUNNER_IMAGE_TAG")
    validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID"
    test "$AUDIT_RUNNER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d
    BACKUP_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
    validate_exact_image_id "$BACKUP_IMAGE_ID"
    assert_update_source "$BACKUP_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
    assert_only_running_butler ouro-butler
    wait_butler_ready ouro-butler
    BACKUP_AUTOSTART_COUNTS=$(butler_autostart_counts)
    case "$BACKUP_AUTOSTART_COUNTS" in "0 0 0 0"|"1 0 0 0") ;; *) exit 1 ;; esac
  Snapshot both of these directories together:
    /mnt/user/appdata/ouro-butler/runtime/.ouro-cli
    /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
  A routine backup must not contain container-credentials.json or
  container-credentials.json.consuming. If either exists, credential migration
  is pending or failed and must be reconciled before taking the backup.
  The Telegram control socket is live process state, not durable data. Exclude
  exactly that socket while preserving every regular file byte-for-byte, then
  require it to be absent from the stopped backup:
    BACKUP_OPERATION_STATUS=0
    if docker stop ouro-butler \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler)" = false \
      && install -d -m 0700 -o 0 -g 0 "$BACKUP_TMP" "$BACKUP_TMP/runtime" "$BACKUP_TMP/agent" "$BACKUP_TMP/provenance" \
      && rsync -a --exclude='/state/acceptance/telegram-control.sock' /mnt/user/appdata/ouro-butler/runtime/.ouro-cli "$BACKUP_TMP/runtime/" \
      && rsync -a --exclude='/state/acceptance/telegram-control.sock' /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro "$BACKUP_TMP/agent/" \
      && test ! -S "$BACKUP_TMP/agent/sanctuary.ouro/state/acceptance/telegram-control.sock" \
      && validate_sanctuary_roots "$BACKUP_TMP/runtime/.ouro-cli" "$BACKUP_TMP/agent/sanctuary.ouro" \
      && docker container inspect ouro-butler >"$BACKUP_TMP/provenance/container-inspect.json" \
      && printf '%s\n' "$BACKUP_IMAGE_ID" >"$BACKUP_TMP/provenance/image-id" \
      && chown 0:0 "$BACKUP_TMP/provenance/container-inspect.json" "$BACKUP_TMP/provenance/image-id" \
      && chmod 0600 "$BACKUP_TMP/provenance/container-inspect.json" "$BACKUP_TMP/provenance/image-id" \
      && (cd "$BACKUP_TMP" && find runtime agent provenance -xdev -type f ! -path provenance/manifest.sha256 -exec sha256sum -- {} + | LC_ALL=C sort -k2 >provenance/manifest.sha256) \
      && chown 0:0 "$BACKUP_TMP/provenance/manifest.sha256" \
      && chmod 0600 "$BACKUP_TMP/provenance/manifest.sha256" \
      && verify_sanctuary_snapshot_provenance "$BACKUP_TMP" "$BACKUP_IMAGE_ID" \
      && sync -f "$BACKUP_TMP/provenance/manifest.sha256" \
      && mv -- "$BACKUP_TMP" "$BACKUP_ROOT" \
      && sync -f "$BACKUP_PARENT"; then
      :
    else
      BACKUP_OPERATION_STATUS=$?
    fi
    if assert_update_source "$BACKUP_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" \
      && docker start ouro-butler \
      && assert_only_running_butler ouro-butler \
      && wait_butler_ready ouro-butler \
      && verify_butler_autostart "$BACKUP_AUTOSTART_COUNTS"; then
      :
    else
      BACKUP_RECOVERY_STATUS=$?
      if test -d "$BACKUP_ROOT"; then
        printf '%s\n' "CRITICAL: production recovery failed after backup; completed snapshot remains intact at $BACKUP_ROOT" >&2
      else
        printf '%s\n' "CRITICAL: production recovery failed and no completed snapshot was published; inspect $BACKUP_TMP" >&2
      fi
      (exit "$BACKUP_RECOVERY_STATUS")
    fi
    if test "$BACKUP_OPERATION_STATUS" -ne 0; then
      if test -d "$BACKUP_ROOT"; then
        printf '%s\n' "Backup publication was not durably confirmed; production was recovered; completed snapshot remains intact at $BACKUP_ROOT" >&2
      else
        printf '%s\n' "Backup failed before atomic publication; production was recovered; inspect $BACKUP_TMP" >&2
      fi
      (exit "$BACKUP_OPERATION_STATUS")
    fi

Restore:
  Set BACKUP_ROOT to the exact verified snapshot containing `runtime/.ouro-cli`
  and `agent/sanctuary.ouro`, set IMAGE_ID to its recorded local image ID, and
  set AUDIT_RUNNER_IMAGE_ID to the exact reviewed new image containing the
  legacy-aware auditor. The runner is independent from the restored image.
    AUDIT_RUNNER_IMAGE_TAG=ouro-butler:<new-version>
    AUDIT_RUNNER_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$AUDIT_RUNNER_IMAGE_TAG")
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
    /boot/config/custom/ouro-events/bootstrap-spool.sh --mount
    test "$(findmnt -n -o FSTYPE --target /boot/config/custom/ouro-events/spool)" = tmpfs
    test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/spool)" = 0:0:755
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
      && validate_sanctuary_roots /mnt/user/appdata/ouro-butler/runtime/.ouro-cli /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro \
      && docker image inspect "$IMAGE_ID" >/dev/null \
      && docker create --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
      --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
      --mount "type=bind,src=/boot/config/custom/ouro-events/spool,dst=/run/ouro-events,readonly" \
      "$IMAGE_ID" \
      && audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" \
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
  Run `bootstrap_sanctuary_vault "$IMAGE_ID"` interactively before installing
  credentials. It uses only fresh `--rm` containers from that exact image as
  UID/GID 10001 with the canonical two binds; create/unlock is the sole `-it`
  action so the master secret remains on the hidden terminal prompt.
   Its first read-only `vault status` is authoritative: it runs `vault create`
   only when the locator is absent, runs `vault unlock` only when the locator
   exists but local unlock is missing, and does not prompt when local unlock is
  already available. It then requires the configured locator, available local
  unlock, and successful auth verification. Never guess from a failed status
  command.
  Initial legacy adoption passes the exact legacy envelope path as the helper's
  second argument. After vault availability, the helper validates and atomically
  copies that envelope into the canonical runtime root, imports it with a fresh
  same-image one-shot container, and requires both canonical source and claim to
  be absent before provider readiness. The exact legacy source remains untouched
  as rollback evidence until canonical acceptance completes.
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

Packaged deployment-target containment gates:
  Unit 16 is fixed to the `staging` profile and therefore targets only
  `ouro-butler-staging`; it does not require `ouro-butler` to exist. Before the
  broker starts, the packaged deployment auditor captures all present canonical
  production/staging/rollback identities in one Docker inspect, verifies the
  target image, `unless-stopped`, host networking, matching GraphQL and durable
  file autostart identity/state for every present canonical container,
  and exactly one running Butler, then repeats the canonical snapshot to reject
  races. It binds the target PID and exact Docker cgroup-v2 path to the inspected
  container ID; Unit 16 carries that immutable ID into every launcher and broker
  Docker operation and binds it to the GraphQL PrefixedID suffix. It scans every
  cgroup process and requires stable before/after process, owned-socket, and
  listener inventories. Between the two canonical topology captures, it verifies
  the exact immutable-ID target is running and unpaused, pauses that ID without
  changing restart or autostart state, and performs every cgroup, all-thread
  descriptor, TCP, UDP, and Unix observation inside that one quiesced window,
  including two matching complete terminal snapshots; nonconvergence fails
  closed after eight attempts. It always makes bounded exact-ID unpause attempts,
  verifies the same ID and PID resumed their original running, unpaused state,
  and only then performs the final full-profile topology capture. It
  rejects every owned UDP listener and every externally reachable owned TCP listener. Only loopback
  Mailbox port 6876 plus stream-listening endpoints at the fixed daemon and
  acceptance Unix control paths are permitted; all other named Unix endpoint
  types (including datagrams) fail closed. Inherited descriptors for the same
  socket inode are deduplicated, while unknown loopback ports, wildcard/host-address
  listeners, process/socket/listener drift, or ambiguous ownership fail closed.
  Unit 18 uses the separately packaged fixed final command after activation.
  It accepts either the legacy-adoption topology with no canonical rollback or
  exactly one stopped, non-autostarted rollback; running/autostarted rollback,
  staging presence, and ambiguous canonical identities always fail closed:
    UNIT18_TARGET_TMP=$(mktemp /run/sanctuary-unit18-target-audit.sh.XXXXXX)
    /usr/bin/timeout -s KILL 20 /usr/bin/docker run --rm --pull=never --network none \
      --entrypoint /bin/cat "$IMAGE_ID" /opt/ouro/deploy/unraid/sanctuary-unit18-target-audit.sh >"$UNIT18_TARGET_TMP"
    chmod 0500 "$UNIT18_TARGET_TMP"
    "$UNIT18_TARGET_TMP" "$IMAGE_ID"
    rm -f -- "$UNIT18_TARGET_TMP"
  Neither packaged command accepts a container name or an open-ended profile.

Packaged Unit 16 acceptance execution:
  Use only the launcher packaged in the exact reviewed image. Install it without
  network access, then create the two private roots with the runtime UID/GID:
    UNIT16_ROOT=/mnt/user/appdata/ouro-butler/acceptance
    install -d -m 0700 -o 10001 -g 10001 "$UNIT16_ROOT/configs" "$UNIT16_ROOT/evidence"
    UNIT16_LAUNCHER_TMP=$(mktemp "$UNIT16_ROOT/sanctuary-unit16-run.sh.tmp.XXXXXX")
    /usr/bin/timeout -s KILL 20 /usr/bin/docker run --rm --pull=never --network none \
      --entrypoint /bin/cat "$IMAGE_ID" /opt/ouro/deploy/unraid/sanctuary-unit16-run.sh >"$UNIT16_LAUNCHER_TMP"
    install -m 0755 -o root -g root "$UNIT16_LAUNCHER_TMP" "$UNIT16_ROOT/sanctuary-unit16-run.sh"
    rm -f -- "$UNIT16_LAUNCHER_TMP"
  After final activation, create the disjoint final-profile roots and invoke the
  same immutable launcher with its only non-staging selector. The selector is a
  closed `staging|final` enum; it never accepts a container name, ID, or path:
    UNIT18_ROOT=/mnt/user/appdata/ouro-butler/acceptance/final
    install -d -m 0700 -o 10001 -g 10001 "$UNIT18_ROOT/configs" "$UNIT18_ROOT/evidence"
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize evidence-snapshot
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final evidence-snapshot evidence-snapshot.json
  Use `--profile final` on every final pre-reboot and post-reboot materialize/run
  command. Omitting it remains the byte-for-byte Unit 16 staging path. Never mix
  staging and final config/evidence roots or reuse a config across profiles.
  Never hand-author a Unit 16 config. Materialize it from the exact image, then
  execute it in the order below. Before every execution the launcher regenerates
  the config from the packaged fixed contract and requires byte-for-byte equality.
  The cursor snapshot is deliberately materialized and executed twice around the
  live scenario. Telegram bootstrap reads the new bot token from host file
  descriptor 3; callback injection reads the reviewed saved callback-update JSON
  from the same descriptor. The launcher explicitly maps host fd 3 to Docker
  stdin and then to in-container fd 3 only for those two commands. Neither value
  belongs in argv, shell history, a config file, or an unrelated command's stdin.
  Define this Bash helper in the root shell. It disables terminal echo while
  reading the token, opens an anonymous descriptor for the launcher, and unsets
  the short-lived shell value on either launcher success or failure:
    run_unit16_telegram_bootstrap() {
      local UNIT16_BOT_TOKEN UNIT16_BOT_STATUS
      printf 'Telegram bot token: ' >&2
      IFS= read -r -s UNIT16_BOT_TOKEN || return $?
      printf '\n' >&2
      if "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" telegram-bootstrap telegram-bootstrap.json \
        3< <(printf '%s\n' "$UNIT16_BOT_TOKEN"); then
        UNIT16_BOT_STATUS=0
      else
        UNIT16_BOT_STATUS=$?
      fi
      unset UNIT16_BOT_TOKEN
      return "$UNIT16_BOT_STATUS"
    }
  Stage the reviewed callback JSON at the fixed path below in the root-owned
  tmpfs inbox, then use this single fail-closed helper. It opens the input once,
  validates the opened descriptor and its original path refer to the same
  root-owned mode-0600 regular file, and invokes the launcher only afterward.
  Success overwrites, fsyncs, and unlinks the raw input. Any failure allocates a
  collision-free quarantine file atomically, copies and fsyncs the input into it,
  locks it to mode 000, then overwrites and removes the tmpfs source;
  no raw callback update remains loose in `/root` or the inbox.
    UNIT16_CALLBACK_INBOX=/run/ouro-unit16-callback-input
    UNIT16_CALLBACK_FILE=$UNIT16_CALLBACK_INBOX/callback-update.json
    UNIT16_CALLBACK_QUARANTINE_ROOT=$UNIT16_ROOT/callback-quarantine
    install -d -m 0700 -o root -g root "$UNIT16_CALLBACK_INBOX" "$UNIT16_CALLBACK_QUARANTINE_ROOT"
    run_unit16_callback_inject() {
      (
      UNIT16_CALLBACK_VALIDATED=no
      UNIT16_CALLBACK_STATUS=1
      unit16_callback_cleanup() {
        UNIT16_CALLBACK_STATUS=$?
        trap - EXIT HUP INT TERM
        if test -e "$UNIT16_CALLBACK_FILE" || test -L "$UNIT16_CALLBACK_FILE"; then
          if test "$UNIT16_CALLBACK_STATUS" -eq 0 && test "$UNIT16_CALLBACK_VALIDATED" = yes; then
            if ! truncate -s 0 /proc/self/fd/3 || ! sync -f /proc/self/fd/3 \
              || ! rm -f -- "$UNIT16_CALLBACK_FILE" || ! sync -f "$UNIT16_CALLBACK_INBOX"; then
              UNIT16_CALLBACK_STATUS=1
            fi
          elif test -f "$UNIT16_CALLBACK_FILE" && test ! -L "$UNIT16_CALLBACK_FILE"; then
            UNIT16_CALLBACK_QUARANTINE_FILE=$(mktemp "$UNIT16_CALLBACK_QUARANTINE_ROOT/failed.XXXXXX") || UNIT16_CALLBACK_QUARANTINE_FILE=
            if test -n "$UNIT16_CALLBACK_QUARANTINE_FILE" \
              && chmod 0600 "$UNIT16_CALLBACK_QUARANTINE_FILE" \
              && cp -- "$UNIT16_CALLBACK_FILE" "$UNIT16_CALLBACK_QUARANTINE_FILE" \
              && sync -f "$UNIT16_CALLBACK_QUARANTINE_FILE" \
              && chmod 000 "$UNIT16_CALLBACK_QUARANTINE_FILE" \
              && sync -f "$UNIT16_CALLBACK_QUARANTINE_ROOT"; then
              :
            else
              test -z "${UNIT16_CALLBACK_QUARANTINE_FILE-}" || rm -f -- "$UNIT16_CALLBACK_QUARANTINE_FILE"
              UNIT16_CALLBACK_STATUS=1
            fi
            if ! truncate -s 0 "$UNIT16_CALLBACK_FILE" || ! sync -f "$UNIT16_CALLBACK_FILE" \
              || ! rm -f -- "$UNIT16_CALLBACK_FILE" || ! sync -f "$UNIT16_CALLBACK_INBOX"; then
              UNIT16_CALLBACK_STATUS=1
            fi
          else
            rm -f -- "$UNIT16_CALLBACK_FILE" || UNIT16_CALLBACK_STATUS=1
            sync -f "$UNIT16_CALLBACK_INBOX" || UNIT16_CALLBACK_STATUS=1
          fi
        fi
        exec 3<&-
        exit "$UNIT16_CALLBACK_STATUS"
      }
      trap unit16_callback_cleanup EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      test -d "$UNIT16_CALLBACK_INBOX" && test ! -L "$UNIT16_CALLBACK_INBOX" || exit 1
      test "$(stat -c '%F %u:%g %a' "$UNIT16_CALLBACK_INBOX")" = "directory 0:0 700" || exit 1
      test -d "$UNIT16_CALLBACK_QUARANTINE_ROOT" && test ! -L "$UNIT16_CALLBACK_QUARANTINE_ROOT" || exit 1
      test "$(stat -c '%F %u:%g %a' "$UNIT16_CALLBACK_QUARANTINE_ROOT")" = "directory 0:0 700" || exit 1
      test -f "$UNIT16_CALLBACK_FILE" && test ! -L "$UNIT16_CALLBACK_FILE" || exit 1
      exec 3<"$UNIT16_CALLBACK_FILE"
      test "$(stat -Lc '%F' /proc/self/fd/3)" = "regular file" || exit 1
      test "$(stat -c '%d:%i' "$UNIT16_CALLBACK_FILE")" = "$(stat -Lc '%d:%i' /proc/self/fd/3)" || exit 1
      UNIT16_CALLBACK_VALIDATED=yes
      test "$(stat -Lc '%F %u:%g %a' /proc/self/fd/3)" = "regular file 0:0 600" || exit 1
      "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" callback-inject callback-inject.json 3<&3
      )
    }
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize telegram-bootstrap
    run_unit16_telegram_bootstrap
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize cursor-snapshot before
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" cursor-snapshot cursor-snapshot.json
    # Perform the live scenario whose cursor movement is being measured.
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize cursor-snapshot after
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" cursor-snapshot cursor-snapshot.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize cursor-delta
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" cursor-delta cursor-delta.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize callback-inject
    run_unit16_callback_inject
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize unraid-key-rotate
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" unraid-key-rotate unraid-key-rotate.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize reboot-request
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" reboot-request reboot-request.json
    # The preceding command captures and seals preflight evidence before it asks
    # the broker to stage the reboot, then seals the requested-phase evidence and
    # fsyncs the requested checkpoint before invoking the host reboot. Reconnect
    # only after Unraid and Docker are ready.
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize reboot-resume
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" reboot-resume reboot-resume.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize evidence-snapshot
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" evidence-snapshot evidence-snapshot.json
    # reboot-resume seals the changed boot identity and recovery milestones.
    # evidence-snapshot then runs the remaining scenarios sequentially with a
    # 72-minute aggregate bound; each completed scenario records provenance at
    # capture time and always clears its public gate, private marker, and receipt.
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize evidence-bundle-index
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" evidence-bundle-index evidence-bundle-index.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" materialize evidence-bundle-verify
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" evidence-bundle-verify evidence-bundle-verify.json
  Each execution revalidates the immutable image and the production container's
  exact image ID. The main one-shot gets a read-only root filesystem, one writable
  evidence mount, narrowly selected runtime/bundle modes, and individual read-only
  image/container/health/boot fact files. Host-only operations cross an ephemeral
  root-owned private Unix socket (root:10001 mode 0660) to a root broker extracted
  from the same exact image. The broker accepts only fixed Unraid inventory/create/
  exact-revoke/rejection operations, exact fixed-target snapshots, and a
  two-phase reboot reservation/final commit. Reservation drains queued owner
  mutations and rejects new ones; after the requested checkpoint is fsynced, the
  broker repeats the array/parity/mover/durable-health preflight and invokes the
  fixed host reboot itself exactly once. The Unit 16 broker inspects only the
  deployment profile's attested immutable container ID (staging is
  `ouro-butler-staging`), requires its immutable image ID, writes that exact typed/redacted
  snapshot before accepting requests, and exposes a nonnegative Docker restart
  count. Both initial and refreshed snapshots share the same exact schema. The
  broker derives `autostartExact` from both the Unraid GraphQL `autoStart` value
  and exactly one staging entry in `/var/lib/docker/unraid-autostart`, derives
  `updaterDisabled` from `/opt/ouro/container-runtime.json` inside the exact image,
  and derives `vaultUnlocked`/`manualAuthRequired` from a bounded live Sanctuary
  vault-status command only when its non-secret summary proves the required
  Telegram runtime fields and both configured provider records were freshly read.
  Scenario handles remain private to the scenario adapter. The main one-shot
  never receives the Docker socket, Unraid key directory, or a host-root mount.
  Telegram bootstrap additionally brackets its one-shot with a host-controlled
  poller quiescence guard: it verifies the exact healthy staging container,
  assumes recovery responsibility before attempting the stop, stops it with a
  30-second grace bound, proves it is stopped, and mounts a
  root-owned typed zero-poller fact. Its exit/signal trap restarts that same exact
  container and waits up to 120 seconds for healthy recovery on both success and
  failure. It never reads or changes Unraid autostart configuration. Every command
  also receives a freshly generated, redacted typed container-inspect snapshot;
  raw container environment or credential values are never captured.
  Evidence-snapshot keeps the bundle mount read-only and overlays only the exact
  canonical `state/acceptance` directory as writable. It first stops the exact
  healthy staging container under recovery responsibility, then opens the
  directory with `O_DIRECTORY|O_NOFOLLOW` and bind-mounts from the inherited fd
  while no Sanctuary UID process is running. The launcher bind-pins that inode
  behind a root-only alias and back onto the canonical path against rename swaps,
  restarts the same exact image healthy, and compares the alias, canonical path,
  and staging container's inode before and after capture. Cleanup unmounts the
  canonical pin and then the alias. The staging daemon therefore sees the same
  inode used by the one-shot for marker correlation.

Audit and safety verification:
  Inspect AgentBundles/sanctuary.ouro/state/approvals for durable approval and
  restart-attempt receipts. Confirm no Docker socket/device/host-root mounts and
  no published ports with docker inspect. Confirm Config.Image equals the exact
  reviewed local image ID, not the build tag. The read key must reject Docker
  stop and restart mutations; only the separate write key may perform the one
  typed approved restart action.
  The packaged `unraid-key-rotate` command is the only canonical key-rotation
  authority. It inventories the two occupied canonical names by exact immutable
  ID, creates collision-safe `Butler RO Rotation <suffix>` and
  `Butler RW Rotation <suffix>` keys, stores and capability-probes both through
  the Sanctuary machine vault, and requires an exact four-key inventory. It then
  revokes both old IDs and proves each old credential receives a 401 or 403.
  Only after an exact inventory contains the temporary pair alone does it create,
  store, and probe the canonical `Butler RO` and `Butler RW` pair. It requires an
  exact four-key temporary-plus-canonical inventory, revokes and rejection-probes
  both temporary IDs, and finally requires exactly the canonical pair. Every
  unexpected key, duplicate, malformed permission set, role, name, inventory
  delta, or probe response fails closed.

  Record only IDs, names, and permission sets in evidence; never raw key values.
  Raw credentials must not appear in argv, shell history, stdout, logs, or
  acceptance evidence. They may cross only the ephemeral private Unit 16 Unix
  socket in process memory. The narrow revocation-retry recovery records under
  `/mnt/user/appdata/ouro-butler/acceptance/revoked-key-proof` are the sole file
  exception: they are root-owned mode 0600 beneath a root-owned mode 0700
  directory, excluded from backup/evidence, streamed only on standard input to
  the bounded rejection probe, retained across failed retries, and durably
  deleted only after the exact authentication rejection is validated. Never
  substitute names for IDs when revoking keys.
