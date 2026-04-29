# Layer 2 — Pre-Up Sync Probe (`preTurnPullAsync` wired into `ouro up`)

Third PR in the four-PR harness-hardening sequence (1 → 4 → 2 → 3).
Builds on the layer-1 rollup vocabulary (PR #644). Independent of layer 4
(drift detection, currently in flight) — does not touch drift code.

## What this PR does

Wires a pre-flight `git pull` over every sync-enabled bundle into the boot path of `ouro up`. Runs **before** per-agent provider live-checks so the post-pull `agent.json` is what the live-check reads. Hard 15-second per-bundle timeout via end-to-end `AbortSignal` so a hung remote can never stall the boot. Surfaces every common git failure as a structured taxonomy variant — operators see the actual problem at boot time, not later via mysterious live-check failures.

This is the first PR in the four-layer sequence that **mutates working trees** (via `git pull`). It does NOT write to `state/` (the gitignored per-machine directory) — verified by a meta-test.

## Sync failure taxonomy (`SyncClassification`)

Locked vocabulary used by `classifySyncFailure(error, context)`. The `advisory` flag is a **hint for layer 3 RepairGuide** (which routes diagnostic skills based on it), NOT a layer-1-rollup downgrade signal — the probe surfaces findings only via the boot stdout summary. See "Rollup interaction" section below.

| classification | trigger | advisory? |
| --- | --- | --- |
| `auth-failed` | 401 / 403 / "Authentication failed" / "Permission denied" | no (blocking) |
| `not-found-404` | 404 / "Repository not found" | no (blocking) |
| `network-down` | `ENOTFOUND` / `ECONNREFUSED` / "Could not resolve host" | no (blocking) |
| `dirty-working-tree` | "would be overwritten by merge" / "stash them" | yes |
| `non-fast-forward` | "non-fast-forward" / "fetch first" / "rejected" | yes |
| `merge-conflict` | "CONFLICT" stderr (with file list via `git status`) | yes |
| `timeout-soft` | soft timeout fired but op completed within hard window | yes |
| `timeout-hard` | hard timeout aborted the op via `AbortSignal` | no (blocking) |
| `unknown` | fallthrough | yes |

The pattern priority (most actionable wins) is documented in `sync-classification.ts`. Existing legacy variants (`push_rejected`, `pull_rebase_conflict`) remain in the `PendingSyncRecord.classification` union — additive widening, no breaking change.

## Rollup interaction (intentionally none)

This PR is a **boot-time preflight surface only.** Findings flow into the boot stdout summary written by `cli-exec.ts` after the probe phase; they are NOT persisted to daemon health and do NOT downgrade `computeDaemonRollup`'s output. Layer 3 RepairGuide is the planned consumer (it reads the in-memory `BootSyncProbeFinding[]` at boot time and dispatches the right diagnostic skill, e.g. `diagnose-broken-remote.md` for `not-found-404`, `diagnose-sync-blocked.md` for `dirty-working-tree`). Wiring sync findings into the running daemon's rollup is a future concern that would mirror layer 4's `DaemonHealthState.drift` pattern.

## End-to-end AbortSignal

`runWithTimeouts` wraps every git op in a `(signal: AbortSignal) => Promise<T>` callback. The signal threads through to `child_process.execFile(..., { signal })` so the kernel actually sends `SIGTERM` to the git child when the hard timeout fires. Soft timeout (8s) emits a warning but lets the op complete; hard timeout (15s) aborts. Three env knobs override the defaults:

- `OURO_BOOT_TIMEOUT_GIT_SOFT` (default 8000ms)
- `OURO_BOOT_TIMEOUT_GIT_HARD` (default 15000ms)

## New files

| Path | Purpose |
| --- | --- |
| `src/heart/sync-classification.ts` | Pure pattern-matcher: `classifySyncFailure(error, context) -> SyncClassificationResult` |
| `src/heart/timeouts.ts` | `runWithTimeouts<T>` soft/hard wrapper over `AbortController` + `setTimeout` |
| `src/heart/daemon/boot-sync-probe.ts` | `runBootSyncProbe(bundles, options) -> BootSyncProbeResult` orchestrator |
| `src/__tests__/heart/sync-classification.test.ts` | 27 tests, 100% coverage |
| `src/__tests__/heart/timeouts.test.ts` | 13 tests, 100% coverage |
| `src/__tests__/heart/sync-pre-turn-pull-signal.test.ts` | 11 tests for the new async sibling |
| `src/__tests__/heart/daemon/boot-sync-probe.test.ts` | 15 orchestrator tests |
| `src/__tests__/heart/daemon/boot-sync-probe-slow-remote.test.ts` | 2 hard-timeout safety tests |
| `src/__tests__/heart/daemon/boot-sync-probe-no-state-writes.test.ts` | 6 meta-tests enforcing no-state-write invariant (Unit 7) |
| `src/__tests__/heart/daemon/sync-probe-rendering.test.ts` | 10 tests for the boot summary helpers |

## Touched files

| Path | Change |
| --- | --- |
| `src/heart/sync.ts` | Added `preTurnPullAsync` async/signal-aware sibling; widened `PendingSyncRecord.classification` union to `SyncClassification`. Sync `preTurnPull` unchanged (per-turn pipeline still uses it). |
| `src/heart/daemon/cli-exec.ts` | New "sync probe" boot phase between manual-clone-detection and provider checks. Helper `writeSyncProbeSummary` + `summarizeSyncProbeFindings` exported for direct test. |
| `src/heart/daemon/cli-types.ts` | New `runBootSyncProbeImpl?` injection on `OuroCliDeps` for tests. |
| `src/nerves/coverage/file-completeness.ts` | Added `sync-classification.ts` and `timeouts.ts` to the dispatch-exempt list as pure utility modules. |
| `src/__tests__/heart/daemon/daemon-cli-up-progress.test.ts` | Stubs `runBootSyncProbeImpl` so existing boot tests don't trigger real git ops on the developer's home bundles. |

## Coverage / gates

- All unit tests pass: 9903 tests (518 files).
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm run test:coverage`: PASS — code coverage 100% on every gated file (cli-exec.ts coverage went from 99.33% to 100% with the new exported helpers).
- Nerves audit: PASS — all four new events (`daemon.boot_sync_probe_start/end/failed`, `heart.sync_pull_aborted`) observed by the global test capture. `sync-classification.ts` and `timeouts.ts` added to dispatch-exempt list per the rationale in the diff.
- No-state-write meta-test: PASS — the three new files contain zero filesystem write APIs and zero `state/` path literals (Unit 7).

## What's next

- **Layer 3** (RepairGuide bundle) is the consumer of these findings. It will read the `BootSyncProbeFinding[]` and dispatch the appropriate skill (e.g. `diagnose-broken-remote.md` for `not-found-404`, `diagnose-sync-blocked.md` for `dirty-working-tree`).
- The probe currently surfaces findings only via the boot-time stdout summary. Persisting them for the running daemon to consume is a layer-3-or-later concern.

## Risk profile

- **First PR that mutates working trees.** Mitigation: only `git pull`, not `git checkout` / `git reset`. Bundles that aren't git repos (`gitInitialized: false`) are skipped with an advisory finding. Bundles with `sync.enabled: false` are skipped entirely.
- **Boot path regression risk.** Mitigation: the entire probe is wrapped in `try/catch` that emits a warning event and continues — a probe-internal error never blocks the boot.
- **Hung remote risk.** Mitigation: `AbortSignal` propagation through `child_process.execFile` plus a 15s per-bundle hard cap. Verified by `boot-sync-probe-slow-remote.test.ts`.
