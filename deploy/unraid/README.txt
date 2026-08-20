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

Update:
  Build and verify a new ouro-butler:<version> image first. The tag is only a
  lookup handle and never authorizes container creation. Resolve and validate
  the exact local Docker image ID before staging:
    IMAGE_TAG=ouro-butler:<version>
    IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
    printf '%s\n' "$IMAGE_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'
    docker image inspect "$IMAGE_ID" >/dev/null
  Replace sha256:REPLACE_WITH_EXACT_LOCAL_IMAGE_ID in a copy of sanctuary.xml
  with exactly $IMAGE_ID. Run audit-container-spec.sh against that staged template,
  container-runtime.json, and $IMAGE_ID before docker create. Create
  ouro-butler-staging from "$IMAGE_ID", with autostart disabled and the same
  two binds. After its health and Telegram checks pass, stop production,
  retain it as the stopped ouro-butler-rollback container, recreate
  ouro-butler from the same exact local image ID, and enable only ouro-butler
  among Butler containers for Unraid array autostart. Never run two active
  butlers against the same Telegram token. Never create a container from the
  mutable lookup tag.

Backup:
  Stop ouro-butler, then snapshot both of these directories together:
    /mnt/user/appdata/ouro-butler/runtime/.ouro-cli
    /mnt/user/appdata/ouro-butler/agent/sanctuary.ouro
  A routine backup must not contain container-credentials.json or
  container-credentials.json.consuming. If either exists, credential migration
  is pending or failed and must be reconciled before taking the backup.

Restore:
  Stop and remove the current container, restore both directories with numeric
  ownership 10001:10001, verify the pinned exact local image ID still resolves
  with docker image inspect, recreate from that image ID and its staged
  template, then verify health before enabling array autostart.

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
  claimed envelope exist, stop: their relationship is ambiguous and startup
  intentionally refuses to choose one.
  Do not rename, copy, delete, or recreate either envelope during reconciliation.
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
