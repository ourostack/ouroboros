Mendelow Cloud Butler operator runbook

The production container is ouro-butler. It runs as UID/GID 10001, publishes no ports, uses host networking only so its loopback-only Unraid GraphQL client can reach 127.0.0.1, mounts the runtime and sanctuary.ouro bundle read-write plus the privileged event spool read-only, and uses restart policy unless-stopped. The canonical-gateway image appends exactly /run/ouro-authority -> /run/ouro-authority, readonly, rprivate. The pinned alpha.816 predecessor has only the first three mounts. Root token, issuer, package and authority state are never mounted into the resident.

Root authority lifecycle

The existing DockerMan transaction owns authority-install, authority-activate, authority-retire and authority-restore. A complete exact-image package, including dist and production dependencies, must remain at its package-relative paths; extracting only the old five deployment assets cannot execute this lifecycle. The reviewed root-only inputs are /mnt/user/appdata/ouro-authority/incoming-package, package-manifest.json, request.json and incoming-token. They are not a new resident credential policy. The human rotates the existing bot token directly into root custody; the root owner proves the previous token returns 401 and the fresh token belongs to the same numeric bot before continuing.

During installation the resident is stopped, the root gateway is installed and proven, tokenless readiness runs, and authority-activate starts the exact four-mount target. On failure, authority-retire must finish before restoring bundle/config/mounts or starting the exact three-mount predecessor; authority-restore proves that rollback before the outer template journal is removed. An uncertain or interrupted handoff leaves autostart disabled and preserves both journals and root inputs for the same reviewed recovery, never a raw old-template start. Retired keys, policy, history and Jellyfin remain untouched. Re-enabling authority requires a new human token rotation and issuer epoch, not reuse of retired authority.

On installed cold boot, the original unless-stopped and DockerMan autostart remain unchanged: /boot/config/custom/ouro-authority/start.sh --boot waits for the array and responsive Docker, then starts the fenced root gateway. Docker may already have started the tokenless resident; it fails closed until the gateway is ready. There is no pre-Docker gate, whole-array gate, resident direct poller or resident token fallback.

Bounded Jellyfin stewardship

Do not start a weak predecessor after policy exists. Once live A-006 authority has been provisioned, repair by forward-fixing and installing another policy-aware image through the existing exact-image update procedure. Its transaction mechanics are unchanged; a stopped older image is not permission to resume weaker policy enforcement.

Packaged desired states and grants remain empty. Build and installation create no authority and do not restart Jellyfin. Package migration preserves the live policy, audit and action-receipt bytes, including on a repeated migration.

A standing restart requires the intersection of an applied owner-stated positive desired state, an applied owner-stated grant and a fresh authorized request or exact current health event. Values on, always_on and expected_on permit either request-driven or event-driven evaluation; on_demand permits current owner or household requests only. Active off, disabled, paused, intentionally_off or intentionally_paused states deny mutation and make an unchanged expected health condition quiet. Missing, expired, inferred, unaudited, conflicted or mismatched positive state cannot authorize a standing restart. Installation provenance is not owner-stated authority.

Provision only after the policy-aware image is healthy and its package and running-image identities agree. Ari must supply a fresh authenticated owner Telegram message after installation. This runbook, old messages, agent-written setup text and installation records are not that authorization. The approved setup terms are container:jellyfin=on with no desired-state expiry; grant key unraid.restart:jellyfin, action unraid.container.restart, target jellyfin, 2 attempts per 1800000 ms, verificationRequired=true, exclusions=[], provenance=stated, and grant expiry exactly 365 days after authorization.

Use the existing steward_policy_manage actions sequentially: set_desired_state -> read -> grant_routine_action -> read. Carry the current readback version into each write. The first write must be applied and read back before the grant; desired state alone cannot authorize action. The final read must show both exact keys and versions, the stated provenance, rate, verification requirement, exclusions and calculated expiry. The two writes must have two linked applied v2 rows in state/policy/policy-audit.ndjson. Do not edit policy files directly or fabricate the authorizing event.

Use steward_policy_manage read for current policy and state/policy/action-receipts.ndjson for reservation and outcome evidence. Durable reservations count toward the limit, not only successful restarts. A reservation or attempt is not proof of a successful effect: retain definite no-effect, failed, indeterminate and verified-success outcomes without replaying an uncertain attempt. Fresh relationship, request, policy, grant, reservation and exact target checks still apply immediately before mutation.

When an owner request has only a missing or expired grant and no active negative desired state, the existing one-time owner approval path remains available. A conflicting negative state requires clarification or a policy update, not an approval workaround. Household and event denials never create a self-approval card.

Never manufacture a Jellyfin outage to demonstrate the grant. Record a natural event or ordinary request if one occurs; otherwise report organic operation as unobserved, separately from installed and provisioned state.

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
      AUDIT_MOUNT_CONTRACT=${4-}
      AUDIT_EXPECTED_IMAGE_REFERENCE=${5-}
      AUDIT_EXPECTED_ICON=${6-}
      validate_exact_image_id "$AUDIT_EXPECTED_IMAGE" || return $?
      validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID" || return $?
      test "$AUDIT_RUNNER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return $?
      case "$AUDIT_MOUNT_CONTRACT" in
        canonical-pre-gateway|canonical-gateway)
        test -n "$AUDIT_EXPECTED_IMAGE_REFERENCE" || return 1
        test "$AUDIT_EXPECTED_ICON" = https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png || return 1
        set -- --mount-contract "$AUDIT_MOUNT_CONTRACT" --expected-image-reference "$AUDIT_EXPECTED_IMAGE_REFERENCE" --expected-icon "$AUDIT_EXPECTED_ICON"
        ;;
        legacy-alpha742) set -- --mount-contract "$AUDIT_MOUNT_CONTRACT" ;;
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
        --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
        --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
        --mount "type=bind,src=$INSPECT_DIR/container.json,dst=/audit/container.json,readonly" \
        --mount "type=bind,src=$INSPECT_DIR/image.json,dst=/audit/image.json,readonly" \
        "$AUDIT_RUNNER_IMAGE_ID" --inspect /audit/container.json --image-inspect /audit/image.json --expected-image "$AUDIT_EXPECTED_IMAGE" "$@" || return $?
      rm -f -- "$INSPECT_DIR/container.json" "$INSPECT_DIR/image.json" || return $?
      rmdir -- "$INSPECT_DIR" || return $?
      trap - EXIT || return $?
      )
    }
    inspect_registry_manifest_digest() {
      (
      REGISTRY_MANIFEST_REFERENCE=$1
      REGISTRY_MANIFEST_PATH=$(mktemp /tmp/ouro-registry-manifest.XXXXXX) || return $?
      trap 'rm -f -- "$REGISTRY_MANIFEST_PATH"' EXIT || return $?
      docker buildx imagetools inspect "$REGISTRY_MANIFEST_REFERENCE" --raw >"$REGISTRY_MANIFEST_PATH" || return $?
      REGISTRY_MANIFEST_SHA256=$(sha256sum -- "$REGISTRY_MANIFEST_PATH") || return $?
      REGISTRY_MANIFEST_SHA256=${REGISTRY_MANIFEST_SHA256%% *}
      printf 'sha256:%s\n' "$REGISTRY_MANIFEST_SHA256"
      )
    }
  Define these helpers in the same root shell. Each profile change calls Unraid's
  own root-local Docker manager backend, after proving exact durable identities.
  A missing Butler entry is a no-op when disabling; this avoids the backend's
  false-to-index-zero behavior. The helper preserves every non-Butler row byte
  for byte and restores the complete captured file atomically on any failure:
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
    snapshot_nonbutler_autostart() {
      awk '
        $1 != "ouro-butler" && $1 != "ouro-butler-staging" && $1 != "ouro-butler-rollback" && $1 != "ouro-butler-legacy-evidence" { print }
      ' /var/lib/docker/unraid-autostart
    }
    run_unraid_autostart_backend() {
      (
      AUTOSTART_ACTION=$1
      AUTOSTART_CONTAINER=$2
      AUTOSTART_VALUE=$3
      case "$AUTOSTART_ACTION:$AUTOSTART_VALUE" in wait:0|autostart:true|autostart:false) ;; *) return 1 ;; esac
      case "$AUTOSTART_CONTAINER" in
        ouro-butler|ouro-butler-staging|ouro-butler-rollback|ouro-butler-legacy-evidence) ;;
        *) return 1 ;;
      esac
      timeout -s KILL 20 /usr/bin/php -r '
        [$action, $container, $value] = array_slice($argv, 1);
        $allowed = ["ouro-butler", "ouro-butler-staging", "ouro-butler-rollback", "ouro-butler-legacy-evidence"];
        if (!in_array($container, $allowed, true)) exit(2);
        if ($action === "wait" && $value === "0") {
          $_POST = ["action" => "wait", "container" => $container, "wait" => "0"];
        } elseif ($action === "autostart" && ($value === "true" || $value === "false")) {
          $_POST = ["action" => "autostart", "container" => $container, "auto" => $value, "wait" => "0"];
        } else exit(2);
        $_SERVER["DOCUMENT_ROOT"] = "/usr/local/emhttp";
        $_SERVER["REQUEST_URI"] = "docker";
        require "/usr/local/emhttp/plugins/dynamix.docker.manager/include/UpdateConfig.php";
      ' "$AUTOSTART_ACTION" "$AUTOSTART_CONTAINER" "$AUTOSTART_VALUE"
      )
    }
    mutate_butler_autostart() {
      (
      AUTOSTART_CONTAINER=$1
      AUTOSTART_ENABLED=$2
      case "$AUTOSTART_CONTAINER" in
        ouro-butler|ouro-butler-staging|ouro-butler-rollback|ouro-butler-legacy-evidence) ;;
        *) return 1 ;;
      esac
      case "$AUTOSTART_ENABLED" in true|false) ;; *) return 1 ;; esac
      AUTOSTART_COUNT=$(awk -v name="$AUTOSTART_CONTAINER" '$1 == name { count++ } END { print count + 0 }' /var/lib/docker/unraid-autostart) || return $?
      case "$AUTOSTART_COUNT" in 0|1) ;; *) return 1 ;; esac
      if test "$AUTOSTART_ENABLED" = false && test "$AUTOSTART_COUNT" -eq 0; then
        return 0
      fi
      if test "$AUTOSTART_COUNT" -eq 1; then
        run_unraid_autostart_backend wait "$AUTOSTART_CONTAINER" 0 || return $?
      fi
      if test "$AUTOSTART_ENABLED" = false; then
        run_unraid_autostart_backend autostart "$AUTOSTART_CONTAINER" false || return $?
        AUTOSTART_EXPECTED_COUNT=0
      else
        if test "$AUTOSTART_COUNT" -eq 0; then
          run_unraid_autostart_backend autostart "$AUTOSTART_CONTAINER" true || return $?
        fi
        AUTOSTART_EXPECTED_COUNT=1
      fi
      AUTOSTART_COUNT=$(awk -v name="$AUTOSTART_CONTAINER" '$1 == name { count++ } END { print count + 0 }' /var/lib/docker/unraid-autostart) || return $?
      test "$AUTOSTART_COUNT" -eq "$AUTOSTART_EXPECTED_COUNT" || return $?
      )
    }
    set_butler_autostart() {
      (
      AUTOSTART_PROFILE=$1
      case "$AUTOSTART_PROFILE" in disabled|production|staging) ;; *) return 1 ;; esac
      test "$(id -u)" -eq 0 || return $?
      AUTOSTART_FILE=/var/lib/docker/unraid-autostart
      AUTOSTART_INCLUDE=/usr/local/emhttp/plugins/dynamix.docker.manager/include/UpdateConfig.php
      test -f "$AUTOSTART_FILE" && test ! -L "$AUTOSTART_FILE" || return 1
      test "$(stat -c '%u:%g:%a' "$AUTOSTART_FILE")" = 0:0:644 || return $?
      test -f "$AUTOSTART_INCLUDE" && test ! -L "$AUTOSTART_INCLUDE" || return 1
      test "$(stat -c '%u:%g:%a' "$AUTOSTART_INCLUDE")" = 0:0:644 || return $?
      AUTOSTART_COUNTS=$(butler_autostart_counts) || return $?
      set -- $AUTOSTART_COUNTS
      test "$#" -eq 4 || return $?
      for AUTOSTART_COUNT in "$@"; do case "$AUTOSTART_COUNT" in 0|1) ;; *) return 1 ;; esac; done
      case "$AUTOSTART_PROFILE" in
        production) docker container inspect ouro-butler >/dev/null 2>&1 || return $? ;;
        staging) docker container inspect ouro-butler-staging >/dev/null 2>&1 || return $? ;;
      esac
      AUTOSTART_BACKUP=$(mktemp /var/lib/docker/.unraid-autostart.ouro.XXXXXX) || return $?
      AUTOSTART_NONBUTLER_BEFORE=$(mktemp /run/unraid-autostart.nonbutler-before.XXXXXX) || { rm -f -- "$AUTOSTART_BACKUP"; return 1; }
      AUTOSTART_NONBUTLER_AFTER=$(mktemp /run/unraid-autostart.nonbutler-after.XXXXXX) || { rm -f -- "$AUTOSTART_BACKUP" "$AUTOSTART_NONBUTLER_BEFORE"; return 1; }
      AUTOSTART_COMMITTED=no
      AUTOSTART_BACKUP_READY=no
      AUTOSTART_RESTORE_TMP=
      autostart_cleanup() {
        AUTOSTART_STATUS=$?
        trap - EXIT HUP INT TERM
        if test "$AUTOSTART_COMMITTED" = yes; then
          rm -f -- "$AUTOSTART_BACKUP" || AUTOSTART_STATUS=1
        elif test "$AUTOSTART_BACKUP_READY" = yes; then
          AUTOSTART_RESTORE_TMP=$(mktemp /var/lib/docker/.unraid-autostart.restore.XXXXXX) || AUTOSTART_RESTORE_TMP=
          if test -n "$AUTOSTART_RESTORE_TMP" \
            && cp -p -- "$AUTOSTART_BACKUP" "$AUTOSTART_RESTORE_TMP" \
            && sync -f "$AUTOSTART_RESTORE_TMP" \
            && mv -f -- "$AUTOSTART_RESTORE_TMP" "$AUTOSTART_FILE" \
            && sync -f "$AUTOSTART_FILE" \
            && sync -f /var/lib/docker; then
            rm -f -- "$AUTOSTART_BACKUP" || AUTOSTART_STATUS=1
          else
            test -z "$AUTOSTART_RESTORE_TMP" || rm -f -- "$AUTOSTART_RESTORE_TMP"
            printf 'CRITICAL: Butler autostart rollback failed; recovery copy preserved at %s\n' "$AUTOSTART_BACKUP" >&2
            AUTOSTART_STATUS=1
          fi
        else
          rm -f -- "$AUTOSTART_BACKUP" || AUTOSTART_STATUS=1
        fi
        rm -f -- "$AUTOSTART_NONBUTLER_BEFORE" "$AUTOSTART_NONBUTLER_AFTER" || AUTOSTART_STATUS=1
        exit "$AUTOSTART_STATUS"
      }
      trap autostart_cleanup EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      cp -p -- "$AUTOSTART_FILE" "$AUTOSTART_BACKUP" || return $?
      cmp -s -- "$AUTOSTART_FILE" "$AUTOSTART_BACKUP" || return 1
      sync -f "$AUTOSTART_BACKUP" || return $?
      sync -f /var/lib/docker || return $?
      AUTOSTART_BACKUP_READY=yes
      snapshot_nonbutler_autostart >"$AUTOSTART_NONBUTLER_BEFORE" || return $?
      case "$AUTOSTART_PROFILE" in
        production) AUTOSTART_TARGET=ouro-butler ;;
        staging) AUTOSTART_TARGET=ouro-butler-staging ;;
        disabled) AUTOSTART_TARGET=- ;;
      esac
      for AUTOSTART_CONTAINER in ouro-butler ouro-butler-staging ouro-butler-rollback ouro-butler-legacy-evidence; do
        test "$AUTOSTART_CONTAINER" = "$AUTOSTART_TARGET" && continue
        mutate_butler_autostart "$AUTOSTART_CONTAINER" false || return $?
      done
      test "$AUTOSTART_TARGET" = - || mutate_butler_autostart "$AUTOSTART_TARGET" true || return $?
      case "$AUTOSTART_PROFILE" in
        production) AUTOSTART_EXPECTED_COUNTS="1 0 0 0" ;;
        staging) AUTOSTART_EXPECTED_COUNTS="0 1 0 0" ;;
        disabled) AUTOSTART_EXPECTED_COUNTS="0 0 0 0" ;;
      esac
      verify_butler_autostart "$AUTOSTART_EXPECTED_COUNTS" || return $?
      snapshot_nonbutler_autostart >"$AUTOSTART_NONBUTLER_AFTER" || return $?
      cmp -s -- "$AUTOSTART_NONBUTLER_BEFORE" "$AUTOSTART_NONBUTLER_AFTER" || return 1
      sync -f "$AUTOSTART_FILE" || return $?
      sync -f /var/lib/docker || return $?
      AUTOSTART_COMMITTED=yes
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
      set_butler_autostart disabled || return $?
      verify_butler_autostart "0 0 0 0" || return $?
    }
    enable_butler_autostart() {
      set_butler_autostart production || return $?
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
  exact Docker image IDs and container identity, image provenance, and writable
  root overlap; no mutation is performed:
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
    sanctuary_image_mount_contract() {
      (
      CONTRACT_IMAGE_ID=$1
      validate_exact_image_id "$CONTRACT_IMAGE_ID" || return $?
      CONTRACT_LABEL=$(docker image inspect --format '{{with .Config.Labels}}{{index . "bot.ouro.sanctuary.mount-contract"}}{{end}}' "$CONTRACT_IMAGE_ID") || return $?
      case "$CONTRACT_IMAGE_ID:$CONTRACT_LABEL" in
        sha256:589b7cf8f96d139ee9fd86204a183126aadcbd3fbfb406063709be303397b1b2:) printf '%s\n' canonical-pre-gateway ;;
        sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d:) printf '%s\n' legacy-alpha742 ;;
        sha256:589b7cf8f96d139ee9fd86204a183126aadcbd3fbfb406063709be303397b1b2:*|sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d:*) return 1 ;;
        *:canonical-gateway) printf '%s\n' canonical-gateway ;;
        *) printf '%s\n' 'Unreviewed image mount contract; refusing version-only classification.' >&2; return 1 ;;
      esac
      )
    }
    create_sanctuary_container() {
      (
      CREATE_IMAGE_ID=$1
      CREATE_IMAGE_REFERENCE=$2
      CREATE_MOUNT_CONTRACT=$3
      test "$(sanctuary_image_mount_contract "$CREATE_IMAGE_ID")" = "$CREATE_MOUNT_CONTRACT" || return 1
      test "$(docker image inspect --format '{{.Id}}' "$CREATE_IMAGE_REFERENCE")" = "$CREATE_IMAGE_ID" || return 1
      case "$CREATE_MOUNT_CONTRACT" in
        canonical-gateway) set -- --mount "type=bind,src=/run/ouro-authority,dst=/run/ouro-authority,readonly" ;;
        canonical-pre-gateway) set -- ;;
        *) return 1 ;;
      esac
      docker create --pull=never --name ouro-butler --network host --restart unless-stopped --user 10001:10001 \
        --label net.unraid.docker.managed=dockerman \
        --label "net.unraid.docker.icon=https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png" \
        --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --mount "type=bind,src=/boot/config/custom/ouro-events/spool,dst=/run/ouro-events,readonly" \
        "$@" "$CREATE_IMAGE_REFERENCE" || return $?
      )
    }
    assert_only_running_butler() {
      (
      EXPECTED_RUNNING_BUTLER=$1
      case "$EXPECTED_RUNNING_BUTLER" in
        -) EXPECTED_RUNNING_BUTLER_COUNT=0 ;;
        ouro-butler|ouro-butler-staging) EXPECTED_RUNNING_BUTLER_COUNT=1 ;;
        *) return 1 ;;
      esac
      RUNNING_CONTAINER_IDS=$(docker container ls -q) || return $?
      MATCHING_RUNNING_BUTLERS=0
      for RUNNING_CONTAINER_ID in $RUNNING_CONTAINER_IDS; do
        RUNNING_CONTAINER_NAME=$(docker container inspect --format '{{.Name}}' "$RUNNING_CONTAINER_ID") || return $?
        RUNNING_CONTAINER_NAME=${RUNNING_CONTAINER_NAME#/}
        if test "$RUNNING_CONTAINER_NAME" = "$EXPECTED_RUNNING_BUTLER"; then
          MATCHING_RUNNING_BUTLERS=$(( MATCHING_RUNNING_BUTLERS + 1 ))
          continue
        fi
        RUNNING_CONTAINER_IMAGE_ID=$(docker container inspect --format '{{.Image}}' "$RUNNING_CONTAINER_ID") || return $?
        RUNNING_CONTAINER_IMAGE_REF=$(docker container inspect --format '{{.Config.Image}}' "$RUNNING_CONTAINER_ID") || return $?
        RUNNING_CONTAINER_IMAGE_SOURCE=$(docker image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.source"}}{{end}}' "$RUNNING_CONTAINER_IMAGE_ID") || return $?
        test "$RUNNING_CONTAINER_IMAGE_SOURCE" != https://github.com/ourostack/ouroboros || return 1
        test "$RUNNING_CONTAINER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return 1
        case "$RUNNING_CONTAINER_IMAGE_REF" in
          ouro-butler|ouro-butler:*|ouro-butler@sha256:*|ouroboros-butler|ouroboros-butler:*|ouroboros-butler@sha256:*|ghcr.io/ourostack/ouroboros-butler|ghcr.io/ourostack/ouroboros-butler:*|ghcr.io/ourostack/ouroboros-butler@sha256:*) return 1 ;;
        esac
        RUNNING_WRITABLE_MOUNT_SOURCES=$(docker container inspect --format '{{range .Mounts}}{{if .RW}}{{println .Source}}{{end}}{{end}}' "$RUNNING_CONTAINER_ID") || return $?
        if printf '%s\n' "$RUNNING_WRITABLE_MOUNT_SOURCES" | awk '
          function overlaps(path, root) {
            return length(path) > 0 && (path == root || index(path, root "/") == 1 || index(root, path "/") == 1)
          }
          overlaps($0, "/mnt/user/appdata/ouro-butler/runtime") || overlaps($0, "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli") || overlaps($0, "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro") || overlaps($0, "/mnt/user/appdata/ouro-butler/AgentBundles") { found = 1 }
          END { exit found ? 0 : 1 }
        '; then
          return 1
        fi
      done
      test "$MATCHING_RUNNING_BUTLERS" -eq "$EXPECTED_RUNNING_BUTLER_COUNT" || return $?
      )
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
    assert_sanctuary_update_source_pin() {
      (
      PIN_SOURCE_CONTAINER=$1
      PIN_SOURCE_IMAGE_ID=$2
      validate_exact_image_id "$PIN_SOURCE_IMAGE_ID" || return $?
      test "$(docker inspect --format '{{.Image}}' "$PIN_SOURCE_CONTAINER")" = "$PIN_SOURCE_IMAGE_ID" || return $?
      case "$PIN_SOURCE_CONTAINER $PIN_SOURCE_IMAGE_ID" in
        "ouro-butler sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d") return 0 ;;
        "ouro-butler "*) ;;
        *) return 1 ;;
      esac
      PIN_SOURCE_IMAGE_REFERENCE=$(docker inspect --format '{{.Config.Image}}' "$PIN_SOURCE_CONTAINER") || return $?
      printf '%s\n' "$PIN_SOURCE_IMAGE_REFERENCE" | grep -Eq '^ghcr\.io/ourostack/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || return $?
      test "$(docker image inspect --format '{{.Id}}' "$PIN_SOURCE_IMAGE_REFERENCE")" = "$PIN_SOURCE_IMAGE_ID" || return $?
      PIN_SOURCE_IMAGE_ORIGIN=$(docker image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.source"}}{{end}}' "$PIN_SOURCE_IMAGE_ID") || return $?
      test "$PIN_SOURCE_IMAGE_ORIGIN" = https://github.com/ourostack/ouroboros || return $?
      test "$(docker inspect --format '{{with .Config.Labels}}{{index . "net.unraid.docker.managed"}}{{end}}' "$PIN_SOURCE_CONTAINER")" = dockerman || return $?
      test "$(docker inspect --format '{{with .Config.Labels}}{{index . "net.unraid.docker.icon"}}{{end}}' "$PIN_SOURCE_CONTAINER")" = https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png
      )
    }
    assert_legacy_alpha742_source() {
      EXPECTED_SOURCE_IMAGE_ID=$1
      AUDIT_RUNNER_IMAGE_ID=$2
      assert_sanctuary_update_source_pin ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" || return $?
      audit_effective ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" legacy-alpha742
    }
    assert_update_source() {
      EXPECTED_SOURCE_IMAGE_ID=$1
      AUDIT_RUNNER_IMAGE_ID=$2
      if test "$EXPECTED_SOURCE_IMAGE_ID" = sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d; then
        assert_legacy_alpha742_source "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
      else
        assert_sanctuary_update_source_pin ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" || return $?
        EXPECTED_SOURCE_IMAGE_REFERENCE=$(docker inspect --format '{{.Config.Image}}' ouro-butler) || return $?
        EXPECTED_SOURCE_MOUNT_CONTRACT=$(sanctuary_image_mount_contract "$EXPECTED_SOURCE_IMAGE_ID") || return $?
        audit_effective ouro-butler "$EXPECTED_SOURCE_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" "$EXPECTED_SOURCE_MOUNT_CONTRACT" "$EXPECTED_SOURCE_IMAGE_REFERENCE" https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png
      fi
    }
    validate_sanctuary_roots() {
      (
      VALIDATE_RUNTIME_ROOT=$1
      VALIDATE_AGENT_ROOT=$2
      VALIDATE_CONTEXT=${3:-strict}
      case "$VALIDATE_CONTEXT" in strict|live-precutover) ;; *) return 1 ;; esac
      test -d "$VALIDATE_RUNTIME_ROOT" || return $?
      test -d "$VALIDATE_AGENT_ROOT" || return $?
      VALIDATE_CONTROL_SOCKET=$VALIDATE_AGENT_ROOT/state/acceptance/telegram-control.sock
      if test "$VALIDATE_CONTEXT" = live-precutover; then
        test ! -L "$VALIDATE_CONTROL_SOCKET" || return 1
        test -S "$VALIDATE_CONTROL_SOCKET" || return 1
        test "$(stat -c '%u:%g:%a' "$VALIDATE_CONTROL_SOCKET")" = 10001:10001:600 || return $?
        VALIDATE_BAD_SHAPE=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev \( -type l -o \( ! -type d -a ! -type f -a ! \( -type s -a -path "$VALIDATE_CONTROL_SOCKET" \) \) \) -print -quit) || return $?
        VALIDATE_UNEXPECTED_SOCKET=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev -type s ! -path "$VALIDATE_CONTROL_SOCKET" -print -quit) || return $?
      else
        test ! -S "$VALIDATE_AGENT_ROOT/state/acceptance/telegram-control.sock" || return $?
        test ! -e "$VALIDATE_CONTROL_SOCKET" || return $?
        VALIDATE_BAD_SHAPE=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev \( -type l -o \( ! -type d -a ! -type f \) \) -print -quit) || return $?
        VALIDATE_UNEXPECTED_SOCKET=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev -type s -print -quit) || return $?
      fi
      test -z "$VALIDATE_BAD_SHAPE" || return $?
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
      VALIDATE_WRONG_OWNER=$(find "$VALIDATE_RUNTIME_ROOT" "$VALIDATE_AGENT_ROOT" -xdev \( ! -user 10001 -o ! -group 10001 \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_OWNER" || return $?
      VALIDATE_WRONG_RUNTIME_DIR_MODE=$(find "$VALIDATE_RUNTIME_ROOT" -xdev -type d ! -perm 0700 \
        ! \( -perm 0755 \( \
          -path "$VALIDATE_RUNTIME_ROOT/scheduler" -o -path "$VALIDATE_RUNTIME_ROOT/scheduler/*" -o \
          -path "$VALIDATE_RUNTIME_ROOT/daemon/logs" -o -path "$VALIDATE_RUNTIME_ROOT/daemon/logs/*" -o \
          -path "$VALIDATE_RUNTIME_ROOT/daemon/external-events" -o -path "$VALIDATE_RUNTIME_ROOT/daemon/external-events/*" \
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
      # Alpha.753 and earlier wrote content-free autonomy receipts as 0644 below a 0700 tree.
      # Preserve those audit records; current writers create and normalize this exact format to 0600.
      VALIDATE_WRONG_AGENT_FILE_MODE=$(find "$VALIDATE_AGENT_ROOT" -xdev -type f ! -perm 0600 \
        ! \( -perm 0644 \( \
          -path "$VALIDATE_AGENT_ROOT/arc/flight-recorder/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/health/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/logs/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/habits/*" -o \
          -path "$VALIDATE_AGENT_ROOT/state/arc/context-loss-sentinel-watermark.json" -o \
          -exec /bin/sh -c '
            VALIDATE_AUTONOMY_RECEIPT=$1
            VALIDATE_AUTONOMY_RECEIPTS_ROOT=$2
            test "${VALIDATE_AUTONOMY_RECEIPT%/*}" = "$VALIDATE_AUTONOMY_RECEIPTS_ROOT" || exit 1
            VALIDATE_AUTONOMY_RECEIPT_NAME=${VALIDATE_AUTONOMY_RECEIPT##*/}
            case "$VALIDATE_AUTONOMY_RECEIPT_NAME" in
              autr_????????????????????????????????.json) ;;
              *) exit 1 ;;
            esac
            VALIDATE_AUTONOMY_RECEIPT_ID=${VALIDATE_AUTONOMY_RECEIPT_NAME#autr_}
            VALIDATE_AUTONOMY_RECEIPT_ID=${VALIDATE_AUTONOMY_RECEIPT_ID%.json}
            case "$VALIDATE_AUTONOMY_RECEIPT_ID" in *[!0-9a-f]*) exit 1 ;; esac
          ' sanctuary-autonomy-receipt-validator {} "$VALIDATE_AGENT_ROOT/state/autonomy/receipts" \; \
        \) \) -print -quit) || return $?
      test -z "$VALIDATE_WRONG_AGENT_FILE_MODE" || return $?
      )
    }
    normalize_sanctuary_private_permissions() {
      (
      NORMALIZE_RUNTIME_ROOT=$1
      NORMALIZE_AGENT_ROOT=$2
      NORMALIZE_IMAGE_ID=$3
      test -d "$NORMALIZE_RUNTIME_ROOT" || return $?
      test -d "$NORMALIZE_AGENT_ROOT" || return $?
      validate_exact_image_id "$NORMALIZE_IMAGE_ID" || return $?
      docker run --rm --pull=never --network none --user 10001:10001 \
        --read-only --cap-drop ALL --security-opt no-new-privileges \
        --mount "type=bind,src=$NORMALIZE_RUNTIME_ROOT,dst=/normalize/runtime" \
        --mount "type=bind,src=$NORMALIZE_AGENT_ROOT,dst=/normalize/agent" \
        --entrypoint /bin/sh "$NORMALIZE_IMAGE_ID" -eu -c '
          find /normalize/runtime /normalize/agent -xdev -type d -user 10001 -group 10001 -perm 0755 \
            ! -path "/normalize/runtime/scheduler" ! -path "/normalize/runtime/scheduler/*" \
            ! -path "/normalize/runtime/daemon/logs" ! -path "/normalize/runtime/daemon/logs/*" \
            ! -path "/normalize/runtime/daemon/external-events" ! -path "/normalize/runtime/daemon/external-events/*" \
            ! -path "/normalize/agent/arc/flight-recorder" ! -path "/normalize/agent/arc/flight-recorder/*" \
            ! -path "/normalize/agent/state/health" ! -path "/normalize/agent/state/health/*" \
            ! -path "/normalize/agent/state/logs" ! -path "/normalize/agent/state/logs/*" \
            ! -path "/normalize/agent/state/habits" ! -path "/normalize/agent/state/habits/*" \
            -exec chmod 0700 {} +
          find /normalize/runtime /normalize/agent -xdev -type f -links 1 -user 10001 -group 10001 -perm 0644 \
            ! -path "/normalize/runtime/daemon/logs/*" \
            ! -path "/normalize/runtime/scheduler/*" \
            ! -path "/normalize/runtime/pulse.json" \
            ! -path "/normalize/runtime/pulse-delivered.json" \
            ! -path "/normalize/runtime/daemon.pids" \
            ! -path "/normalize/runtime/daemon-health.json" \
            ! -path "/normalize/agent/arc/flight-recorder/*" \
            ! -path "/normalize/agent/state/health/*" \
            ! -path "/normalize/agent/state/logs/*" \
            ! -path "/normalize/agent/state/habits/*" \
            ! -path "/normalize/agent/state/arc/context-loss-sentinel-watermark.json" \
            -exec chmod 0600 {} +
        ' || return $?
      )
    }
    verify_sanctuary_snapshot_provenance() {
      (
      SNAPSHOT_ROOT=$1
      EXPECTED_SNAPSHOT_IMAGE_ID=$2
      SNAPSHOT_PROVENANCE_ROOT=$SNAPSHOT_ROOT/provenance
      for SNAPSHOT_TOP_LEVEL_DIRECTORY in runtime agent host provenance; do
        test -d "$SNAPSHOT_ROOT/$SNAPSHOT_TOP_LEVEL_DIRECTORY" || return $?
        test ! -L "$SNAPSHOT_ROOT/$SNAPSHOT_TOP_LEVEL_DIRECTORY" || return 1
      done
      test "$(find "$SNAPSHOT_ROOT" -xdev -mindepth 1 -maxdepth 1 -print | wc -l)" -eq 4 || return $?
      test -d "$SNAPSHOT_PROVENANCE_ROOT" || return $?
      test ! -L "$SNAPSHOT_PROVENANCE_ROOT" || return 1
      test "$(stat -c '%u:%g:%a' "$SNAPSHOT_PROVENANCE_ROOT")" = 0:0:700 || return $?
      SNAPSHOT_BAD_PROVENANCE_ENTRY=$(find "$SNAPSHOT_PROVENANCE_ROOT" -xdev -mindepth 1 ! -type f -print -quit) || return $?
      test -z "$SNAPSHOT_BAD_PROVENANCE_ENTRY" || return $?
      for SNAPSHOT_PROVENANCE_FILE in image-id container-inspect.json image-inspect.json package-version manifest.sha256; do
        test -f "$SNAPSHOT_PROVENANCE_ROOT/$SNAPSHOT_PROVENANCE_FILE" || return $?
        test ! -L "$SNAPSHOT_PROVENANCE_ROOT/$SNAPSHOT_PROVENANCE_FILE" || return 1
        test "$(stat -c '%u:%g:%a' "$SNAPSHOT_PROVENANCE_ROOT/$SNAPSHOT_PROVENANCE_FILE")" = 0:0:600 || return $?
      done
      test "$(find "$SNAPSHOT_PROVENANCE_ROOT" -xdev -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 5 || return $?
      test "$(wc -l <"$SNAPSHOT_PROVENANCE_ROOT/image-id")" -eq 1 || return $?
      IFS= read -r SNAPSHOT_IMAGE_ID <"$SNAPSHOT_PROVENANCE_ROOT/image-id" || return $?
      test "$SNAPSHOT_IMAGE_ID" = "$EXPECTED_SNAPSHOT_IMAGE_ID" || return $?
      case "$SNAPSHOT_IMAGE_ID" in sha256:????????????????????????????????????????????????????????????????) ;; *) return 1 ;; esac
      case "${SNAPSHOT_IMAGE_ID#sha256:}" in *[!0-9a-f]*) return 1 ;; esac
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const [containerPath, imagePath, imageId, hostPath] = process.argv.slice(1);
        const container = JSON.parse(fs.readFileSync(containerPath, "utf8"));
        const image = JSON.parse(fs.readFileSync(imagePath, "utf8"));
        if (!Array.isArray(container) || container.length !== 1 || !container[0] || container[0].Image !== imageId) process.exit(1);
        if (!Array.isArray(image) || image.length !== 1 || !image[0] || image[0].Id !== imageId) process.exit(1);
        const source = image[0].Config?.Labels?.["org.opencontainers.image.source"];
        const legacyAlpha742 = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d";
        if (source !== "https://github.com/ourostack/ouroboros" && !(source === undefined && imageId === legacyAlpha742)) process.exit(1);
        const expected = ["custom/usenet_health.sh", "custom/ouro-events/bootstrap-spool.sh", "custom/ouro-events/emit-event.mjs", "custom/ouro-events/emit-usenet-event.sh", "custom/ouro-events/install-usenet-guard.sh", "go.butler-lines", "crontab.butler-lines", "global-state"];
        const expectedUid = 0;
        const expectedGid = 0;
        const hostRoot = fs.lstatSync(hostPath);
        if (!hostRoot.isDirectory() || hostRoot.isSymbolicLink() || hostRoot.uid !== expectedUid || hostRoot.gid !== expectedGid || (hostRoot.mode & 0o777) !== 0o700) process.exit(1);
        const rows = fs.readFileSync(`${hostPath}/inventory`, "utf8").trim().split("\n").map(line => line.split("\t"));
        if (rows.length !== expected.length || rows.some((row, index) => row.length !== 2 || row[1] !== expected[index] || !["present", "absent"].includes(row[0]))) process.exit(1);
        const present = rows.filter(row => row[0] === "present").map(row => row[1]);
        if (!["go.butler-lines", "crontab.butler-lines", "global-state"].every(relative => present.includes(relative))) process.exit(1);
        const globalRows = fs.readFileSync(`${hostPath}/global-state`, "utf8").trim().split("\n").map(line => line.split("\t"));
        if (globalRows.length !== 2 || globalRows[0][0] !== "go" || globalRows[1][0] !== "crontab") process.exit(1);
        for (const [name, state, digest, count] of globalRows) {
          if (!["go", "crontab"].includes(name) || !["present", "absent"].includes(state) || !/^(?:[0-9a-f]{64}|-)$/.test(digest) || !/^(?:0|[1-9][0-9]*)$/.test(count)) process.exit(1);
          if ((state === "absent") !== (digest === "-")) process.exit(1);
          const fragmentLines = fs.readFileSync(`${hostPath}/${name}.butler-lines`, "utf8").split("\n").filter(Boolean);
          if (fragmentLines.length !== Number(count)) process.exit(1);
        }
        for (const [state, relative] of rows) {
          if (fs.existsSync(`${hostPath}/${relative}`) !== (state === "present")) process.exit(1);
        }
        const files = [];
        const directories = [];
        const walk = (directory, prefix = "") => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const metadata = fs.lstatSync(`${directory}/${entry.name}`);
            if (metadata.uid !== expectedUid || metadata.gid !== expectedGid) process.exit(1);
            if (entry.isDirectory() && (metadata.mode & 0o777) === 0o700) { directories.push(relative); walk(`${directory}/${entry.name}`, relative); }
            else if (entry.isFile() && (metadata.mode & 0o777) === 0o600) files.push(relative);
            else process.exit(1);
          }
        };
        walk(hostPath);
        if (JSON.stringify(directories.sort()) !== JSON.stringify(["custom", "custom/ouro-events"])) process.exit(1);
        if (JSON.stringify(files.sort()) !== JSON.stringify(["inventory", ...present].sort())) process.exit(1);
      ' "$SNAPSHOT_PROVENANCE_ROOT/container-inspect.json" "$SNAPSHOT_PROVENANCE_ROOT/image-inspect.json" "$SNAPSHOT_IMAGE_ID" "$SNAPSHOT_ROOT/host" || return $?
      test "$(wc -l <"$SNAPSHOT_PROVENANCE_ROOT/package-version")" -eq 1 || return $?
      grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' "$SNAPSHOT_PROVENANCE_ROOT/package-version" || return $?
      test "$(stat -c '%u:%g:%a' "$SNAPSHOT_ROOT/host")" = 0:0:700 || return $?
      SNAPSHOT_BAD_HOST_ENTRY=$(find "$SNAPSHOT_ROOT/host" -xdev \( \( -type d ! -perm 0700 \) -o \( -type f ! -perm 0600 \) -o \( ! -type d -a ! -type f \) \) -print -quit) || return $?
      test -z "$SNAPSHOT_BAD_HOST_ENTRY" || return $?
      test -f "$SNAPSHOT_ROOT/host/inventory" || return $?
      test ! -e "$SNAPSHOT_ROOT/host/notify.conf" || return 1
      test ! -e "$SNAPSHOT_ROOT/host/sabnzbd.ini" || return 1
      SNAPSHOT_VERIFY_ROOT=$(mktemp -d /tmp/ouro-snapshot-verify.XXXXXX) || return $?
      trap 'rm -f -- "$SNAPSHOT_VERIFY_ROOT/current-files" "$SNAPSHOT_VERIFY_ROOT/manifest-files"; rmdir -- "$SNAPSHOT_VERIFY_ROOT"' EXIT || return $?
      (
        cd "$SNAPSHOT_ROOT" || return $?
        find runtime agent host provenance -xdev -type f ! -path provenance/manifest.sha256 -print | LC_ALL=C sort >"$SNAPSHOT_VERIFY_ROOT/current-files" || return $?
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
      test -n "${RESTORE_VERSION_IMAGE-}" || return 1
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
      test "$IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return $?
      test "$IMAGE_ID" != sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d || return $?
      test "$AUDIT_RUNNER_IMAGE_ID" != sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d || return $?
      test "$AUDIT_RUNNER_IMAGE_ID" != sha256:e337dff04c92d116b269052f473b26a47eea933d017d1befc73af50dd37bb08d || return $?
      printf '%s\n' "$RESTORE_VERSION_IMAGE" | grep -Eq '^ghcr\.io/ourostack/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || return $?
      test "$(docker image inspect --format '{{.Id}}' "$RESTORE_VERSION_IMAGE")" = "$IMAGE_ID" || return $?
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
      assert_update_source "$RESTORE_PRODUCTION_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" || return $?
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
    migrate_sanctuary_package_managed_bundle() {
      MIGRATE_IMAGE_ID=$1
      MIGRATE_OPERATION=$2
      MIGRATE_ROLLBACK_IMAGE_ID=${3-}
      validate_exact_image_id "$MIGRATE_IMAGE_ID" || return $?
      case "$MIGRATE_OPERATION" in migrate|rollback|finalize-rollback|commit|status|inspect) ;; *) return 1 ;; esac
      if test "$MIGRATE_OPERATION" = migrate; then
        validate_exact_image_id "$MIGRATE_ROLLBACK_IMAGE_ID" || return $?
        test "$MIGRATE_IMAGE_ID" != "$MIGRATE_ROLLBACK_IMAGE_ID" || return 1
        set -- --rollback-image-id "$MIGRATE_ROLLBACK_IMAGE_ID" --target-image-id "$MIGRATE_IMAGE_ID"
      else
        set --
      fi
      docker run --rm --pull=never --network=none --read-only --user 10001:10001 \
        --entrypoint /usr/local/bin/node \
        --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        "$MIGRATE_IMAGE_ID" /opt/ouro/deploy/unraid/migrate-sanctuary-bundle.mjs \
        --package-root /opt/ouro/deploy/unraid/sanctuary.ouro \
        --agent-root /home/ouro/AgentBundles/sanctuary.ouro \
        --operation "$MIGRATE_OPERATION" "$@" || return $?
    }
    read_sanctuary_bundle_transaction_status() {
      READ_BUNDLE_IMAGE_ID=$1
      READ_BUNDLE_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      READ_BUNDLE_EXPECTED_UID=10001
      READ_BUNDLE_EXPECTED_GID=10001
      READ_BUNDLE_ROLLBACK_RECORD=$READ_BUNDLE_AGENT_ROOT/.sanctuary-package-managed-rollback.json
      READ_BUNDLE_COMMITTING_RECORD=$READ_BUNDLE_ROLLBACK_RECORD.committing
      validate_exact_image_id "$READ_BUNDLE_IMAGE_ID" || return $?
      READ_BUNDLE_ROOT_STATE=$(/usr/local/bin/node -e '
        const fs = require("node:fs");
        const path = require("node:path");
        const [rootPath, expectedUid, expectedGid] = process.argv.slice(1);
        if (!path.isAbsolute(rootPath) || path.normalize(rootPath) !== rootPath) process.exit(1);
        let current = path.parse(rootPath).root;
        let rootStat;
        for (const segment of rootPath.slice(current.length).split(path.sep)) {
          current = path.join(current, segment);
          let stat;
          try { stat = fs.lstatSync(current); } catch (error) {
            if (error?.code === "ENOENT") { process.stdout.write("missing"); process.exit(0); }
            process.exit(1);
          }
          if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) process.exit(1);
          rootStat = stat;
        }
        if (!rootStat || rootStat.uid !== Number(expectedUid) || rootStat.gid !== Number(expectedGid) || (rootStat.mode & 0o777) !== 0o700) process.exit(1);
        process.stdout.write("present");
      ' "$READ_BUNDLE_AGENT_ROOT" "$READ_BUNDLE_EXPECTED_UID" "$READ_BUNDLE_EXPECTED_GID") || return $?
      if test "$READ_BUNDLE_ROOT_STATE" = missing; then
        printf 'null\n'
        return 0
      fi
      test "$READ_BUNDLE_ROOT_STATE" = present || return 1
      READ_BUNDLE_STAGING_RESIDUE=$(find "$READ_BUNDLE_AGENT_ROOT" -mindepth 1 -maxdepth 1 \( \
        -name '.sanctuary-package-managed-rollback.json.package-migration.*' -o \
        -name '.sanctuary-package-managed-rollback.json.committing.package-migration.*' \
      \) -print -quit) || return $?
      test -z "$READ_BUNDLE_STAGING_RESIDUE" || return 1
      READ_BUNDLE_RECORD_COUNT=0
      for READ_BUNDLE_CANDIDATE in "$READ_BUNDLE_ROLLBACK_RECORD" "$READ_BUNDLE_COMMITTING_RECORD"; do
        test ! -L "$READ_BUNDLE_CANDIDATE" || return 1
        if test -e "$READ_BUNDLE_CANDIDATE"; then
          test -f "$READ_BUNDLE_CANDIDATE" || return 1
          READ_BUNDLE_RECORD_COUNT=$((READ_BUNDLE_RECORD_COUNT + 1))
        fi
      done
      test "$READ_BUNDLE_RECORD_COUNT" -le 1 || return 1
      if test "$READ_BUNDLE_RECORD_COUNT" -eq 0; then
        printf 'null\n'
        return 0
      fi
      migrate_sanctuary_package_managed_bundle "$READ_BUNDLE_IMAGE_ID" status || return $?
    }
    verify_dockerman_and_community_apps() {
      VERIFY_VERSION_IMAGE=$1
      VERIFY_INSTALL_PROOF_PATH=$2
      VERIFY_TEMPLATE_PATH=/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml
      test "$(stat -c '%u:%g:%a' "$VERIFY_TEMPLATE_PATH")" = 0:0:600 || return $?
      test ! -e "$VERIFY_INSTALL_PROOF_PATH" || return 1
      timeout -s KILL 20 /usr/bin/php -r '
        [$expectedImage, $outputPath] = array_slice($argv, 1);
        $expectedPath = "/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml";
        $expectedUrl = "https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml";
        $expectedIcon = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png";
        $communityAppsEntryPath = "/usr/local/emhttp/plugins/community.applications/include/exec.php";
        $communityAppsHelperPath = "/usr/local/emhttp/plugins/community.applications/include/previous_apps_helpers.php";
        $communityAppsDependencies = ["/usr/local/emhttp/plugins/community.applications/include/paths.php", "/usr/local/emhttp/plugins/community.applications/include/plugin_identity.php", "/usr/local/emhttp/plugins/community.applications/include/helpers.php"];
        if (!preg_match("#^ghcr\\.io/ourostack/ouroboros-butler:[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$#", $expectedImage)) exit(2);
        $readActivePhp = static function($path) {
          if (!is_file($path) || is_link($path) || fileowner($path) !== 0 || (fileperms($path) & 0022) !== 0 || realpath($path) !== $path) exit(3);
          $lint = proc_open(["/usr/bin/php", "-l", $path], [0 => ["file", "/dev/null", "r"], 1 => ["file", "/dev/null", "w"], 2 => ["file", "/dev/null", "w"]], $pipes);
          if (!is_resource($lint) || proc_close($lint) !== 0) exit(4);
          $source = php_strip_whitespace($path);
          if (!is_string($source) || $source === "") exit(4);
          return $source;
        };
        $functionSlice = static function($source, $start, $next) {
          if (substr_count($source, $start) !== 1 || substr_count($source, $next) !== 1) return false;
          $startAt = strpos($source, $start);
          $nextAt = strpos($source, $next, $startAt + strlen($start));
          return $nextAt !== false && $nextAt > $startAt ? substr($source, $startAt, $nextAt - $startAt) : false;
        };
        $entrySource = $readActivePhp($communityAppsEntryPath);
        $inlineBody = $functionSlice($entrySource, "function previous_apps(", "function remove_application(");
        $delegatedBody = $functionSlice($entrySource, "function previous_apps(", "function installedAndPreviousCounts(");
        $isInline = $inlineBody !== false && hash("sha256", $inlineBody) === "1914b9c6b8910b7bb116dad48fe76d4790a069becbf0d68b3822ee3df7f22b1c";
        $isDelegated = $delegatedBody !== false && hash("sha256", $delegatedBody) === "16b52cd87cc3f74915bf172f8a6eb46f981529208766916d4aeedf4b3344a3a4";
        if (($isInline ? 1 : 0) + ($isDelegated ? 1 : 0) !== 1) exit(4);
        $_SERVER["DOCUMENT_ROOT"] = "/usr/local/emhttp";
        $docroot = $_SERVER["DOCUMENT_ROOT"];
        require_once "$docroot/plugins/dynamix/include/Wrappers.php";
        require_once "$docroot/plugins/dynamix.docker.manager/include/DockerClient.php";
        $driver = DockerUtil::driver();
        $client = new DockerClient();
        $templates = new DockerTemplates();
        $resolved = $templates->getUserTemplate("ouro-butler");
        if ($resolved !== $expectedPath) exit(5);
        $xml = @simplexml_load_file($resolved);
        if (!$xml || (string)$xml->Name !== "ouro-butler" || (string)$xml->Repository !== $expectedImage || (string)$xml->TemplateURL !== $expectedUrl || (string)$xml->Icon !== $expectedIcon || trim((string)$xml->WebUI) !== "") exit(6);
        $containers = $client->getDockerContainers();
        $matches = array_values(array_filter($containers, fn($container) => $container["Name"] === "ouro-butler"));
        if (count($matches) !== 1) exit(7);
        $container = $matches[0];
        if ($container["Image"] !== $expectedImage || $container["Manager"] !== "dockerman" || $container["Icon"] !== $expectedIcon || !empty($container["Url"])) exit(8);
        $communityAppsInstalled = $container["Name"] === (string)$xml->Name && (str_starts_with(str_replace("library/", "", $container["Image"]), (string)$xml->Repository) || str_starts_with($container["Image"], (string)$xml->Repository));
        if (!$communityAppsInstalled) exit(9);
        if ($isDelegated) {
          $readActivePhp($communityAppsHelperPath);
          foreach ($communityAppsDependencies as $dependencyPath) $readActivePhp($dependencyPath);
          require_once "$docroot/plugins/community.applications/include/helpers.php";
          require_once $communityAppsHelperPath;
          if (!is_callable(["PreviousAppsHelpers", "collectDockerApplications"])) exit(4);
          $helperUpdateCount = 0;
          $helperRows = PreviousAppsHelpers::collectDockerApplications(true, "true", "docker", $containers, $helperUpdateCount, [], [], [], []);
          if (!is_array($helperRows)) exit(9);
          $helperMatches = array_values(array_filter($helperRows, fn($row) => is_array($row) && ($row["InstallPath"] ?? null) === $expectedPath && ($row["Name"] ?? null) === "ouro-butler" && ($row["Repository"] ?? null) === $expectedImage && ($row["TemplateURL"] ?? null) === $expectedUrl && ($row["Icon"] ?? null) === $expectedIcon));
          if (count($helperMatches) !== 1) exit(9);
          $communityAppsStateModel = "previous-apps-helper-v1";
          $communityAppsImplementationPath = $communityAppsHelperPath;
          $communityAppsImplementationSymbol = "PreviousAppsHelpers::collectDockerApplications";
        } else {
          $communityAppsStateModel = "previous-apps-inline-v1";
          $communityAppsImplementationPath = $communityAppsEntryPath;
          $communityAppsImplementationSymbol = "previous_apps";
        }
        $proof = [
          "dockerMan" => ["templatePath" => $resolved, "name" => (string)$xml->Name, "repository" => (string)$xml->Repository, "templateUrl" => (string)$xml->TemplateURL, "icon" => (string)$xml->Icon],
          "communityApps" => ["installed" => true, "name" => (string)$xml->Name, "repository" => (string)$xml->Repository, "templateUrl" => (string)$xml->TemplateURL, "stateModel" => $communityAppsStateModel, "entryPath" => $communityAppsEntryPath, "entryFunction" => "previous_apps", "implementationPath" => $communityAppsImplementationPath, "implementationSymbol" => $communityAppsImplementationSymbol],
        ];
        $temporary = $outputPath . ".tmp";
        if (file_exists($temporary) || is_link($temporary) || file_exists($outputPath) || is_link($outputPath)) exit(10);
        $payload = json_encode($proof, JSON_UNESCAPED_SLASHES) . "\n";
        $handle = @fopen($temporary, "x");
        if ($handle === false || fwrite($handle, $payload) !== strlen($payload) || !fflush($handle) || !fsync($handle) || !fclose($handle) || !chmod($temporary, 0600) || !chown($temporary, 0) || !chgrp($temporary, 0) || !rename($temporary, $outputPath)) exit(11);
      ' "$VERIFY_VERSION_IMAGE" "$VERIFY_INSTALL_PROOF_PATH" || return $?
      test "$(stat -c '%u:%g:%a' "$VERIFY_INSTALL_PROOF_PATH")" = 0:0:600 || return $?
    }
    audit_registered_dockerman_template() {
      REGISTERED_TEMPLATE_RUNNER_IMAGE_ID=$1
      REGISTERED_TEMPLATE_VERSION_IMAGE=$2
      REGISTERED_TEMPLATE_MOUNT_CONTRACT=$3
      REGISTERED_TEMPLATE_PATH=/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml
      validate_exact_image_id "$REGISTERED_TEMPLATE_RUNNER_IMAGE_ID" || return $?
      printf '%s\n' "$REGISTERED_TEMPLATE_VERSION_IMAGE" | grep -Eq '^ghcr\.io/ourostack/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || return $?
      test -f "$REGISTERED_TEMPLATE_PATH" && test ! -L "$REGISTERED_TEMPLATE_PATH" || return 1
      docker run --rm --pull=never --network=none --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh --mount "type=bind,src=$REGISTERED_TEMPLATE_PATH,dst=/audit/sanctuary.xml,readonly" "$REGISTERED_TEMPLATE_RUNNER_IMAGE_ID" --persistent-template /audit/sanctuary.xml --runtime-policy /opt/ouro/deploy/unraid/container-runtime.json --expected-image-reference "$REGISTERED_TEMPLATE_VERSION_IMAGE" --mount-contract "$REGISTERED_TEMPLATE_MOUNT_CONTRACT" || return $?
    }
    verify_known_good_rollback_artifact() {
      EXPECTED_KNOWN_GOOD_IMAGE_ID=$1
      validate_exact_image_id "$EXPECTED_KNOWN_GOOD_IMAGE_ID" || return $?
      MATCHING_KNOWN_GOOD_COUNT=0
      for KNOWN_GOOD_NAME in ouro-butler-rollback ouro-butler-legacy-evidence; do
        if docker container inspect "$KNOWN_GOOD_NAME" >/dev/null 2>&1; then
          KNOWN_GOOD_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$KNOWN_GOOD_NAME") || return $?
          if test "$KNOWN_GOOD_IMAGE_ID" = "$EXPECTED_KNOWN_GOOD_IMAGE_ID"; then
            test "$(docker inspect --format '{{.State.Running}}' "$KNOWN_GOOD_NAME")" = false || return 1
            MATCHING_KNOWN_GOOD_COUNT=$((MATCHING_KNOWN_GOOD_COUNT + 1))
          fi
        fi
      done
      test "$MATCHING_KNOWN_GOOD_COUNT" -eq 1 || return 1
    }
    write_dockerman_final_proof() {
      FINAL_PROOF_IMAGE_ID=$1
      FINAL_PROOF_VERSION_IMAGE=$2
      FINAL_PROOF_ICON=$3
      FINAL_PROOF_ROOT=$4
      validate_exact_image_id "$FINAL_PROOF_IMAGE_ID" || return $?
      test "$FINAL_PROOF_VERSION_IMAGE" = "ghcr.io/ourostack/ouroboros-butler:$PACKAGE_VERSION" || return 1
      install -d -m 0700 -o 0 -g 0 "$FINAL_PROOF_ROOT" || return $?
      FINAL_CONTAINER_PATH=$FINAL_PROOF_ROOT/container.json
      FINAL_BUNDLE_PATH=$FINAL_PROOF_ROOT/bundle.json
      FINAL_INSTALL_PATH=$FINAL_PROOF_ROOT/install.json
      FINAL_JELLYFIN_PATH=$FINAL_PROOF_ROOT/jellyfin.json
      FINAL_PROOF_PATH=$FINAL_PROOF_ROOT/final-proof.json
      test ! -e "$FINAL_CONTAINER_PATH" && test ! -e "$FINAL_BUNDLE_PATH" && test ! -e "$FINAL_INSTALL_PATH" && test ! -e "$FINAL_JELLYFIN_PATH" && test ! -e "$FINAL_PROOF_PATH" || return 1
      docker inspect ouro-butler >"$FINAL_CONTAINER_PATH" || return $?
      migrate_sanctuary_package_managed_bundle "$FINAL_PROOF_IMAGE_ID" inspect >"$FINAL_BUNDLE_PATH" || return $?
      verify_dockerman_and_community_apps "$FINAL_PROOF_VERSION_IMAGE" "$FINAL_INSTALL_PATH" || return $?
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" jellyfin-status >"$FINAL_JELLYFIN_PATH" || return $?
      chown 0:0 "$FINAL_CONTAINER_PATH" "$FINAL_BUNDLE_PATH" "$FINAL_JELLYFIN_PATH" || return $?
      chmod 0600 "$FINAL_CONTAINER_PATH" "$FINAL_BUNDLE_PATH" "$FINAL_JELLYFIN_PATH" || return $?
      FINAL_AUTOSTART_COUNT=$(awk '$1 == "ouro-butler" { count++ } END { print count + 0 }' /var/lib/docker/unraid-autostart) || return $?
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const [containerPath, bundlePath, installPath, jellyfinPath, outputPath, imageId, imageReference, icon, autostartCount] = process.argv.slice(1);
        const containers = JSON.parse(fs.readFileSync(containerPath, "utf8"));
        const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
        const install = JSON.parse(fs.readFileSync(installPath, "utf8"));
        const jellyfin = JSON.parse(fs.readFileSync(jellyfinPath, "utf8"));
        if (!Array.isArray(containers) || containers.length !== 1) process.exit(1);
        const source = containers[0];
        const labels = source.Config?.Labels;
        const health = source.State?.Health?.Status;
        if (source.Name !== "/ouro-butler" || source.Image !== imageId || source.Config?.Image !== imageReference || source.State?.Running !== true || health !== "healthy" || autostartCount !== "1" || labels?.["net.unraid.docker.managed"] !== "dockerman" || labels?.["net.unraid.docker.icon"] !== icon || Object.prototype.hasOwnProperty.call(labels ?? {}, "net.unraid.docker.webui")) process.exit(1);
        if (bundle?.ok !== true || bundle?.data?.parity !== "exact" || bundle?.data?.journalState !== "absent" || bundle?.data?.ready !== true) process.exit(1);
        const proof = { container: { name: source.Name, imageId: source.Image, imageReference: source.Config.Image, running: source.State.Running, healthy: health === "healthy", autostart: true, labels: { "net.unraid.docker.managed": labels["net.unraid.docker.managed"], "net.unraid.docker.icon": labels["net.unraid.docker.icon"] } }, bundle, ...install, jellyfin };
        fs.writeFileSync(outputPath, `${JSON.stringify(proof)}\n`, { mode: 0o600, flag: "wx" });
      ' "$FINAL_CONTAINER_PATH" "$FINAL_BUNDLE_PATH" "$FINAL_INSTALL_PATH" "$FINAL_JELLYFIN_PATH" "$FINAL_PROOF_PATH" "$FINAL_PROOF_IMAGE_ID" "$FINAL_PROOF_VERSION_IMAGE" "$FINAL_PROOF_ICON" "$FINAL_AUTOSTART_COUNT" || return $?
      chown 0:0 "$FINAL_PROOF_PATH" || return $?
      chmod 0600 "$FINAL_PROOF_PATH" || return $?
      printf '%s\n' "$FINAL_PROOF_PATH"
    }
    start_only_butler_for_recovery() {
      RECOVERY_AUTHORITY_STATE=$(read_sanctuary_authority_state) || return $?
      if test "$RECOVERY_AUTHORITY_STATE" != none; then
        /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" authority-restore >/dev/null || return $?
        assert_only_running_butler ouro-butler || return $?
        return 0
      fi
      RECOVERY_START_STATE=$(docker inspect --format '{{.State.Running}}' ouro-butler) || return $?
      case "$RECOVERY_START_STATE" in
        true)
          assert_only_running_butler ouro-butler || return $?
          ;;
        false)
          assert_only_running_butler - || return $?
          docker start ouro-butler || return $?
          assert_only_running_butler ouro-butler || return $?
          ;;
        *) return 1 ;;
      esac
    }
    recover_pending_sanctuary_bundle_migration() {
      RECOVERY_IMAGE_ID=$1
      RECOVERY_STATUS=$(read_sanctuary_bundle_transaction_status "$RECOVERY_IMAGE_ID") || return $?
      test "$RECOVERY_STATUS" != null || return 0
      RECOVERY_IDENTITIES=$(printf '%s' "$RECOVERY_STATUS" | /usr/local/bin/node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (!value || !["rollback", "committing"].includes(value.state)
            || typeof value.rollbackImageId !== "string" || typeof value.targetImageId !== "string") process.exit(1);
          process.stdout.write(`${value.state} ${value.rollbackImageId} ${value.targetImageId}`);
        });
      ') || return $?
      set -- $RECOVERY_IDENTITIES
      test "$#" -eq 3 || return 1
      RECOVERY_STATE=$1
      RECOVERY_ROLLBACK_IMAGE_ID=$2
      RECOVERY_TARGET_IMAGE_ID=$3
      validate_exact_image_id "$RECOVERY_ROLLBACK_IMAGE_ID" || return $?
      validate_exact_image_id "$RECOVERY_TARGET_IMAGE_ID" || return $?
      test "$RECOVERY_TARGET_IMAGE_ID" != "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1
      disable_butler_autostart || return $?
      if test "$RECOVERY_STATE" = committing; then
        ! docker container inspect ouro-butler-staging >/dev/null 2>&1 || return 1
        RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
        test "$(docker inspect --format '{{.State.Running}}' ouro-butler)" = true || return 1
        test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID" || return 1
        RECOVERY_CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback) || return $?
        test "$RECOVERY_CURRENT_ROLLBACK_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false || return 1
        assert_only_running_butler ouro-butler || return $?
        assert_update_source "$RECOVERY_PRODUCTION_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" || return $?
        wait_butler_ready ouro-butler || return $?
        enable_butler_autostart || return $?
        migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" commit || return $?
        return 0
      fi
      retire_sanctuary_authority_if_pending || return $?
      if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
        RECOVERY_CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback) || return $?
        test "$RECOVERY_CURRENT_ROLLBACK_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false || return 1
        if docker container inspect ouro-butler-staging >/dev/null 2>&1; then
          RECOVERY_STAGING_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-staging) || return $?
          test "$RECOVERY_STAGING_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID" || return 1
          docker stop ouro-butler-staging >/dev/null 2>&1 || true
          docker rm --force ouro-butler-staging || return $?
        fi
        if docker container inspect ouro-butler >/dev/null 2>&1; then
          RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
          test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_TARGET_IMAGE_ID" || return 1
          docker stop ouro-butler >/dev/null 2>&1 || true
          docker rm --force ouro-butler || return $?
        fi
        migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" rollback || return $?
        docker rename ouro-butler-rollback ouro-butler || return $?
      elif docker container inspect ouro-butler >/dev/null 2>&1; then
        ! docker container inspect ouro-butler-staging >/dev/null 2>&1 || return 1
        RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
        test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        ! docker container inspect ouro-butler-rollback >/dev/null 2>&1 || return 1
        migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" rollback || return $?
      else
        return 1
      fi
      RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
      test "$RECOVERY_PRODUCTION_IMAGE_ID" = "$RECOVERY_ROLLBACK_IMAGE_ID" || return 1
      assert_update_source "$RECOVERY_ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" || return $?
      start_only_butler_for_recovery || return $?
      wait_butler_ready ouro-butler || return $?
      enable_butler_autostart || return $?
      migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" finalize-rollback || return $?
    }
    rollback_sanctuary_bundle_if_pending() {
      OPTIONAL_ROLLBACK_IMAGE_ID=$1
      OPTIONAL_ROLLBACK_RECORD=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/.sanctuary-package-managed-rollback.json
      OPTIONAL_COMMITTING_RECORD=$OPTIONAL_ROLLBACK_RECORD.committing
      test ! -L "$OPTIONAL_ROLLBACK_RECORD" || return 1
      test ! -L "$OPTIONAL_COMMITTING_RECORD" || return 1
      test ! -e "$OPTIONAL_COMMITTING_RECORD" || return 1
      if test -e "$OPTIONAL_ROLLBACK_RECORD"; then
        test -f "$OPTIONAL_ROLLBACK_RECORD" || return 1
        migrate_sanctuary_package_managed_bundle "$OPTIONAL_ROLLBACK_IMAGE_ID" rollback || return $?
      fi
    }
    finalize_sanctuary_bundle_rollback_if_retained() {
      FINALIZE_ROLLBACK_IMAGE_ID=$1
      FINALIZE_ROLLBACK_STATUS=$(read_sanctuary_bundle_transaction_status "$FINALIZE_ROLLBACK_IMAGE_ID") || return $?
      test "$FINALIZE_ROLLBACK_STATUS" != null || return 0
      FINALIZE_ROLLBACK_STATE=$(printf '%s' "$FINALIZE_ROLLBACK_STATUS" | /usr/local/bin/node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (!value || !["rollback", "committing"].includes(value.state)) process.exit(1);
          process.stdout.write(value.state);
        });
      ') || return $?
      test "$FINALIZE_ROLLBACK_STATE" = rollback || return 1
      migrate_sanctuary_package_managed_bundle "$FINALIZE_ROLLBACK_IMAGE_ID" finalize-rollback || return $?
    }
    write_dockerman_recovery_evidence() {
      RECOVERY_EVIDENCE_BUNDLE_STATE=$1
      RECOVERY_EVIDENCE_PRODUCTION=$2
      RECOVERY_EVIDENCE_INSPECTION_PATH=$3
      RECOVERY_EVIDENCE_PATH=$4
      test ! -e "$RECOVERY_EVIDENCE_PATH" || return 1
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const [bundleJournalState, production, inspectionPath, outputPath] = process.argv.slice(1);
        const evidence = { bundleJournalState, production };
        if (inspectionPath !== "-") evidence.inspection = JSON.parse(fs.readFileSync(inspectionPath, "utf8"));
        fs.writeFileSync(outputPath, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: "wx" });
      ' "$RECOVERY_EVIDENCE_BUNDLE_STATE" "$RECOVERY_EVIDENCE_PRODUCTION" "$RECOVERY_EVIDENCE_INSPECTION_PATH" "$RECOVERY_EVIDENCE_PATH" || return $?
      chown 0:0 "$RECOVERY_EVIDENCE_PATH" || return $?
      chmod 0600 "$RECOVERY_EVIDENCE_PATH" || return $?
    }
    recover_dockerman_template_transaction() {
      TEMPLATE_RECOVERY_IDENTITY=$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-identity) || return $?
      if test "$TEMPLATE_RECOVERY_IDENTITY" = null; then
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recover-status)" = null || return 1
        return 0
      fi
      TEMPLATE_RECOVERY_IDENTITIES=$(printf '%s' "$TEMPLATE_RECOVERY_IDENTITY" | /usr/local/bin/node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (!value || !["rollback", "committing"].includes(value.state)) process.exit(1);
          process.stdout.write([value.state, value.rollbackImageId, value.targetImageId, value.canonicalVersionTag, value.reviewedManifestDigest].join(" "));
        });
      ') || return $?
      set -- $TEMPLATE_RECOVERY_IDENTITIES
      test "$#" -eq 5 || return 1
      TEMPLATE_RECOVERY_STATE=$1
      TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID=$2
      TEMPLATE_RECOVERY_TARGET_IMAGE_ID=$3
      TEMPLATE_RECOVERY_VERSION_IMAGE=$4
      TEMPLATE_RECOVERY_MANIFEST_DIGEST=$5
      test "$TEMPLATE_RECOVERY_TARGET_IMAGE_ID" = "$IMAGE_ID" || return 1
      test "$TEMPLATE_RECOVERY_VERSION_IMAGE" = "$VERSION_IMAGE" || return 1
      test "$TEMPLATE_RECOVERY_MANIFEST_DIGEST" = "$MANIFEST_DIGEST" || return 1
      validate_exact_image_id "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return $?
      TEMPLATE_RECOVERY_BUNDLE_STATUS=$(read_sanctuary_bundle_transaction_status "$IMAGE_ID") || return $?
      TEMPLATE_RECOVERY_BUNDLE_IDENTITIES=$(printf '%s' "$TEMPLATE_RECOVERY_BUNDLE_STATUS" | /usr/local/bin/node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (value === null) process.stdout.write("absent - -");
          else if (value && ["rollback", "committing"].includes(value.state) && typeof value.rollbackImageId === "string" && typeof value.targetImageId === "string") process.stdout.write([value.state, value.rollbackImageId, value.targetImageId].join(" "));
          else process.exit(1);
        });
      ') || return $?
      set -- $TEMPLATE_RECOVERY_BUNDLE_IDENTITIES
      test "$#" -eq 3 || return 1
      TEMPLATE_RECOVERY_BUNDLE_STATE=$1
      TEMPLATE_RECOVERY_BUNDLE_ROLLBACK_IMAGE_ID=$2
      TEMPLATE_RECOVERY_BUNDLE_TARGET_IMAGE_ID=$3
      if test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = absent; then
        test "$TEMPLATE_RECOVERY_BUNDLE_ROLLBACK_IMAGE_ID" = - && test "$TEMPLATE_RECOVERY_BUNDLE_TARGET_IMAGE_ID" = - || return 1
      else
        validate_exact_image_id "$TEMPLATE_RECOVERY_BUNDLE_ROLLBACK_IMAGE_ID" || return $?
        validate_exact_image_id "$TEMPLATE_RECOVERY_BUNDLE_TARGET_IMAGE_ID" || return $?
        test "$TEMPLATE_RECOVERY_BUNDLE_ROLLBACK_IMAGE_ID" != "$TEMPLATE_RECOVERY_BUNDLE_TARGET_IMAGE_ID" || return 1
        test "$TEMPLATE_RECOVERY_BUNDLE_ROLLBACK_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        test "$TEMPLATE_RECOVERY_BUNDLE_TARGET_IMAGE_ID" = "$TEMPLATE_RECOVERY_TARGET_IMAGE_ID" || return 1
      fi
      TEMPLATE_RECOVERY_STATUS=$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recover-status) || return $?
      test "$TEMPLATE_RECOVERY_STATUS" = "$TEMPLATE_RECOVERY_IDENTITY" || return 1
      TEMPLATE_RECOVERY_EVIDENCE=$EVENT_ASSET_STAGE/template-recovery-evidence.json
      TEMPLATE_RECOVERY_INSPECTION=$EVENT_ASSET_STAGE/template-recovery-inspection.json
      TEMPLATE_RECOVERY_FINAL_ROOT=$EVENT_ASSET_STAGE/template-recovery-final
      if test "$TEMPLATE_RECOVERY_STATE" = rollback; then
        disable_butler_autostart || return $?
        retire_sanctuary_authority_if_pending || return $?
      fi
      if test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = rollback; then
        recover_pending_sanctuary_bundle_migration "$IMAGE_ID" || return $?
        TEMPLATE_RECOVERY_POST_BUNDLE_STATUS=$(read_sanctuary_bundle_transaction_status "$IMAGE_ID") || return $?
        test "$TEMPLATE_RECOVERY_POST_BUNDLE_STATUS" = null || return 1
        test "$(docker inspect --format '{{.Image}}' ouro-butler)" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        write_dockerman_recovery_evidence absent rollback-exact - "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"restore-prior-template"}' || return 1
        /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null || return $?
        return 0
      fi
      TEMPLATE_RECOVERY_PRODUCTION_PRESENT=false
      TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID=
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        TEMPLATE_RECOVERY_PRODUCTION_PRESENT=true
        TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
      fi
      if test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = committing; then
        test "$TEMPLATE_RECOVERY_PRODUCTION_PRESENT" = true || return 1
        test "$TEMPLATE_RECOVERY_STATE" = committing || return 1
        test "$TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID" = "$IMAGE_ID" || return 1
        test "$(docker inspect --format '{{.Image}}' ouro-butler-rollback)" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false || return 1
        assert_only_running_butler ouro-butler || return $?
        audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" "$TARGET_MOUNT_CONTRACT" "$VERSION_IMAGE" "$TEMPLATE_ICON" || return $?
        migrate_sanctuary_package_managed_bundle "$IMAGE_ID" inspect >"$TEMPLATE_RECOVERY_INSPECTION" || return $?
        chown 0:0 "$TEMPLATE_RECOVERY_INSPECTION" && chmod 0600 "$TEMPLATE_RECOVERY_INSPECTION" || return $?
        write_dockerman_recovery_evidence committing target-exact-committing "$TEMPLATE_RECOVERY_INSPECTION" "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"finish-bundle-commit"}' || return 1
        migrate_sanctuary_package_managed_bundle "$IMAGE_ID" commit || return $?
        wait_butler_ready ouro-butler || return $?
        test "$(docker inspect --format '{{.Image}}' ouro-butler)" = "$IMAGE_ID" || return 1
        verify_butler_autostart "1 0 0 0" || return $?
      elif test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = absent && test "$TEMPLATE_RECOVERY_PRODUCTION_PRESENT" = false; then
        test "$TEMPLATE_RECOVERY_STATE" = rollback || return 1
        ! docker container inspect ouro-butler-staging >/dev/null 2>&1 || return 1
        assert_only_running_butler - || return $?
        if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
          TEMPLATE_RECOVERY_CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback) || return $?
          test "$TEMPLATE_RECOVERY_CURRENT_ROLLBACK_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return 1
          test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false || return 1
          docker rename ouro-butler-rollback ouro-butler || return $?
          assert_update_source "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" || return $?
          start_only_butler_for_recovery || return $?
          wait_butler_ready ouro-butler || return $?
          enable_butler_autostart || return $?
          write_dockerman_recovery_evidence absent rollback-exact - "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
          test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"restore-prior-template"}' || return 1
          /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null || return $?
          return 0
        fi
        TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) || return $?
        test "$TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        test "$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence)" = false || return 1
        write_dockerman_recovery_evidence absent adoption-evidence-exact-stopped - "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"quarantine-adoption"}' || return 1
        /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null || return $?
        printf '%s\n' 'Legacy adoption recovery requires a reviewed retry; exact legacy evidence remains quarantined and stopped.' >&2
        return 1
      elif test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = absent && test "$TEMPLATE_RECOVERY_STATE" = rollback && test "$TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID"; then
        ! docker container inspect ouro-butler-staging >/dev/null 2>&1 || return 1
        ! docker container inspect ouro-butler-rollback >/dev/null 2>&1 || return 1
        assert_update_source "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" || return $?
        start_only_butler_for_recovery || return $?
        wait_butler_ready ouro-butler || return $?
        enable_butler_autostart || return $?
        write_dockerman_recovery_evidence absent rollback-exact - "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"restore-prior-template"}' || return 1
        /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null || return $?
        return 0
      elif test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = absent && test "$TEMPLATE_RECOVERY_STATE" = rollback && test "$TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID" = "$IMAGE_ID"; then
        ! docker container inspect ouro-butler-staging >/dev/null 2>&1 || return 1
        ! docker container inspect ouro-butler-rollback >/dev/null 2>&1 || return 1
        TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-legacy-evidence) || return $?
        test "$TEMPLATE_RECOVERY_LEGACY_EVIDENCE_IMAGE_ID" = "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return 1
        test "$(docker inspect --format '{{.State.Running}}' ouro-butler-legacy-evidence)" = false || return 1
        audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" "$TARGET_MOUNT_CONTRACT" "$VERSION_IMAGE" "$TEMPLATE_ICON" || return $?
        start_only_butler_for_recovery || return $?
        wait_butler_ready ouro-butler || return $?
        migrate_sanctuary_package_managed_bundle "$IMAGE_ID" inspect >"$TEMPLATE_RECOVERY_INSPECTION" || return $?
        chown 0:0 "$TEMPLATE_RECOVERY_INSPECTION" && chmod 0600 "$TEMPLATE_RECOVERY_INSPECTION" || return $?
        write_dockerman_recovery_evidence absent adoption-target-exact-ready "$TEMPLATE_RECOVERY_INSPECTION" "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"roll-forward-adoption"}' || return 1
        enable_butler_autostart || return $?
        /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" mark-committing >/dev/null || return $?
      elif test "$TEMPLATE_RECOVERY_BUNDLE_STATE" = absent && test "$TEMPLATE_RECOVERY_STATE" = committing && test "$TEMPLATE_RECOVERY_PRODUCTION_IMAGE_ID" = "$IMAGE_ID"; then
        audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" "$TARGET_MOUNT_CONTRACT" "$VERSION_IMAGE" "$TEMPLATE_ICON" || return $?
        wait_butler_ready ouro-butler || return $?
        verify_butler_autostart "1 0 0 0" || return $?
        migrate_sanctuary_package_managed_bundle "$IMAGE_ID" inspect >"$TEMPLATE_RECOVERY_INSPECTION" || return $?
        chown 0:0 "$TEMPLATE_RECOVERY_INSPECTION" && chmod 0600 "$TEMPLATE_RECOVERY_INSPECTION" || return $?
        write_dockerman_recovery_evidence absent target-exact-ready "$TEMPLATE_RECOVERY_INSPECTION" "$TEMPLATE_RECOVERY_EVIDENCE" || return $?
        test "$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" recovery-action --evidence "$TEMPLATE_RECOVERY_EVIDENCE")" = '{"action":"finish-template-commit"}' || return 1
      else
        return 1
      fi
      TEMPLATE_RECOVERY_FINAL_PROOF=$(write_dockerman_final_proof "$IMAGE_ID" "$VERSION_IMAGE" "$TEMPLATE_ICON" "$TEMPLATE_RECOVERY_FINAL_ROOT") || return $?
      verify_known_good_rollback_artifact "$TEMPLATE_RECOVERY_ROLLBACK_IMAGE_ID" || return $?
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" commit --proof "$TEMPLATE_RECOVERY_FINAL_PROOF" >/dev/null || return $?
    }
    # Package installation and migration never grant restart authority. The
    # migration is the pre-activation assertion: it fails before live mutation
    # if packaged steward.json carries any routine grant. It preserves an
    # existing live steward policy and its audit receipts byte for byte. On a
    # new installation, start the healthy private runtime, then use
    # an authenticated owner Telegram turn to grant each exact restart target
    # through steward_policy_manage. That existing tool binds the grant to the
    # verified owner relationship and durable session event. Do not seed grants
    # in the packaged steward.json, copy an old session-event ID, or edit the
    # live policy/audit files directly. A missing grant remains fail-closed until
    # that explicit owner ceremony succeeds.
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
    classify_sanctuary_update_source() {
      UPDATE_ENTRY_CONTAINER_NAMES=$(docker container ls -a --format '{{.Names}}') || return $?
      if printf '%s\n' "$UPDATE_ENTRY_CONTAINER_NAMES" | grep -Fxq ouro-butler-staging; then
        return 1
      else
        UPDATE_ENTRY_SOURCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler) || return $?
        assert_update_topology "$UPDATE_ENTRY_SOURCE_IMAGE_ID" || return $?
        assert_sanctuary_update_source_pin ouro-butler "$UPDATE_ENTRY_SOURCE_IMAGE_ID"
      fi
    }
    admit_sanctuary_update_entry() {
      UPDATE_ENTRY_RECOVERY_JOURNAL=/boot/config/custom/ouro-butler/docker-man-template-transaction.json
      if test -e "$UPDATE_ENTRY_RECOVERY_JOURNAL" || test -L "$UPDATE_ENTRY_RECOVERY_JOURNAL"; then
        test -f "$UPDATE_ENTRY_RECOVERY_JOURNAL" && test ! -L "$UPDATE_ENTRY_RECOVERY_JOURNAL" || return 1
        test "$(stat -c '%u:%g:%a' "$UPDATE_ENTRY_RECOVERY_JOURNAL")" = 0:0:600
      else
        classify_sanctuary_update_source
      fi
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
    provision_sanctuary_sab_credential() {
      SAB_BOOTSTRAP_IMAGE_ID=$1
      validate_exact_image_id "$SAB_BOOTSTRAP_IMAGE_ID" || return $?
      SAB_BOOTSTRAP_SOURCE=/mnt/user/appdata/sabnzbd/sabnzbd.ini
      SAB_BOOTSTRAP_RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
      SAB_BOOTSTRAP_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      SAB_BOOTSTRAP_ENVELOPE="$SAB_BOOTSTRAP_RUNTIME_ROOT/container-credentials.json"
      SAB_BOOTSTRAP_CLAIM="$SAB_BOOTSTRAP_ENVELOPE.consuming"
      test -f "$SAB_BOOTSTRAP_SOURCE" || return $?
      test ! -L "$SAB_BOOTSTRAP_SOURCE" || return 1
      test ! -e "$SAB_BOOTSTRAP_ENVELOPE" || return 1
      test ! -e "$SAB_BOOTSTRAP_CLAIM" || return 1
      ! docker container inspect ouro-butler-sab-credential-bootstrap >/dev/null 2>&1 || return 1
      SAB_BOOTSTRAP_TMP=$(mktemp "$SAB_BOOTSTRAP_RUNTIME_ROOT/container-credentials.json.tmp.XXXXXX") || return $?
      trap 'rm -f -- "$SAB_BOOTSTRAP_TMP"' EXIT || return $?
      /usr/local/bin/node -e '
        const fs = require("node:fs");
        const [source, destination] = process.argv.slice(1);
        const match = fs.readFileSync(source, "utf8").match(/^\s*api_key\s*=\s*(\S+)\s*$/mu);
        if (!match || !match[1]) process.exit(1);
        const credential = { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", machineId: "sanctuary", machineRuntimeConfig: { sabnzbdApiKey: match[1] } };
        const envelope = { schemaVersion: 1, credentials: [credential] };
        fs.writeFileSync(destination, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "w" });
      ' "$SAB_BOOTSTRAP_SOURCE" "$SAB_BOOTSTRAP_TMP" || return $?
      chown 10001:10001 "$SAB_BOOTSTRAP_TMP" || return $?
      chmod 0600 "$SAB_BOOTSTRAP_TMP" || return $?
      sync -f "$SAB_BOOTSTRAP_TMP" || return $?
      mv -f -- "$SAB_BOOTSTRAP_TMP" "$SAB_BOOTSTRAP_ENVELOPE" || return $?
      sync -f "$SAB_BOOTSTRAP_RUNTIME_ROOT" || return $?
      trap - EXIT || return $?
      docker run --rm --pull=never --network host --name ouro-butler-sab-credential-bootstrap --user 10001:10001 \
        --mount "type=bind,src=$SAB_BOOTSTRAP_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=$SAB_BOOTSTRAP_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --entrypoint node "$SAB_BOOTSTRAP_IMAGE_ID" -e '
          const { loadContainerCredentialBootstrap } = require("/opt/ouro/dist/heart/daemon/container-credential-bootstrap.js");
          loadContainerCredentialBootstrap(["sanctuary"]).then(
            () => process.exit(0),
            () => { process.stderr.write("SAB credential bootstrap failed\n"); process.exit(1); },
          );
        ' || return $?
      ! docker container inspect ouro-butler-sab-credential-bootstrap >/dev/null 2>&1 || return 1
      test ! -e "$SAB_BOOTSTRAP_ENVELOPE" || return 1
      test ! -e "$SAB_BOOTSTRAP_CLAIM" || return 1
    }
    verify_sanctuary_sab_readiness() {
      SAB_READINESS_IMAGE_ID=$1
      validate_exact_image_id "$SAB_READINESS_IMAGE_ID" || return $?
      ! docker container inspect ouro-butler-sab-readiness >/dev/null 2>&1 || return 1
      docker run --rm --pull=never --network host --name ouro-butler-sab-readiness --user 10001:10001 \
        --mount "type=bind,src=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro,dst=/home/ouro/AgentBundles/sanctuary.ouro" \
        --entrypoint node "$SAB_READINESS_IMAGE_ID" -e '
          (async () => {
            try {
              const { refreshMachineRuntimeCredentialConfig } = require("/opt/ouro/dist/heart/runtime-credentials.js");
              const { createSanctuarySabClient } = require("/opt/ouro/dist/senses/sanctuary-sab.js");
              const current = await refreshMachineRuntimeCredentialConfig("sanctuary", "sanctuary");
              if (!current.ok || typeof current.config.sabnzbdApiKey !== "string" || !current.config.sabnzbdApiKey.trim()) throw new Error();
              const snapshot = await createSanctuarySabClient({ loadApiKey: async () => current.config.sabnzbdApiKey }).readQueue();
              if (typeof snapshot.paused !== "boolean" || !Number.isSafeInteger(snapshot.queuedJobs) || !snapshot.observedAt) throw new Error();
              process.stdout.write("Sanctuary SAB queue readiness verified.\n");
            } catch {
              process.stderr.write("Sanctuary SAB queue readiness verification failed.\n");
              process.exitCode = 1;
            }
          })();
        ' || return $?
      ! docker container inspect ouro-butler-sab-readiness >/dev/null 2>&1 || return 1
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
    verify_sanctuary_telegram_readiness() {
      TELEGRAM_READINESS_IMAGE_ID=$1
      validate_exact_image_id "$TELEGRAM_READINESS_IMAGE_ID" || return $?
      TELEGRAM_READINESS_CONTRACT=$(sanctuary_image_mount_contract "$TELEGRAM_READINESS_IMAGE_ID") || return $?
      case "$TELEGRAM_READINESS_CONTRACT" in
        canonical-gateway) set -- --mount "type=bind,src=/run/ouro-authority,dst=/run/ouro-authority,readonly" ;;
        canonical-pre-gateway) set -- ;;
        *) return 1 ;;
      esac
      TELEGRAM_READINESS_RUNTIME_ROOT=/mnt/user/appdata/ouro-butler/runtime/.ouro-cli
      TELEGRAM_READINESS_AGENT_ROOT=/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
      ! docker container inspect ouro-butler-telegram-readiness >/dev/null 2>&1 || return 1
      docker run --rm --pull=never --network host --name ouro-butler-telegram-readiness --user 10001:10001 \
        --read-only --cap-drop ALL --security-opt no-new-privileges \
        --mount "type=bind,src=$TELEGRAM_READINESS_RUNTIME_ROOT,dst=/home/ouro/.ouro-cli" \
        --mount "type=bind,src=$TELEGRAM_READINESS_AGENT_ROOT,dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly" \
        --entrypoint /opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh \
        "$@" "$TELEGRAM_READINESS_IMAGE_ID" telegram-readiness >/dev/null || return $?
      ! docker container inspect ouro-butler-telegram-readiness >/dev/null 2>&1 || return 1
      normalize_sanctuary_private_permissions "$TELEGRAM_READINESS_RUNTIME_ROOT" "$TELEGRAM_READINESS_AGENT_ROOT" "$TELEGRAM_READINESS_IMAGE_ID" || return $?
      if test "$TELEGRAM_READINESS_CONTRACT" = canonical-gateway; then
        validate_sanctuary_roots "$TELEGRAM_READINESS_RUNTIME_ROOT" "$TELEGRAM_READINESS_AGENT_ROOT" || return $?
      else
        validate_sanctuary_roots "$TELEGRAM_READINESS_RUNTIME_ROOT" "$TELEGRAM_READINESS_AGENT_ROOT" live-precutover || return $?
      fi
    }
    read_sanctuary_authority_state() {
      (
      test -n "${STAGED_DOCKERMAN_TRANSACTION-}" || return 1
      AUTHORITY_STATUS=$(/usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" status) || return $?
      printf '%s' "$AUTHORITY_STATUS" | /usr/local/bin/node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          const record = JSON.parse(input);
          if (record === null || (record && !Object.hasOwn(record, "authority"))) process.stdout.write("none");
          else if (["installing", "active", "retiring", "retired"].includes(record?.authority?.state)) process.stdout.write(record.authority.state);
          else process.exit(1);
        });
      ' || return $?
      )
    }
    retire_sanctuary_authority_if_pending() {
      (
      AUTHORITY_STATE=$(read_sanctuary_authority_state) || return $?
      test "$AUTHORITY_STATE" != none || return 0
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" authority-retire >/dev/null || return $?
      )
    }
    receive_sanctuary_authority_token() {
      (
      test "$(id -u)" = 0 && test -t 0 || return 1
      test "$(stat -c '%u:%g:%a' /mnt/user/appdata/ouro-authority)" = 0:0:700 || return 1
      test ! -e /mnt/user/appdata/ouro-authority/incoming-token && test ! -L /mnt/user/appdata/ouro-authority/incoming-token || return 1
      TOKEN_TERMINAL_MODE=$(stty -g) || return $?
      trap 'stty "$TOKEN_TERMINAL_MODE"' EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      printf '%s\n' 'Human: paste the freshly rotated same-bot token, press Enter, then Ctrl-D. Input is hidden.' >&2
      stty -echo || return $?
      umask 077
      set -C
      dd status=none > /mnt/user/appdata/ouro-authority/incoming-token || return $?
      test -s /mnt/user/appdata/ouro-authority/incoming-token || return 1
      sync -f /mnt/user/appdata/ouro-authority/incoming-token || return $?
      )
    }
    prepare_sanctuary_authority_inputs() {
      (
      AUTHORITY_SOURCE=$1
      test "$(id -u)" = 0 || return 1
      /usr/local/bin/node - "$AUTHORITY_SOURCE" "$AUTHORITY_EPOCH_ID" "$AUTHORITY_BOT_ID" "$AUTHORITY_OWNER_ID" <<'NODE'
        const fs = require("node:fs");
        const path = require("node:path");
        const crypto = require("node:crypto");
        const [source, epochId, botId, ownerId] = process.argv.slice(2);
        const root = "/mnt/user/appdata/ouro-authority";
        const incoming = `${root}/incoming-package`;
        const sha = bytes => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
        const directory = target => {
          if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
          const stat = fs.lstatSync(target);
          if (!stat.isDirectory() || fs.realpathSync(target) !== target || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) throw new Error("unsafe authority input directory");
        };
        const owned = (target, mode) => {
          const stat = fs.lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== mode) throw new Error("unsafe authority input file");
          return fs.readFileSync(target);
        };
        const persist = (target, bytes, mode) => {
          if (fs.existsSync(target)) {
            if (!owned(target, mode).equals(bytes)) throw new Error("authority input conflicts with retained recovery bytes");
          } else {
            const fd = fs.openSync(target, "wx", mode);
            try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          }
        };
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(epochId) || !/^[1-9][0-9]*$/.test(botId) || !/^[1-9][0-9]*$/.test(ownerId)) throw new Error("invalid reviewed identity");
        directory(root);
        directory(incoming);
        const sourceRoot = fs.realpathSync(source);
        const files = {};
        const walk = (relative, ancestors = []) => {
          const input = path.join(sourceRoot, relative);
          const resolved = fs.realpathSync(input);
          if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}/`)) throw new Error("package link escapes exact image payload");
          if (ancestors.includes(resolved)) throw new Error("package link cycle");
          const stat = fs.statSync(input);
          if (stat.isDirectory()) {
            directory(path.join(incoming, relative));
            for (const name of fs.readdirSync(input).sort()) {
              if (!/^[A-Za-z0-9_@.-]+$/.test(name) || name === "." || name === "..") throw new Error("unsupported package path");
              walk(path.join(relative, name), [...ancestors, resolved]);
            }
          } else {
            if (!stat.isFile()) throw new Error("non-file package payload");
            const bytes = fs.readFileSync(input);
            const mode = stat.mode & 0o111 ? 0o700 : 0o600;
            persist(path.join(incoming, relative), bytes, mode);
            files[relative] = { digest: sha(bytes), mode };
          }
        };
        walk("");
        const actual = [];
        const inventory = relative => {
          for (const entry of fs.readdirSync(path.join(incoming, relative), { withFileTypes: true })) {
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) inventory(name); else actual.push(name);
          }
        };
        inventory("");
        if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(files).sort())) throw new Error("unexpected incoming package residue");
        for (const required of ["package.json", "npm-shrinkwrap.json", "dist/heart/daemon/sanctuary-authority-root-lifecycle.js", "dist/heart/daemon/sanctuary-telegram-authority-entry.js", "dist/heart/daemon/sanctuary-host-supervisor-entry.js", "deploy/unraid/sanctuary-host-launcher.sh", "deploy/unraid/sanctuary-authority-service.sh"]) {
          if (!files[required]) throw new Error(`missing authority package asset: ${required}`);
        }
        if (!Object.keys(files).some(name => name.startsWith("node_modules/"))) throw new Error("production dependencies are absent");
        const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, files })}\n`);
        if (manifest.byteLength > 8388608) throw new Error("complete package manifest exceeds the root lifecycle 8388608-byte limit; stop before token rotation");
        persist(`${root}/package-manifest.json`, manifest, 0o600);
        const primitive = file => {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) || !(stat.mode & 0o111)) throw new Error("unsafe host primitive");
          return sha(fs.readFileSync(file));
        };
        const request = { schemaVersion: 1, epochId, botId, ownerUserId: ownerId, ownerChatId: ownerId, packageDigest: sha(manifest), nodeDigest: primitive("/usr/local/bin/node"), prlimitDigest: primitive("/usr/bin/prlimit"), setsidDigest: primitive("/usr/bin/setsid"), shellDigest: primitive("/bin/sh") };
        persist(`${root}/request.json`, Buffer.from(`${JSON.stringify(request)}\n`), 0o600);
        if (fs.existsSync(`${root}/incoming-token`)) owned(`${root}/incoming-token`, 0o600);
        const fd = fs.openSync(root, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
      )
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
  Before downloading or staging anything, classify the live production source with the existing topology gates unless the fixed root-owned DockerMan transaction journal signals that an interrupted update needs the exact packaged recovery tools. Staging-only adoption is retired. A recovery journal admits only image acquisition and private staging until the staged transaction implementation validates the full journal and restores a classifiable source:
    admit_sanctuary_update_entry
  Set the released package version, its reviewed release-manifest digest, and its reviewed platform-local image ID. The canonical package-version tag is immutable release identity, while the digest and local ID independently prove what the registry and this host resolved:
    PACKAGE_VERSION=<released-version>
    MANIFEST_DIGEST=sha256:<reviewed-release-manifest-digest>
    IMAGE_ID=sha256:<reviewed-local-image-id>
    VERSION_IMAGE="ghcr.io/ourostack/ouroboros-butler:$PACKAGE_VERSION"
    printf '%s\n' "$PACKAGE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
    test "$(inspect_registry_manifest_digest "$VERSION_IMAGE")" = "$MANIFEST_DIGEST"
    docker pull "$VERSION_IMAGE"
    validate_exact_image_id "$IMAGE_ID"
    test "$(docker image inspect --format '{{.Id}}' "$VERSION_IMAGE")" = "$IMAGE_ID"
    AUDIT_RUNNER_IMAGE_ID=$IMAGE_ID
    validate_exact_image_id "$AUDIT_RUNNER_IMAGE_ID"
    TARGET_MOUNT_CONTRACT=$(sanctuary_image_mount_contract "$IMAGE_ID")
    test "$TARGET_MOUNT_CONTRACT" = canonical-gateway
    TEMPLATE_ICON=https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png
    DOCKERMAN_TEMPLATE_PATH=/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml
    DOCKERMAN_TEMPLATE_JOURNAL=/boot/config/custom/ouro-butler/docker-man-template-transaction.json
    test "$DOCKERMAN_TEMPLATE_PATH" = /boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml
    test "$DOCKERMAN_TEMPLATE_JOURNAL" = /boot/config/custom/ouro-butler/docker-man-template-transaction.json
  Before stopping, renaming, or creating any Butler container, extract the complete /opt/ouro package from that exact image ID, including production node_modules and package-relative dist. Do not copy these files from a checkout or another image. The branch still has package version alpha.816; version alone is not the mount contract. Only the reviewed new image's bot.ouro.sanctuary.mount-contract=canonical-gateway label admits the fourth mount. The immutable source alpha.816 ID above remains canonical-pre-gateway even when its npm version equals the target package version; no version bump or retag is implied.
  Stage the event assets, audit the original version-tagged template, create a separate temporary copy for exact local-image-ID auditing, and keep the private stage until the outer transaction commits:
    EVENT_ASSET_STAGE=$(mktemp -d /mnt/user/appdata/ouro-butler/staging/ouro-events.XXXXXX)
    chmod 0700 "$EVENT_ASSET_STAGE"
    EVENT_SCRIPT_STAGE="$EVENT_ASSET_STAGE/ouro-events"
    mkdir "$EVENT_SCRIPT_STAGE"
    STAGED_PACKAGE_ROOT="$EVENT_ASSET_STAGE/package"
    mkdir "$STAGED_PACKAGE_ROOT"
    STAGED_TEMPLATE="$EVENT_ASSET_STAGE/sanctuary.xml"
    STAGED_EXACT_TEMPLATE="$EVENT_ASSET_STAGE/sanctuary.exact-image.xml"
    STAGED_RUNTIME_POLICY="$EVENT_ASSET_STAGE/container-runtime.json"
    STAGED_DOCKERMAN_TRANSACTION="$STAGED_PACKAGE_ROOT/deploy/unraid/docker-man-template-transaction.mjs"
    STAGED_DOCKERMAN_XML_VALIDATOR="$STAGED_PACKAGE_ROOT/deploy/unraid/docker-man-template-xml.cjs"
    EVENT_ASSET_CONTAINER=
    cleanup_event_asset_stage() {
      if test -n "$EVENT_ASSET_CONTAINER"; then
        docker rm --force "$EVENT_ASSET_CONTAINER" >/dev/null 2>&1 || true
      fi
      rm -rf -- "$EVENT_ASSET_STAGE"
    }
    trap cleanup_event_asset_stage EXIT
    EVENT_ASSET_CONTAINER=$(docker create --pull=never --network none --read-only --entrypoint /bin/false "$IMAGE_ID")
    test "$(docker inspect --format '{{.Image}}' "$EVENT_ASSET_CONTAINER")" = "$IMAGE_ID"
    docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/." "$STAGED_PACKAGE_ROOT/"
    docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/deploy/unraid/ouro-events/." "$EVENT_SCRIPT_STAGE/"
    docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/deploy/unraid/sanctuary.xml" "$STAGED_TEMPLATE"
    docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/deploy/unraid/container-runtime.json" "$STAGED_RUNTIME_POLICY"
    docker rm "$EVENT_ASSET_CONTAINER"
    EVENT_ASSET_CONTAINER=
    EXPECTED_RELEASE_ASSETS=$(printf '%s\n' container-runtime.json ouro-events package sanctuary.xml)
    ACTUAL_RELEASE_ASSETS=$(find "$EVENT_ASSET_STAGE" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)
    test "$ACTUAL_RELEASE_ASSETS" = "$EXPECTED_RELEASE_ASSETS"
    test -d "$EVENT_SCRIPT_STAGE" && test ! -L "$EVENT_SCRIPT_STAGE"
    test -f "$STAGED_TEMPLATE" && test ! -L "$STAGED_TEMPLATE"
    test -f "$STAGED_RUNTIME_POLICY" && test ! -L "$STAGED_RUNTIME_POLICY"
    test -f "$STAGED_DOCKERMAN_TRANSACTION" && test ! -L "$STAGED_DOCKERMAN_TRANSACTION"
    test -f "$STAGED_DOCKERMAN_XML_VALIDATOR" && test ! -L "$STAGED_DOCKERMAN_XML_VALIDATOR"
    chown 0:0 "$STAGED_TEMPLATE" "$STAGED_RUNTIME_POLICY" "$STAGED_DOCKERMAN_TRANSACTION" "$STAGED_DOCKERMAN_XML_VALIDATOR"
    chmod 0600 "$STAGED_TEMPLATE" "$STAGED_RUNTIME_POLICY" "$STAGED_DOCKERMAN_TRANSACTION" "$STAGED_DOCKERMAN_XML_VALIDATOR"
    chown -R 0:0 "$STAGED_PACKAGE_ROOT"
    chmod 0700 "$STAGED_PACKAGE_ROOT"
    EXPECTED_EVENT_ASSETS=$(printf '%s\n' bootstrap-spool.sh emit-event.mjs emit-usenet-event.sh install-usenet-guard.sh usenet-health.sh)
    ACTUAL_EVENT_ASSETS=$(find "$EVENT_SCRIPT_STAGE" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)
    test "$ACTUAL_EVENT_ASSETS" = "$EXPECTED_EVENT_ASSETS"
    test -z "$(find "$EVENT_SCRIPT_STAGE" -mindepth 1 -maxdepth 1 \( -type l -o ! -type f \) -print -quit)"
    verify_installed_usenet_guard() {
      test "$(findmnt -n -o FSTYPE --target /boot/config/custom)" = vfat
      test "$(stat -c '%u:%g:%a' /boot/config/custom/usenet_health.sh)" = 0:0:600
      test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/bootstrap-spool.sh)" = 0:0:600
      test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/emit-event.mjs)" = 0:0:600
      test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/emit-usenet-event.sh)" = 0:0:600
      test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/install-usenet-guard.sh)" = 0:0:600
      cmp -s "$EVENT_SCRIPT_STAGE/usenet-health.sh" /boot/config/custom/usenet_health.sh
      cmp -s "$EVENT_SCRIPT_STAGE/bootstrap-spool.sh" /boot/config/custom/ouro-events/bootstrap-spool.sh
      cmp -s "$EVENT_SCRIPT_STAGE/emit-event.mjs" /boot/config/custom/ouro-events/emit-event.mjs
      cmp -s "$EVENT_SCRIPT_STAGE/emit-usenet-event.sh" /boot/config/custom/ouro-events/emit-usenet-event.sh
      cmp -s "$EVENT_SCRIPT_STAGE/install-usenet-guard.sh" /boot/config/custom/ouro-events/install-usenet-guard.sh
      test "$(grep -Fxc '/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot --install-root /boot/config/custom' /boot/config/go)" = 1
      test "$(grep -Fxc '/boot/config/custom/ouro-events/bootstrap-spool.sh --mount' /boot/config/go || true)" = 0
      test "$(grep -Fxc '(crontab -l 2>/dev/null | grep -v usenet_health; echo "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh") | crontab -' /boot/config/go || true)" = 0
      INSTALLED_GUARD_CRON=$(crontab -l)
      test "$(printf '%s\n' "$INSTALLED_GUARD_CRON" | grep -Fxc '*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh # ouro:usenet-health')" = 1
      INSTALLED_LEGACY_GUARD_COUNT=$(printf '%s\n' "$INSTALLED_GUARD_CRON" | grep -Fxc '*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh' || true)
      test "$INSTALLED_LEGACY_GUARD_COUNT" = 0
      test "$(printf '%s\n' "$INSTALLED_GUARD_CRON" | grep -Fc '/bin/bash /boot/config/custom/usenet_health.sh')" = 1
      test "$(findmnt -n -o FSTYPE --target /boot/config/custom/ouro-events/spool)" = tmpfs
      test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/spool)" = 0:0:755
      INSTALLED_SPOOL_OPTIONS=$(findmnt -n -o OPTIONS --target /boot/config/custom/ouro-events/spool)
      for INSTALLED_SPOOL_OPTION in nodev nosuid noexec; do
        case ",$INSTALLED_SPOOL_OPTIONS," in *",$INSTALLED_SPOOL_OPTION,"*) ;; *) return 1 ;; esac
      done
      INSTALLED_SPOOL_SIZE=$(findmnt -bn -o SIZE --target /boot/config/custom/ouro-events/spool)
      test "$INSTALLED_SPOOL_SIZE" -le 4194304
    }
    docker run --rm --pull=never --network=none \
      --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
      --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
      --mount "type=bind,src=$STAGED_TEMPLATE,dst=/audit/sanctuary.xml,readonly" \
      --mount "type=bind,src=$STAGED_RUNTIME_POLICY,dst=/audit/container-runtime.json,readonly" \
      "$IMAGE_ID" --persistent-template /audit/sanctuary.xml --runtime-policy /audit/container-runtime.json --expected-image-reference "$VERSION_IMAGE" --mount-contract "$TARGET_MOUNT_CONTRACT"
    /usr/local/bin/node -e '
      const fs = require("node:fs");
      const [sourcePath, destinationPath, imageId] = process.argv.slice(1);
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error("invalid exact image ID");
      const source = fs.readFileSync(sourcePath, "utf8");
      const repositories = [...source.matchAll(/<Repository>[^<]*<\/Repository>/g)];
      if (repositories.length !== 1) throw new Error("template must contain exactly one Repository element");
      const staged = source.replace(repositories[0][0], `<Repository>${imageId}</Repository>`);
      if ((staged.match(/<Repository>[^<]*<\/Repository>/g) ?? []).length !== 1
        || !staged.includes(`<Repository>${imageId}</Repository>`)) throw new Error("exact Repository staging failed");
      fs.writeFileSync(destinationPath, staged, { mode: 0o600, flag: "wx" });
    ' "$STAGED_TEMPLATE" "$STAGED_EXACT_TEMPLATE" "$IMAGE_ID"
    chown 0:0 "$STAGED_EXACT_TEMPLATE"
    chmod 0600 "$STAGED_EXACT_TEMPLATE"
    docker run --rm --pull=never --network=none \
      --user 0:0 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
      --entrypoint /opt/ouro/deploy/unraid/audit-container-spec.sh \
      --mount "type=bind,src=$STAGED_EXACT_TEMPLATE,dst=/audit/sanctuary.exact-image.xml,readonly" \
      --mount "type=bind,src=$STAGED_RUNTIME_POLICY,dst=/audit/container-runtime.json,readonly" \
      "$IMAGE_ID" --template /audit/sanctuary.exact-image.xml --runtime-policy /audit/container-runtime.json --expected-image "$IMAGE_ID" --mount-contract "$TARGET_MOUNT_CONTRACT"
    recover_dockerman_template_transaction
    recover_pending_sanctuary_bundle_migration "$IMAGE_ID"
    classify_sanctuary_update_source
    /bin/bash "$EVENT_SCRIPT_STAGE/install-usenet-guard.sh" --source-root "$EVENT_SCRIPT_STAGE"
    /bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot --install-root /boot/config/custom
    verify_installed_usenet_guard
  If extraction or transactional installation fails, abort before changing any live Butler container. The installer restores the previous assets, go file, and cron; production stays running.
  If boot activation or verification fails after that transaction commits, leave production untouched, repair or rerun this exact-image installation, and stop. Container and DockerMan rollback begin only after the later production preflight succeeds.
  For normal updates, preflight accepts only the pinned alpha.742 two-mount source or an already package-managed canonical source before any autostart or live-container change. The pinned exception may validate an old source, but can never authorize creation of a new target. Provider authentication and standalone credential-readiness helpers are not normal-update prechecks; never place credentials in arguments, shell variables or history.
  The DockerMan transaction binds Jellyfin's container ID, image ID, state, and restart count. Update, rollback and recovery must preserve that checkpoint.
  For this authority migration, only the exact pinned alpha.816 predecessor may become rollback. The legacy-alpha742 digest remains supported for historical source audits, not a policy-weak authority rollback. Preserve one exact stopped alpha.816 predecessor, Jellyfin and every policy/history byte. Staging must be absent and production must be the only running resident. Capture the non-secret reviewed bot/owner/epoch inputs; OWNER_ID is the already authenticated private Telegram user/chat, never inferred from resident-written prose:
    AUTHORITY_EPOCH_ID=<new-reviewed-epoch-id>
    AUTHORITY_BOT_ID=8541786263
    AUTHORITY_OWNER_ID=<reviewed-private-owner-user-and-chat-id>
    install -d -m 0700 -o 0 -g 0 /mnt/user/appdata/ouro-authority
  Disable every Butler name in Unraid's array-autostart file before authority-install freezes the resident. First resolve and validate the exact known-good image while it is still running:
    /bin/bash /boot/config/custom/ouro-events/bootstrap-spool.sh --mount
    test "$(findmnt -n -o FSTYPE --target /boot/config/custom/ouro-events/spool)" = tmpfs
    test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/spool)" = 0:0:755
    ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
    validate_exact_image_id "$ROLLBACK_IMAGE_ID"
    ROLLBACK_MOUNT_CONTRACT=$(sanctuary_image_mount_contract "$ROLLBACK_IMAGE_ID")
    test "$ROLLBACK_IMAGE_ID" = sha256:589b7cf8f96d139ee9fd86204a183126aadcbd3fbfb406063709be303397b1b2
    test "$ROLLBACK_MOUNT_CONTRACT" = canonical-pre-gateway
    if assert_update_topology "$ROLLBACK_IMAGE_ID"; then
      :
    else
      UPDATE_PREFLIGHT_STATUS=$?
      (exit "$UPDATE_PREFLIGHT_STATUS")
    fi
    assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
    if provision_sanctuary_sab_credential "$IMAGE_ID" \
      && verify_sanctuary_sab_readiness "$IMAGE_ID" \
      && verify_sanctuary_telegram_readiness "$ROLLBACK_IMAGE_ID"; then
      :
    else
      PRECUTOVER_READINESS_STATUS=$?
      (exit "$PRECUTOVER_READINESS_STATUS")
    fi
  Prepare the complete package and request before human token revocation. The input helper's manifest-size check must pass the root lifecycle reader's 8388608-byte manifest limit; ordinary private records retain their 1048576-byte limit. Do not prune dependencies or split the inventory to bypass either bound. If this check refuses the full payload, leave the existing token, autostart and resident unchanged:
    prepare_sanctuary_authority_inputs "$STAGED_PACKAGE_ROOT"
  The input helper copies every regular package file and materializes only package-internal dependency symlinks as independent files, hashes the complete inventory with exact modes, and writes mode-0600 manifest/request files. The request binds schemaVersion, epochId, botId, ownerUserId, ownerChatId, packageDigest and the actual root node/prlimit/setsid/shell hashes. Review those hashes against the approved package and host primitives before prepare. Repeated preparation accepts only identical retained inputs; unknown extra files, external links or changed bytes fail closed. No network token probe or resident start occurs in preparation.
  Prepare the durable transaction and disable autostart before the human rotates any token:
    /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" prepare --source-template "$STAGED_TEMPLATE" --version-tag "$VERSION_IMAGE" --manifest-digest "$MANIFEST_DIGEST" --rollback-image-id "$ROLLBACK_IMAGE_ID" --target-image-id "$IMAGE_ID" >/dev/null
  Guard the atomic autostart disable separately. If it fails, the original token remains valid and production has not been touched; restore the template and propagate the captured status:
    if disable_butler_autostart; then
      :
    else
      AUTOSTART_DISABLE_STATUS=$?
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null
      (exit "$AUTOSTART_DISABLE_STATUS")
    fi
  Only after pinned old-image readiness, full-package preparation, durable transaction preparation and autostart disabling pass, the human rotates MendelowCloudButlerBot's token for that same numeric bot and uses the hidden root-terminal input helper. Do not echo the token, put it in argv/environment/history, copy it into the resident, or replace retained incoming-token during recovery. A failed or interrupted paste must be reconciled by the human before retry; retain the journal and disabled autostart, and do not invent a token:
    receive_sanctuary_authority_token
    test "$(stat -c '%u:%g:%a' /mnt/user/appdata/ouro-authority/incoming-token)" = 0:0:600
  Gateway installation and its tokenless readiness belong inside the stopped-resident transaction, never in the old live precheck. A failure attempts retirement and exact old-image restoration; failure of either keeps autostart disabled and the journals/root inputs intact:
    if /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" authority-install >/dev/null \
      && verify_sanctuary_telegram_readiness "$IMAGE_ID"; then
      :
    else
      AUTHORITY_INSTALL_STATUS=$?
      retire_sanctuary_authority_if_pending
      assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
      start_only_butler_for_recovery
      wait_butler_ready ouro-butler
      enable_butler_autostart
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null
      (exit "$AUTHORITY_INSTALL_STATUS")
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
  Stop production, remove only a stopped stale rollback, rename the known-good container, verify it remains stopped, and apply the exact target image's package-managed bundle migration in one explicit preparation guard.
  Package-managed files are exactly `provider-readiness.json`, `tool-profiles.json`, `habits/sanctuary-health.md`, and the five canonical files under `psyche/`. The migration also merges the three bundle-meta version fields. It never installs or mutates steward policy authority. It preserves agent.json, all steward policy and audit bytes, relationships, sessions, and every other state path. Repeating it is a no-op.
  Before its first managed write, the migrator atomically fsyncs one mode-0600 rollback record at `.sanctuary-package-managed-rollback.json`. That record binds the verified prior bytes, modes, and parent existence for every managed file plus bundle-meta to distinct exact rollback and target image IDs. It is the migration receipt, not a second bundle authority.
  A managed-file failure restores the prior bytes immediately. Every later container rollback also restores those bytes before the old container restarts, while retaining the receipt; only after the old production container is audited, ready, and back on autostart does `finalize-rollback` remove it without marking the new release committed.
  After an interrupted update, the same receipt removes partial new containers, discards only validated interrupted-write stages, restores the prior bundle idempotently, and permits only the recorded rollback image to resume as production. A malformed receipt, wrong image, or restore failure leaves autostart disabled and stops safely.
  Once target readiness and autostart pass, `commit` durably marks the receipt as committing. If interruption happens then, the target stays in place and the next run rechecks its exact topology and readiness before finishing. Migration failure enters the same container rollback arm before target production starts:
    if docker stop ouro-butler \
      && remove_stopped_rollback_if_present "$ROLLBACK_IMAGE_ID" \
      && docker rename ouro-butler ouro-butler-rollback \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false \
      && assert_only_running_butler - \
      && migrate_sanctuary_package_managed_bundle "$IMAGE_ID" migrate "$ROLLBACK_IMAGE_ID"; then
      :
    else
      PRODUCTION_PREPARATION_STATUS=$?
      PRODUCTION_PREPARATION_CLEANUP_STATUS=0
      PRODUCTION_PREPARATION_RECOVERY_SAFE=true
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" verify-jellyfin >/dev/null
      retire_sanctuary_authority_if_pending
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
          docker stop ouro-butler-rollback >/dev/null 2>&1 || true
          CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)
          test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"
          docker rm --force ouro-butler-rollback >/dev/null 2>&1 || true
        fi
        if docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
          PRODUCTION_PREPARATION_CLEANUP_STATUS=1
          if test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" != false; then
            PRODUCTION_PREPARATION_RECOVERY_SAFE=false
          fi
        fi
        rollback_sanctuary_bundle_if_pending "$IMAGE_ID"
        if test "$PRODUCTION_PREPARATION_RECOVERY_SAFE" = true; then
          assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
          start_only_butler_for_recovery
          wait_butler_ready ouro-butler
          enable_butler_autostart
          finalize_sanctuary_bundle_rollback_if_retained "$IMAGE_ID"
        fi
      elif docker container inspect ouro-butler-rollback >/dev/null 2>&1; then
        docker stop ouro-butler-rollback >/dev/null 2>&1 || true
        test "$(docker inspect --format '{{.Image}}' ouro-butler-rollback)" = "$ROLLBACK_IMAGE_ID"
        rollback_sanctuary_bundle_if_pending "$IMAGE_ID"
        docker rename ouro-butler-rollback ouro-butler
        assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
        start_only_butler_for_recovery
        wait_butler_ready ouro-butler
        enable_butler_autostart
        finalize_sanctuary_bundle_rollback_if_retained "$IMAGE_ID"
      fi
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null
      if test "$PRODUCTION_PREPARATION_CLEANUP_STATUS" -ne 0; then
        exit "$PRODUCTION_PREPARATION_CLEANUP_STATUS"
      fi
      (exit "$PRODUCTION_PREPARATION_STATUS")
    fi
  Preparation failure therefore either restores the still-named exact production after attempting to remove any stale rollback, or renames the exact stopped rollback back. Both safe paths revalidate and start the old container, wait within the fixed bound, restore production-only autostart atomically, and return the original failure. If stale rollback removal fails, restore production only when the leftover is proven stopped; otherwise leave both containers untouched, roll back the journals, and return the cleanup failure for repair.
  If neither exact container can be found, the failure returns with Butler autostart disabled.
  Do not start a target-image daemon between the production rename and final production activation. The exact-image static audit and download-queue readiness have passed. The old image's pinned pre-gateway readiness ran before cutover; the new image's socket-mounted tokenless readiness ran only after authority-install proved the root gateway.
  Provider and complete daemon readiness are exercised only by the transactional production activation below. Its failure arm restores and revalidates the exact prior production, so a disposable daemon cannot reconcile or claim live external-event state before cutover.
  Create and activate production from the same exact image ID and exact authority in one explicit conditional so `set -eu` cannot exit before rollback. Only a successful create, effective audit, start, stopped-rollback assertion, and bounded readiness wait may enable production autostart.
  On failure, capture the activation status, remove only a partially created new production container, restore and audit the stopped rollback against its exact old image ID, prove it ready, restore production-only autostart atomically, and return the original failure. If the partial target cannot be removed, preserve its matching target bundle and retained migration receipt, roll back the DockerMan journal without attempting the colliding rename, then return the cleanup failure:
    if test "$(inspect_registry_manifest_digest "$VERSION_IMAGE")" = "$MANIFEST_DIGEST" \
      && test "$(docker image inspect --format '{{.Id}}' "$VERSION_IMAGE")" = "$IMAGE_ID" \
      && create_sanctuary_container "$IMAGE_ID" "$VERSION_IMAGE" "$TARGET_MOUNT_CONTRACT" \
      && audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" "$TARGET_MOUNT_CONTRACT" "$VERSION_IMAGE" "$TEMPLATE_ICON" \
      && assert_only_running_butler - \
      && /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" authority-activate >/dev/null \
      && assert_only_running_butler ouro-butler \
      && test "$(docker inspect --format '{{.Image}}' ouro-butler)" = "$IMAGE_ID" \
      && test "$(docker inspect --format '{{.State.Running}}' ouro-butler-rollback)" = false \
      && wait_butler_ready ouro-butler \
      && enable_butler_autostart \
      && /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" mark-committing >/dev/null; then
      :
    else
      PRODUCTION_ACTIVATION_STATUS=$?
      PRODUCTION_ACTIVATION_CLEANUP_STATUS=0
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" verify-jellyfin >/dev/null
      retire_sanctuary_authority_if_pending
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        docker stop ouro-butler >/dev/null 2>&1 || true
        PARTIAL_PRODUCTION_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler)
        test "$PARTIAL_PRODUCTION_IMAGE_ID" = "$IMAGE_ID"
        docker rm --force ouro-butler >/dev/null 2>&1 || true
      fi
      if docker container inspect ouro-butler >/dev/null 2>&1; then
        PRODUCTION_ACTIVATION_CLEANUP_STATUS=1
      fi
      if test "$PRODUCTION_ACTIVATION_CLEANUP_STATUS" -eq 0; then
        CURRENT_ROLLBACK_IMAGE_ID=$(docker inspect --format '{{.Image}}' ouro-butler-rollback)
        test "$CURRENT_ROLLBACK_IMAGE_ID" = "$ROLLBACK_IMAGE_ID"
        migrate_sanctuary_package_managed_bundle "$IMAGE_ID" rollback
        docker rename ouro-butler-rollback ouro-butler
        assert_update_source "$ROLLBACK_IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID"
        start_only_butler_for_recovery
        wait_butler_ready ouro-butler
        enable_butler_autostart
        migrate_sanctuary_package_managed_bundle "$IMAGE_ID" finalize-rollback
      fi
      /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" rollback >/dev/null
      if test "$PRODUCTION_ACTIVATION_CLEANUP_STATUS" -ne 0; then
        exit "$PRODUCTION_ACTIVATION_CLEANUP_STATUS"
      fi
      (exit "$PRODUCTION_ACTIVATION_STATUS")
    fi
    migrate_sanctuary_package_managed_bundle "$IMAGE_ID" commit
    FINAL_PROOF_ROOT="$EVENT_ASSET_STAGE/final-proof"
    FINAL_PROOF_PATH=$(write_dockerman_final_proof "$IMAGE_ID" "$VERSION_IMAGE" "$TEMPLATE_ICON" "$FINAL_PROOF_ROOT")
    verify_known_good_rollback_artifact "$ROLLBACK_IMAGE_ID"
    /usr/local/bin/node "$STAGED_DOCKERMAN_TRANSACTION" commit --proof "$FINAL_PROOF_PATH" >/dev/null
    cleanup_event_asset_stage
    trap - EXIT
  Keep ouro-butler-rollback stopped until the new production container is proven or the explicit rollback arm restores it. The rollback arm first retires root registrations and executions, stops the gateway, ends the epoch and restores the current valid token/cursor. Only then does it restore the prior bundle and rename the untouched three-mount alpha.816 container. start_only_butler_for_recovery invokes authority-restore while the authority journal exists; it cannot bypass retirement with docker start. Never create production from a mutable tag, a bare tag, or a bare local image ID.
  Docker tab Update, Force Update, Edit/Apply, Update All, and CA Action Centre updates remain visible but are unsupported because stock recreation deletes reviewed rollback evidence. Visibility, start, stop, and autostart remain supported; use only this reviewed version-tag transaction for updates.
  Community Apps determines installed state from the DockerMan template plus the live container name and image. The helper proves that same relationship without calling the endpoint that refreshes Community Apps' UI cache; the later live UI smoke confirms what Ari sees.

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
    backup_host_file() {
      BACKUP_HOST_SOURCE=$1
      BACKUP_HOST_RELATIVE=$2
      case "$BACKUP_HOST_RELATIVE" in
        custom/usenet_health.sh|custom/ouro-events/bootstrap-spool.sh|custom/ouro-events/emit-event.mjs|custom/ouro-events/emit-usenet-event.sh|custom/ouro-events/install-usenet-guard.sh) ;;
        *) return 1 ;;
      esac
      if test -e "$BACKUP_HOST_SOURCE" || test -L "$BACKUP_HOST_SOURCE"; then
        test -f "$BACKUP_HOST_SOURCE" && test ! -L "$BACKUP_HOST_SOURCE" || return 1
        ! host_file_contains_inline_credential "$BACKUP_HOST_SOURCE" || return 1
        install -D -m 0600 -o 0 -g 0 "$BACKUP_HOST_SOURCE" "$BACKUP_TMP/host/$BACKUP_HOST_RELATIVE" || return $?
        printf 'present\t%s\n' "$BACKUP_HOST_RELATIVE" >>"$BACKUP_TMP/host/inventory" || return $?
      else
        printf 'absent\t%s\n' "$BACKUP_HOST_RELATIVE" >>"$BACKUP_TMP/host/inventory" || return $?
      fi
    }
    host_file_contains_inline_credential() {
      LC_ALL=C awk '
        BEGIN { IGNORECASE = 1; found = 0 }
        /[0-9]{6,}:[A-Za-z0-9_-]{20,}/ { found = 1 }
        /Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+["\047]?[A-Za-z0-9][A-Za-z0-9._~+\/=:-]{11,}/ { found = 1 }
        /--(token|api-key|api_key|secret|password)(=|[[:space:]]+)["\047]?[A-Za-z0-9][A-Za-z0-9._~+\/=:-]{11,}/ { found = 1 }
        /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\/@[:space:]]+:[^\/@[:space:]]+@/ { found = 1 }
        /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----/ { found = 1 }
        /(token|secret|password|pass|api[_-]?key)[A-Za-z0-9_-]*["\047[:space:]]*[:=][[:space:]]*["\047]?[A-Za-z0-9][A-Za-z0-9._~+\/=:-]{11,}/ { found = 1 }
        END { exit found ? 0 : 1 }
      ' "$1"
    }
    snapshot_butler_go_fragments() {
      BACKUP_GO_SOURCE=$1
      BACKUP_GO_TARGET=$2
      : >"$BACKUP_GO_TARGET" || return $?
      while IFS= read -r BACKUP_GO_LINE || test -n "$BACKUP_GO_LINE"; do
        case "$BACKUP_GO_LINE" in
          "/boot/config/custom/ouro-events/bootstrap-spool.sh --mount"|"/bin/bash /boot/config/custom/ouro-events/bootstrap-spool.sh --mount"|"/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot"|"/bin/bash /boot/config/custom/ouro-events/install-usenet-guard.sh --boot --install-root /boot/config/custom")
            printf '%s\n' "$BACKUP_GO_LINE" >>"$BACKUP_GO_TARGET" || return $?
            ;;
        esac
      done <"$BACKUP_GO_SOURCE"
    }
    snapshot_butler_cron_fragments() {
      BACKUP_CRON_INPUT=$1
      BACKUP_CRON_TARGET=$2
      : >"$BACKUP_CRON_TARGET" || return $?
      while IFS= read -r BACKUP_CRON_LINE || test -n "$BACKUP_CRON_LINE"; do
        case "$BACKUP_CRON_LINE" in
          "*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh"|"*/15 * * * * /bin/bash /boot/config/custom/usenet_health.sh # ouro:usenet-health")
            printf '%s\n' "$BACKUP_CRON_LINE" >>"$BACKUP_CRON_TARGET" || return $?
            ;;
        esac
      done <"$BACKUP_CRON_INPUT"
    }
    create_private_cron_capture() {
      BACKUP_CRON_ROOT=$(mktemp -d /tmp/ouro-backup-cron.XXXXXX) || return $?
      BACKUP_CRON_SOURCE=$BACKUP_CRON_ROOT/stdout
      BACKUP_CRON_ERROR=$BACKUP_CRON_ROOT/stderr
      test -d "$BACKUP_CRON_ROOT" && test ! -L "$BACKUP_CRON_ROOT" || return 1
      test "$(stat -c '%u:%a' "$BACKUP_CRON_ROOT" 2>/dev/null || stat -f '%u:%Lp' "$BACKUP_CRON_ROOT")" = "$(id -u):700" || return 1
      install -m 0600 /dev/null "$BACKUP_CRON_SOURCE" || return $?
      install -m 0600 /dev/null "$BACKUP_CRON_ERROR" || return $?
      test -f "$BACKUP_CRON_SOURCE" && test ! -L "$BACKUP_CRON_SOURCE" || return 1
      test -f "$BACKUP_CRON_ERROR" && test ! -L "$BACKUP_CRON_ERROR" || return 1
      test "$(stat -c '%u:%a' "$BACKUP_CRON_SOURCE" 2>/dev/null || stat -f '%u:%Lp' "$BACKUP_CRON_SOURCE")" = "$(id -u):600" || return 1
      test "$(stat -c '%u:%a' "$BACKUP_CRON_ERROR" 2>/dev/null || stat -f '%u:%Lp' "$BACKUP_CRON_ERROR")" = "$(id -u):600" || return 1
    }
    cleanup_private_cron_capture() {
      rm -f -- "$BACKUP_CRON_SOURCE" "$BACKUP_CRON_ERROR" || return $?
      rmdir -- "$BACKUP_CRON_ROOT"
    }
    snapshot_butler_host_fragments() {
      create_private_cron_capture || return $?
      trap 'cleanup_private_cron_capture' RETURN
      if test -f /boot/config/go && test ! -L /boot/config/go; then
        BACKUP_GO_STATE=present
        BACKUP_GO_DIGEST=$(sha256sum /boot/config/go | awk '{print $1}') || return $?
        snapshot_butler_go_fragments /boot/config/go "$BACKUP_TMP/host/go.butler-lines" || return $?
      elif test -e /boot/config/go || test -L /boot/config/go; then
        return 1
      else
        BACKUP_GO_STATE=absent
        BACKUP_GO_DIGEST=-
        : >"$BACKUP_TMP/host/go.butler-lines" || return $?
      fi
      BACKUP_CRON_USER=$(id -un) || return $?
      if crontab -l >"$BACKUP_CRON_SOURCE" 2>"$BACKUP_CRON_ERROR"; then
        BACKUP_CRON_STATE=present
        BACKUP_CRON_DIGEST=$(sha256sum "$BACKUP_CRON_SOURCE" | awk '{print $1}') || return $?
      else
        BACKUP_CRON_STATUS=$?
        if test "$BACKUP_CRON_STATUS" -eq 1 && grep -Fxq "no crontab for $BACKUP_CRON_USER" "$BACKUP_CRON_ERROR"; then
          BACKUP_CRON_STATE=absent
          BACKUP_CRON_DIGEST=-
          : >"$BACKUP_CRON_SOURCE" || return $?
        else
          return "$BACKUP_CRON_STATUS"
        fi
      fi
      rm -f -- "$BACKUP_CRON_ERROR" || return $?
      snapshot_butler_cron_fragments "$BACKUP_CRON_SOURCE" "$BACKUP_TMP/host/crontab.butler-lines" || return $?
      BACKUP_GO_COUNT=$(awk 'END { print NR + 0 }' "$BACKUP_TMP/host/go.butler-lines") || return $?
      BACKUP_CRON_COUNT=$(awk 'END { print NR + 0 }' "$BACKUP_TMP/host/crontab.butler-lines") || return $?
      printf 'go\t%s\t%s\t%s\ncrontab\t%s\t%s\t%s\n' "$BACKUP_GO_STATE" "$BACKUP_GO_DIGEST" "$BACKUP_GO_COUNT" "$BACKUP_CRON_STATE" "$BACKUP_CRON_DIGEST" "$BACKUP_CRON_COUNT" >"$BACKUP_TMP/host/global-state" || return $?
      chown 0:0 "$BACKUP_TMP/host/go.butler-lines" "$BACKUP_TMP/host/crontab.butler-lines" "$BACKUP_TMP/host/global-state" || return $?
      chmod 0600 "$BACKUP_TMP/host/go.butler-lines" "$BACKUP_TMP/host/crontab.butler-lines" "$BACKUP_TMP/host/global-state" || return $?
      printf 'present\t%s\n' go.butler-lines crontab.butler-lines global-state >>"$BACKUP_TMP/host/inventory" || return $?
      cleanup_private_cron_capture || return $?
      trap - RETURN
    }
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
      && install -d -m 0700 -o 0 -g 0 "$BACKUP_TMP" "$BACKUP_TMP/runtime" "$BACKUP_TMP/agent" "$BACKUP_TMP/host" "$BACKUP_TMP/provenance" \
      && install -d -m 0700 -o 0 -g 0 "$BACKUP_TMP/host/custom" "$BACKUP_TMP/host/custom/ouro-events" \
      && install -m 0600 -o 0 -g 0 /dev/null "$BACKUP_TMP/host/inventory" \
      && backup_host_file /boot/config/custom/usenet_health.sh custom/usenet_health.sh \
      && backup_host_file /boot/config/custom/ouro-events/bootstrap-spool.sh custom/ouro-events/bootstrap-spool.sh \
      && backup_host_file /boot/config/custom/ouro-events/emit-event.mjs custom/ouro-events/emit-event.mjs \
      && backup_host_file /boot/config/custom/ouro-events/emit-usenet-event.sh custom/ouro-events/emit-usenet-event.sh \
      && backup_host_file /boot/config/custom/ouro-events/install-usenet-guard.sh custom/ouro-events/install-usenet-guard.sh \
      && snapshot_butler_host_fragments \
      && test ! -e "$BACKUP_TMP/host/notify.conf" \
      && test ! -e "$BACKUP_TMP/host/sabnzbd.ini" \
      && rsync -a --exclude='/state/acceptance/telegram-control.sock' /mnt/user/appdata/ouro-butler/runtime/.ouro-cli "$BACKUP_TMP/runtime/" \
      && rsync -a --exclude='/state/acceptance/telegram-control.sock' /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro "$BACKUP_TMP/agent/" \
      && test ! -S "$BACKUP_TMP/agent/sanctuary.ouro/state/acceptance/telegram-control.sock" \
      && validate_sanctuary_roots "$BACKUP_TMP/runtime/.ouro-cli" "$BACKUP_TMP/agent/sanctuary.ouro" \
      && docker container inspect ouro-butler >"$BACKUP_TMP/provenance/container-inspect.json" \
      && docker image inspect "$BACKUP_IMAGE_ID" >"$BACKUP_TMP/provenance/image-inspect.json" \
      && docker run --rm --pull=never --network=none --read-only --entrypoint /usr/local/bin/node "$BACKUP_IMAGE_ID" -p 'require("/opt/ouro/package.json").version' >"$BACKUP_TMP/provenance/package-version" \
      && printf '%s\n' "$BACKUP_IMAGE_ID" >"$BACKUP_TMP/provenance/image-id" \
      && chown 0:0 "$BACKUP_TMP/provenance/container-inspect.json" "$BACKUP_TMP/provenance/image-inspect.json" "$BACKUP_TMP/provenance/package-version" "$BACKUP_TMP/provenance/image-id" \
      && chmod 0600 "$BACKUP_TMP/provenance/container-inspect.json" "$BACKUP_TMP/provenance/image-inspect.json" "$BACKUP_TMP/provenance/package-version" "$BACKUP_TMP/provenance/image-id" \
      && (cd "$BACKUP_TMP" && find runtime agent host provenance -xdev -type f ! -path provenance/manifest.sha256 -exec sha256sum -- {} + | LC_ALL=C sort -k2 >provenance/manifest.sha256) \
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
      && assert_only_running_butler - \
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
    RESTORE_VERSION_IMAGE=$(/usr/local/bin/node -e '
      const fs = require("node:fs");
      const [containerPath, versionPath] = process.argv.slice(1);
      const containers = JSON.parse(fs.readFileSync(containerPath, "utf8"));
      const version = fs.readFileSync(versionPath, "utf8").trim();
      const expected = `ghcr.io/ourostack/ouroboros-butler:${version}`;
      if (!Array.isArray(containers) || containers.length !== 1 || containers[0]?.Config?.Image !== expected) process.exit(1);
      process.stdout.write(expected);
    ' "$BACKUP_ROOT/provenance/container-inspect.json" "$BACKUP_ROOT/provenance/package-version")
    test "$(docker image inspect --format '{{.Id}}' "$RESTORE_VERSION_IMAGE")" = "$IMAGE_ID"
    RESTORE_MOUNT_CONTRACT=$(sanctuary_image_mount_contract "$IMAGE_ID")
    audit_registered_dockerman_template "$AUDIT_RUNNER_IMAGE_ID" "$RESTORE_VERSION_IMAGE" "$RESTORE_MOUNT_CONTRACT"
  This data-snapshot Restore is not authority rollback. It must not overwrite a current gateway cursor, reintroduce a revoked resident token or remove a gateway mount behind the root owner. Refuse before mutation if a root epoch/config or deployment journal exists; use the retained Update transaction's authority-retire/authority-restore recovery instead. After a committed authority installation, obtain a reviewed root-aware restore transaction rather than applying this historical data snapshot:
    test ! -e /mnt/user/appdata/ouro-authority/active.json && test ! -L /mnt/user/appdata/ouro-authority/active.json
    test ! -e /boot/config/custom/ouro-butler/docker-man-template-transaction.json && test ! -L /boot/config/custom/ouro-butler/docker-man-template-transaction.json
    test "$RESTORE_MOUNT_CONTRACT" = canonical-pre-gateway
  Before changing autostart, durable roots, or live containers, run the nounset-safe input, backup-root, image, and topology preflight. It requires a nonempty canonical absolute BACKUP_ROOT other than /, both required directories, an exact local sha256 image ID, canonical production as the only running Butler, no staging or rollback, and at most one exact stopped legacy-evidence container. It also audits the live source container with the reviewed runner.
  Restore never rewrites DockerMan registration outside the reviewed template transaction. The preflight therefore stops unless the persistent template already names the exact snapshot version, and the post-start check proves DockerMan and Community Apps still recognize it.
  If the template names another version, first run the same reviewed version-tag update transaction for the snapshot version, then rerun Restore. A mismatch stops before autostart, durable-root, or production-container changes:
    if assert_restore_preflight; then
      :
    else
      RESTORE_PREFLIGHT_STATUS=$?
      (exit "$RESTORE_PREFLIGHT_STATUS")
    fi
  The verified host snapshot is restored only by this explicit Restore path.
  Ordinary update failure continues to use the installer's short-lived
  transaction rollback. Extract the installer from the reviewed runner image,
  then let that fixed allowlist transaction restore exact presence/absence for
  the five guard assets and reapply only the captured Butler-owned go/crontab
  fragments. Unrelated current go/crontab lines are never stored in the durable
  snapshot and remain untouched by restore. The transaction deactivates the
  current owned cron before swapping files and restores the entire pre-restore
  host state if any swap or final crontab activation fails:
    HOST_RESTORE_INSTALLER=$(mktemp /tmp/ouro-usenet-host-restore.XXXXXX)
    docker run --rm --pull=never --network=none --entrypoint /bin/cat "$AUDIT_RUNNER_IMAGE_ID" /opt/ouro/deploy/unraid/ouro-events/install-usenet-guard.sh >"$HOST_RESTORE_INSTALLER"
    chmod 0500 "$HOST_RESTORE_INSTALLER"
  Guard the atomic autostart disable before stopping or removing any Butler
  container. Failure propagates while the existing production remains untouched:
    /bin/bash /boot/config/custom/ouro-events/bootstrap-spool.sh --mount
    test "$(findmnt -n -o FSTYPE --target /boot/config/custom/ouro-events/spool)" = tmpfs
    test "$(stat -c '%u:%g:%a' /boot/config/custom/ouro-events/spool)" = 0:0:755
    RESTORE_INSTALL_PROOF_ROOT=$(mktemp -d /mnt/user/appdata/ouro-butler/staging/restore-install-proof.XXXXXX)
    chmod 0700 "$RESTORE_INSTALL_PROOF_ROOT"
    if disable_butler_autostart; then
      :
    else
      RESTORE_AUTOSTART_DISABLE_STATUS=$?
      rmdir -- "$RESTORE_INSTALL_PROOF_ROOT"
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
      && /bin/bash "$HOST_RESTORE_INSTALLER" --restore-root "$BACKUP_ROOT/host" \
      && rm -f "$HOST_RESTORE_INSTALLER" \
      && docker image inspect "$IMAGE_ID" >/dev/null \
      && create_sanctuary_container "$IMAGE_ID" "$RESTORE_VERSION_IMAGE" "$RESTORE_MOUNT_CONTRACT" \
      && audit_effective ouro-butler "$IMAGE_ID" "$AUDIT_RUNNER_IMAGE_ID" "$RESTORE_MOUNT_CONTRACT" "$RESTORE_VERSION_IMAGE" https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png \
      && assert_only_running_butler - \
      && docker start ouro-butler \
      && assert_only_running_butler ouro-butler \
      && test "$(docker inspect --format '{{.Image}}' ouro-butler)" = "$IMAGE_ID" \
      && wait_butler_ready ouro-butler \
      && verify_dockerman_and_community_apps "$RESTORE_VERSION_IMAGE" "$RESTORE_INSTALL_PROOF_ROOT/install.json" \
      && rm -f -- "$RESTORE_INSTALL_PROOF_ROOT/install.json" \
      && rmdir -- "$RESTORE_INSTALL_PROOF_ROOT" \
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
      ! docker container inspect ouro-butler >/dev/null 2>&1 || exit 1
      rm -f "$HOST_RESTORE_INSTALLER"
      rm -f -- "$RESTORE_INSTALL_PROOF_ROOT/install.json"
      rmdir -- "$RESTORE_INSTALL_PROOF_ROOT"
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
  `provision_sanctuary_sab_credential "$IMAGE_ID"` is the one-shot migration for
  the existing SAB key. Root reads the fixed host INI, writes only a mode-0600
  `ouro.runtimeCredentialBootstrap` envelope owned by 10001:10001, and a
  same-image one-shot container merges `sabnzbdApiKey` into
  `runtime/machines/sanctuary/config`; the key never appears in argv, the
  environment, logs, the Unraid template, or the Butler mounts. The bootstrap
  reconciler is idempotent for the same value and fails closed on a conflict.
  `verify_sanctuary_sab_readiness "$IMAGE_ID"` then reloads that machine item
  from the vault and performs a real bounded queue read before any poller
  cutover. The runtime and agent roots are persistent binds and package-managed
  updates do not replace the machine vault item, so the credential survives
  template and image updates.
  Bootstrap is not the rotation path. After SAB rotates its key, use the
  existing hidden-prompt merge command
  `ouro vault config set --agent sanctuary --key sabnzbdApiKey --scope machine`,
  restart the reviewed Butler container so its machine-config cache refreshes,
  and rerun `verify_sanctuary_sab_readiness "$IMAGE_ID"`; a conflicting
  bootstrap is expected to stop rather than overwrite canonical vault state.
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
  rejects every owned UDP listener and every externally reachable owned TCP listener.
  Only loopback Mailbox port 6876 plus stream-listening endpoints at /tmp/ouroboros-daemon.sock, /tmp/ouroboros-daemon.sock.frontend, and /home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-control.sock are permitted; all other named Unix endpoint types (including datagrams) fail closed.
  Inherited descriptors for the same socket inode are deduplicated, while unknown loopback ports, wildcard/host-address listeners, process/socket/listener drift, or ambiguous ownership fail closed.
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
  Unit 16d-2 stops at the pre-model quarantine boundary: use a genuinely distinct private Telegram sender, confirm the fixed acknowledgement and owner admission card, and do not approve the contact during this scenario. The production-identical allow-to-one-turn continuation is covered by the Telegram admission integration suite when a second live account is unavailable. Unit 16h is acceptance-only: it exercises the delivery path against isolated state, restores exact health and cron bytes, and does not activate a production daily digest.
  The cursor snapshot is deliberately materialized and executed twice around the live scenario. Every telegram-offset proof uses the fresh signed telegram.cursor.snapshot logical progress digest, excluding snapshot time/signature rather than hashing a fixed resident offset file. Stale, absent or frozen resident offsets cannot satisfy cursor evidence. Telegram bootstrap confirms the already pinned root owner through gateway poll/settle; it performs no token acquisition, vault credential write or direct getUpdates. Its one-shot has network=none and a readonly runtime mount. Callback injection alone maps reviewed saved callback-update JSON from host fd 3 through Docker stdin to in-container fd 3.
  Allow the 90-second config materializer budget and the existing 65-second gateway socket wait; do not replace timeout failure with resident token readiness. Unit16b is explicitly retired as a production containment assertion and remains runtime-vault-readiness. Unit16e is the exact four-mount production snapshot with readOnlyRoot=false; mountsExact remains strict.
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
      "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final callback-inject callback-inject.json 3<&3
      )
    }
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize telegram-bootstrap
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final telegram-bootstrap telegram-bootstrap.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize cursor-snapshot before
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final cursor-snapshot cursor-snapshot.json
    # Perform the live scenario whose cursor movement is being measured.
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize cursor-snapshot after
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final cursor-snapshot cursor-snapshot.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize cursor-delta
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final cursor-delta cursor-delta.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize callback-inject
    run_unit16_callback_inject
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize unraid-key-rotate
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final unraid-key-rotate unraid-key-rotate.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize reboot-request
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final reboot-request reboot-request.json
    # The preceding command captures and seals preflight evidence before it asks
    # the broker to stage the reboot, then seals the requested-phase evidence and
    # fsyncs the requested checkpoint before invoking the host reboot. Reconnect
    # only after Unraid and Docker are ready.
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize reboot-resume
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final reboot-resume reboot-resume.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize evidence-snapshot
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final evidence-snapshot evidence-snapshot.json
    # reboot-resume seals the changed boot identity and recovery milestones.
    # evidence-snapshot then runs the remaining scenarios sequentially with a
    # 72-minute aggregate bound; each completed scenario records provenance at
    # capture time and always clears its public gate, private marker, and receipt.
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize evidence-bundle-index
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final evidence-bundle-index evidence-bundle-index.json
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final materialize evidence-bundle-verify
    "$UNIT16_ROOT/sanctuary-unit16-run.sh" "$IMAGE_ID" --profile final evidence-bundle-verify evidence-bundle-verify.json
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
  Telegram bootstrap brackets its one-shot with a host-controlled quiescence guard: it verifies the exact healthy profile-selected resident, assumes recovery responsibility before stopping it with a 30-second grace bound, and proves it is stopped while one live root gateway owns polling. The broker proves the exact root lock/command/start identity and revoked predecessor token epoch; it does not accept a zero-poller file or a resident offset as authority. Every separately launched gateway consumer mounts only /run/ouro-authority readonly. The exit/signal trap restarts the same resident and waits up to 120 seconds for healthy recovery on success or failure without changing Unraid autostart. Every command receives a fresh redacted typed container snapshot, never raw environment or credential values.
  Callback injection requires two stable zero observations from a durable callback playback journal under
  `state/approvals`; the journal is keyed only by the full callback-coordinate
  digest and stores no raw update, callback data, user, chat, message, or query ID.
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
  Inspect AgentBundles/sanctuary.ouro/state/approvals for durable approval and restart-attempt receipts. Confirm with docker inspect that the container has no Docker socket, device, host-root mount, or published port. Confirm `Config.Image` equals the canonical package-version tag and `.Image` equals the exact reviewed local image ID. The read key must reject Docker stop and restart mutations; only the separate write key may perform the one typed approved restart action.
  The packaged `unraid-key-rotate` command is the only canonical key-rotation
  authority. Its host launcher stops the exact production container and assumes
  trap-backed recovery responsibility before key mutation. It inventories the
  two occupied canonical names by exact immutable ID, creates collision-safe
  `Butler RO Rotation <suffix>` and
  `Butler RW Rotation <suffix>` keys, stores and capability-probes both through
  the Sanctuary machine vault, and on the uninterrupted path requires an exact
  four-key inventory. Because
  Unraid 7.2.3 cannot create a role-free key through its CLI, the root broker
  creates each key as provisional `GUEST` with the intended scope plus only
  `API_KEY:UPDATE_ANY`, then immediately uses that in-memory credential to
  self-downgrade the same immutable ID to no roles and the exact intended scope.
  Disk and live-auth proofs must pass before the credential may reach the vault.
  The provisional credential never reaches argv, logs, evidence, the bundle, or
  the model. It then
  revokes both old IDs and proves each old credential receives a 401 or 403.
  Only after an exact inventory contains the temporary pair alone does it create,
  store, and probe the canonical `Butler RO` and `Butler RW` pair. It requires an
  exact four-key temporary-plus-canonical inventory on the uninterrupted path,
  revokes and rejection-probes
  both temporary IDs, and finally requires exactly the canonical pair. Every
  unexpected key, duplicate, malformed permission set, role, name, inventory
  delta, or probe response fails closed. A resumed path may observe fewer keys
  only when the transaction checkpoint plus a durable rejection receipt proves
  that the missing immutable ID was already revoked; it never treats absence
  alone as success.

  A failed invocation resumes from the durable redacted transaction checkpoint
  instead of reminting known keys. The checkpoint binds every created immutable
  ID to its name, scope, vault field, temporary/canonical class, and attestation
  state. Recovery reconciles exact live inventory and rejection proofs, skips
  already-attested vault writes after canonical fields advance, and never
  recreates a temporary key already known revoked. Root-owned recovery ownership
  survives broker response loss and is cleared only after the harness has
  checkpointed the immutable ID and the vault has read back the exact binding.

  Record only IDs, names, and permission sets in evidence; never raw key values.
  Raw credentials must not appear in argv, shell history, stdout, logs, or
  acceptance evidence. They may cross only the ephemeral private Unit 16 Unix
  socket in process memory. The narrow revocation-retry recovery records under
  `/mnt/user/appdata/ouro-butler/acceptance/revoked-key-proof` are the sole file
  exception: they are root-owned mode 0600 beneath a root-owned mode 0700
  directory, excluded from backup/evidence, and readable only by the root broker.
  Recovery state is retained across failed retries.
  Creation intent is fsynced before the CLI side effect so an exact provisional
  key can be adopted after process death. Raw recovery proof is durably deleted
  only after the exact authentication rejection and its redacted replayable
  receipt are fsynced. Never substitute names for IDs when revoking keys.
