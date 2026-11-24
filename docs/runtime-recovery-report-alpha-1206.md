# Runtime recovery report (reported on 0.1.0-alpha.1206)

Branch `arimendelow-runtime-recovery-fixes`. Status: see the PR; a release is claimed only once it is published and verified (this document is written before merge and states no release).

## What was found and changed

1. **Bundle sync, `git: 'remote-https' is not a git command`.** The ms-desk shim at `~/.local/bin/git` execs the first non-shim `git` on PATH, which on the mini is the Copilot app's bundled git (`~/Library/Caches/github-copilot-git-<ver>/bin/git`). That build is relocatable: without the app's `GIT_EXEC_PATH` its exec path is `//libexec/git-core`, so `git-remote-https` is not found. A daemon that inherits the app's PATH but not `GIT_EXEC_PATH` (or one pointing at a deleted versioned cache) fails every fetch and push; the same mechanism explains `~/code/teams-microsoft_tandem`. Reproduced locally with `git ls-remote http://127.0.0.1:1/x.git`. Fix: `src/heart/git-binary.ts` (healthy-git selection and env sanitising), used by `runGit`/`runGitAsync` in `src/heart/sync.ts`. The shim and the app's environment are outside this repo.
2. **Laptop unreachable / week-old presence.** Per the assigner's scope correction, SSH/Tailscale repair is dropped. Peer presence travels only through bundle sync (`presence/<machineId>.json`, every 15 min), so #1 is the cause of the week-old data. Fix: `isStaleSeenAt` (`src/heart/daemon/presence.ts`) and STALE markers in `src/mind/where-am-i.ts` and `src/heart/daemon/presence-roster.ts`.
3. **Stale where-work-runs view.** Same cause and same fix as #2: the view now says it is stale and to verify before routing work.
4. **Teams repeating dead proactive messages.** Hypothesis from code reading (exact cause not reproduced): `presence/outbox` entries and `state/pending` files had no expiry, so anything unsent was replayed whenever Teams became available. Fix: 6 h expiry in `src/senses/teams-outbox.ts` and `drainAndSendPendingTeams` in `src/senses/teams.ts`.

## Verification

Code-regression proof (synthetic fixtures only):
- `src/__tests__/heart/sync-broken-git-on-path.test.ts`: fake broken git first on PATH; raw git fails; two consecutive `fetchRemote` cycles against a local bare remote both succeed.
- `src/__tests__/mind/where-am-i.test.ts`: stale, fresh, stale, fresh across consecutive refreshes. `presence-roster.test.ts` updated.
- `src/__tests__/senses/teams-outbox.test.ts` and `teams-proactive-send.test.ts`: two consecutive drains drop expired entries and deliver fresh ones.
- `npx tsc --noEmit` shows no errors outside `src/a2a/*`, which come from an older symlinked `node_modules` here (the registry mirror lacked `@ouro.bot/friends` alpha.30); eslint clean on changed files.
- `src/__tests__/heart/sync.test.ts` times out on 11 tests on this machine without my change and 7 with it, so that slowness is environmental.

## Unresolved checks (not verified)
- Live recovery on the mini and laptop: not accessible from this session; no real bundle sync, daemon restart or presence refresh was observed.
- The ms-desk shim and the Copilot app's `GIT_EXEC_PATH` handling are outside this repo.
- Fleet skill, `./mac fleet now`, Tailscale and ssh name resolution: out of scope by the coordinator's correction.
- Teams repeat root cause is unproven.
- Full `npm test` / CI coverage run: pending in CI.
