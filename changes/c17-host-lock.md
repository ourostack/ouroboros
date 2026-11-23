Eval runs and Butler upgrades no longer run on the same host at once: they share a host lock.

- **The lock.** `deploy/unraid/ouro-host-lock.mjs` takes `/var/lock/ouro-host.d` with `mkdir`, and writes `owner.json` inside it naming the holder, token, pid, host and expiry.
  - A lock is stale when its expiry has passed, when its process on this host is gone, or when it has had no readable owner for a minute. The next taker breaks a stale lock.
  - Taking, breaking and releasing all happen inside a short guard, so a breaker never removes a lock that someone took after it judged the old one stale.
- **The eval.** `npm run eval -- ... --sandbox-ssh <host>:<folder> --host-lock <holder>` holds that host's lock over one ssh session for the whole command, and frees it at the end. A dropped session frees it too.
  - The eval waits up to 30 minutes for a Butler ship that holds the lock.
  - Each job carries the lock's token. On the Butler's host the sandbox runs only while that token holds a live lock.
- **butler:ship.** It takes the lock before it changes anything on the host. While an eval holds it, ship waits up to 30 minutes, then stops and says nothing was changed.
  - Ship passes the lock's token to the upgrade, and frees the lock at the end.
  - If the baseline or the upgrade may still be running, ship leaves the lock to expire 4 hours after it was taken.
- **The upgrade.** The upgrade and each of its rollbacks wait while anyone else holds the lock, and never run past it.
  - The wait is `OURO_HOST_LOCK_WAIT_S`, 30 minutes by default.
  - A rollback that could not run says how to run it once the lock is free.
