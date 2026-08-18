---
title: Sanctuary deterministic health sweep
cadence: 15m
status: active
created: 2026-08-18
tools: [unraid_list_containers, unraid_array_health, unraid_disk_health, unraid_parity_status, unraid_notifications]
---

Run the Sanctuary health sweep. Check the Unraid array, disks, parity, notifications, and every autostart container. Report only a new incident, a recovery, or the daily unresolved digest; otherwise remain silent. Do not mutate server state.
