Eval runs and Butler upgrades no longer run on the same host at once: they share a host lock.

- **The lock.** `deploy/unraid/ouro-host-lock.mjs` takes `/var/lock/ouro-host.d` with `mkdir`, and writes `owner.json` inside it naming the holder, token, pid, host and expiry.
  - A lock is stale when its expiry has passed, when its process on this host is gone, or when it has had no readable owner for a minute. The next taker breaks a stale lock.
  - Taking, breaking and releasing all happen inside a short guard, so a breaker never removes a lock that someone took after it judged the old one stale.
- **The eval.** `npm run eval -- ... --sandbox-ssh <host>:<folder> --host-lock <holder>` holds that host's lock over one ssh session (the holder is one word, such as `eval:c17-replay`) for the whole command, and frees it at the end. A dropped session frees it too.
  - The eval waits up to 30 minutes for a Butler ship that holds the lock.
  - Each job carries the lock's token. On the Butler's host the sandbox runs only while that token holds a live lock.
- **butler:ship.** It takes the lock before it changes anything on the host. While someone else holds it, ship waits up to 30 minutes, then stops and says nothing was changed.
  - Ship passes the lock's token to the upgrade, and frees the lock at the end.
- **The upgrade.** It takes the ship's lock over with its own pid and a fresh 4-hour expiry, so the lock lasts exactly as long as the upgrade does. When it exits it hands the lock back to the ship.
  - Run by hand without a token, it takes a lock of its own and frees it when it exits.
  - It waits while anyone else holds the lock, for up to `OURO_HOST_LOCK_WAIT_S` (30 minutes by default), and never starts past it.
  - Each rollback checks the lock again. A rollback the lock kept from running prints `ROLLBACK FAILED`, so ship reports the upgrade as failed. As with any failed rollback, the keeper retries it about 30 minutes later.
