# Layer 1 — daemon rollup vocabulary fix (`healthy / partial / degraded / safe-mode / down`)

## What

First in the four-PR harness-hardening sequence (1 → 4 → 2 → 3). Replaces the daemon-wide rollup at `daemon-entry.ts` (the `degraded.length > 0 ? "degraded" : "ok"` literal that promoted any non-empty `degradedComponents[]` to a daemon-scope `degraded` status) with a five-state vocabulary:

| State | Owner | When it fires |
| --- | --- | --- |
| `healthy` | rollup fn | Every enabled agent serving, no bootstrap-degraded entries, no safe-mode. |
| `partial` | rollup fn | At least one enabled agent serving AND (≥1 enabled agent unhealthy OR ≥1 bootstrap-degraded). Today's incorrect "degraded". |
| `degraded` | rollup fn | Zero enabled agents serving — covers BOTH "no enabled agents configured" (fresh install) AND "all enabled agents failed live-check." Same status, distinct UX copy at render time. |
| `safe-mode` | rollup fn | Crash-loop tripped (3 in 5min). Overrides everything else. |
| `down` | caller (daemon-entry pre-inventory failure path) | Daemon process can't start / can't read inventory. NOT returned by `computeDaemonRollup` — by the time the rollup function is reachable the daemon is post-inventory. |

After this PR, `degraded` means "zero enabled agents serving" — not "any one agent is unhealthy." The slugger-symptom (one sick agent tipping the whole harness to `degraded`) is fixed at the rollup layer.

## Type structure

- `RollupStatus = "healthy" | "partial" | "degraded" | "safe-mode"` — what `computeDaemonRollup` returns.
- `DaemonStatus = RollupStatus | "down"` — what `DaemonHealthState.status` accepts. Caller assigns `"down"` outside the rollup function.

Both unions are projected from a single source-of-truth literal tuple (`ROLLUP_STATUS_LITERALS as const` in `daemon-health.ts`), so the type, the runtime guard `Set`s, and the `isRollupStatus` / `isDaemonStatus` guards stay in lockstep automatically — adding a future literal touches one site only.

## Render-layer copy split for `degraded`

The status enum stays a single `degraded` literal. The render layer (`renderRollupStatusLine` in `cli-render.ts`) inspects the cached `health.agents` map to pick a UX copy variant:

- Empty map → `"degraded — no agents configured (run \`ouro hatch\` to add one)"` (fresh install).
- Non-empty map + any agent reports `"running"` → `"degraded — stale cache, run \`ouro up\` to refresh"`. This handles cached health files written by pre-Layer-1 daemons, where `status: "degraded"` carried the old "any sick component" semantics and could coexist with a healthy agent. Under post-Layer-1 semantics that combination is impossible — so a cached running agent + degraded status implies the cache pre-dates this PR. The render layer prompts for `ouro up` rather than falsely asserting "none ready."
- Non-empty map + zero agents reporting `"running"` → `"degraded — agents configured but none ready (run \`ouro doctor\`)"` (all-failed live-check).

Same status, three distinct copy variants. Avoids inflating the type union just to express copy-variant nuance, and does not propagate stale-cache misinformation.

## Compiler-forced exhaustiveness

Every render-side switch on `DaemonStatus` MUST end in a `never`-typed default branch. There's exactly one such consumer today (`renderRollupStatusLine`); future consumers must follow the same pattern. A future PR adding a state to the literal tuple will compile-error at every consumer that uses a `never`-default.

The add-a-hypothetical-state experiment was performed during Unit 5 (added `"experimental"`, ran `tsc`, recorded which sites errored, reverted). Documented in the artifacts directory's `status-callsites.md`. The experiment confirmed exactly one site errors today — `renderRollupStatusLine`'s default — proving the contract holds.

## Out of scope

Per the four-PR breakdown, this PR is intentionally rollup-only:

- The per-agent live-check loop in `cli-exec.ts` is **not** redesigned. The loop is already try/catch-isolated; the bug is in how its output rolls up. This PR fixes the rollup; the loop stays.
- `recordRecoverableBootstrapFailure` is **not** modified. It still records bootstrap failures into `degradedComponents[]`; only the rollup interpretation of that array changes.
- `inner-status.ts` and `startup-tui.ts` were named in the planning doc as consumers of the daemon-wide rollup, but during the Unit 0 mapping survey (`status-callsites.md` in artifacts) they turned out to render per-agent inner-runtime / worker statuses respectively — different concept from the daemon-wide rollup. The real consumers are `cli-render.ts:daemonUnavailableStatusOutput` and `runtime-readers.ts:readDaemonHealthDeep`. Layer 4 of the harness-hardening sequence builds on the new vocabulary; layers 2 and 3 follow from there.

## How to review

Suggested order:

1. **`src/heart/daemon/daemon-health.ts`** — the type definitions and runtime guards. The literal-tuple projection is the contract everything else hangs off of.
2. **`src/heart/daemon/daemon-rollup.ts`** — pure decision function with the four-state truth table. Read alongside `src/__tests__/heart/daemon/daemon-rollup.test.ts`, which encodes each row + the input-contract / determinism / non-mutation / never-returns-down invariants.
3. **`src/heart/daemon/daemon-entry.ts`** — the call site replaces the old binary literal with `computeDaemonRollup`. The integration tests in `daemon-entry-rollup.test.ts` cover the full state table at the daemon-entry layer (booted in-process, no subprocess).
4. **`src/heart/daemon/cli-render.ts:renderRollupStatusLine`** — the never-typed-default render switch and the `degraded` two-copy split. Tests in `cli-render-rollup-vocabulary.test.ts`.
5. **`src/heart/outlook/readers/runtime-readers.ts`** — the parse-side tightening. Stale legacy status strings (`"running"`, `"ok"`) defensively fall back to `"unknown"` so the Outlook surface gets a typed `DaemonStatus | "unknown"` view.
6. **`docs/doing/2026-04-28-1930-doing-layer-1-rollup-vocabulary/status-callsites.md`** — the Unit 0 survey + Unit 5 experiment record. Useful for understanding why the planning-doc-named consumers were retargeted.

The doing doc itself (`docs/doing/2026-04-28-1930-doing-layer-1-rollup-vocabulary.md`) is the authoritative TDD trace if you want to see which tests were written before which implementation.

## Test plan

_Pipeline-enforced coverage (unit tests, build, lint, coverage gate, nerves audit) is signaled by required-pipeline green. Items below are human-validation only._

- [ ] `ouro status` against a daemon-down state shows the new `Last known status: ...` rendering — verify the `degraded` two-copy split by deleting all `*.ouro` bundles (fresh-install copy) vs. having one bundle with a crashed agent (all-failed copy).
- [ ] After this PR lands, layer 4 (PR 2) branches from refreshed `main`. Layers 2 and 3 follow.

## Next

Layer 4 builds on this PR's vocabulary. The doing doc breaks the four-PR sequence at `docs/planning/2026-04-28-1900-planning-harness-hardening-and-repairguide.md`.
