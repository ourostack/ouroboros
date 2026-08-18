Sanctuary Ouro Butler operator runbook

The production container is ouro-butler. It runs as UID/GID 10001, publishes no
ports, mounts only the runtime and sanctuary.ouro bundle paths from the Unraid
template, and uses restart policy unless-stopped.

Start/stop:
  docker start ouro-butler
  docker stop ouro-butler

Status and health:
  docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' ouro-butler
  docker logs --tail 200 ouro-butler

Update:
  Build and verify a new immutable ouro-butler:<version> image first. Create
  ouro-butler-staging with autostart disabled and the same two binds. After its
  health and Telegram checks pass, stop production, retain it as the stopped
  ouro-butler-rollback image reference, recreate ouro-butler from the verified
  digest, and enable only ouro-butler for Unraid array autostart. Never run two
  active butlers against the same Telegram token.

Backup:
  Stop ouro-butler, then snapshot both of these directories together:
    /mnt/user/appdata/ouro-butler/runtime
    /mnt/user/appdata/ouro-butler/AgentBundles/sanctuary.ouro
  Preserve mode 0600 on runtime/container-credentials.json.

Restore:
  Stop and remove the current container, restore both directories with numeric
  ownership 10001:10001, recreate from the pinned image digest and template,
  then verify health before enabling array autostart.

Credential recovery:
  Replace runtime/container-credentials.json atomically as root, set ownership
  10001:10001 and mode 0600, then restart the container. Never print or place
  credential values in logs, templates, command arguments, or this runbook.

Audit and safety verification:
  Inspect AgentBundles/sanctuary.ouro/state/approvals for durable approval and
  restart-attempt receipts. Confirm no Docker socket/device/host-root mounts and
  no published ports with docker inspect. The read key must reject Docker stop
  and restart mutations; only the separate write key may perform the one typed
  approved restart action.
