# Status callsites map — Layer 1 rollup vocabulary

Map of every read/write of `DaemonHealthState.status` and the bootstrap-degraded rollup. Built before any code change so Unit 5's compiler-forced exhaustiveness sweep is grounded in a concrete inventory.

## Conventions

- **Producer** — writes to `DaemonHealthState.status` or computes the rollup.
- **Consumer (read)** — reads `DaemonHealthState.status` and renders, branches, or forwards it.
- **Type carrier** — declares the field's type but does not branch on it.
- **Test fixture** — synthesizes a `DaemonHealthState` in tests.

## Production code

### Producers (must use `RollupStatus` / `DaemonStatus`)

| File:line | What it does | New-vocabulary value |
| --- | --- | --- |
| `src/heart/daemon/daemon-entry.ts:164` | `status: degraded.length > 0 ? "degraded" : "ok"` — the entire reason this PR exists. Replaces with `computeDaemonRollup(...)` returning `RollupStatus`. | Returns `RollupStatus` from `computeDaemonRollup`. The `down` literal is set elsewhere in the daemon-entry pre-inventory failure path (caller-owned, not by this rollup). |

### Type carriers (declarations — change `string` → `DaemonStatus`)

| File:line | What it does | New-vocabulary value |
| --- | --- | --- |
| `src/heart/daemon/daemon-health.ts:32` | `interface DaemonHealthState { status: string ... }` declaration. | `status: DaemonStatus` — the typed union. |
| `src/heart/daemon/daemon-health.ts:14` | `interface AgentHealth { status: string ... }` — **NOT this rollup**. This is per-agent worker status (`running`/`crashed`/etc). Out of scope; left as `string`. | unchanged. |
| `src/heart/daemon/daemon-health.ts:126` | `readHealth()` parser: `typeof parsed.status !== "string"` validation. | Tighten to `isDaemonStatus(parsed.status)` so junk status values from a corrupted health file are rejected (not silently coerced). |
| `src/heart/daemon/daemon-health.ts:141` | `readHealth()` parser: `status: parsed.status` assignment to the parsed object. | After the `isDaemonStatus` guard above, this assigns a typed `DaemonStatus`. |

### Read consumers (rendering / forwarding)

| File:line | What it does | Render outcome |
| --- | --- | --- |
| `src/heart/daemon/cli-render.ts:566` | `daemonUnavailableStatusOutput`: `lines.push(\`Last known status: ${health.status} ...\`)` — fallback display when the daemon is down. **Real human-facing consumer of the rollup string.** | Switch on `DaemonStatus` to map each rollup state to a label + colored dot. `degraded` gets the two-sub-case copy split per the doing doc (zero-enabled vs all-unhealthy). Default case `never`-typed. |
| `src/heart/mailbox/readers/runtime-readers.ts:281` | `readDaemonHealthDeep`: defensive read of `health.status` from the JSON file, falls through to `"unknown"` on parse failure. **Mailbox surface consumer.** | Tighten parse: use `isDaemonStatus` to validate. The `"unknown"` fallback stays for genuinely unparseable files; the type for the DTO field becomes `DaemonStatus | "unknown"` so the mailbox side carries the new vocabulary forward. |
| `src/heart/daemon/daemon-health.ts:63` | `DaemonHealthWriter.writeHealth` emits `meta: { ..., status: state.status }` to the nerves event log. | No render branch — passes the typed `DaemonStatus` straight through. No code change needed beyond the type tightening at line 32. |

### Type-only forwarders (no branch on status)

| File:line | What it does | Action |
| --- | --- | --- |
| `src/heart/turn-context.ts:18,98,394` | `import type { DaemonHealthState }` — forwards the type into the turn context. | None — `DaemonHealthState` is the same name; downstream typecheck propagates. |
| `src/heart/core.ts:311` | `daemonHealth?: import("...").DaemonHealthState \| null` field on the resolved context. | None. |
| `src/heart/daemon/cli-types.ts:166` | `readHealthState?: (healthPath: string) => DaemonHealthState \| null` — DI seam. | None. |
| `src/mind/prompt.ts:1349` | `rhythmStatusSection(preReadHealth?: ... DaemonHealthState ...)`. Reads `health.degraded` and `health.habits`, **NOT `health.status`**. | None — does not branch on status. Out of scope. |
| `src/mind/prompt.ts:755` | `daemonHealth?: ... DaemonHealthState` field on `BuildSystemOptions`. Forwarded to `rhythmStatusSection`. | None. |
| `src/nerves/observation.ts:15` | Re-exports `DaemonHealthState`, `DegradedComponent`, etc. for mailbox readers. | None. |
| `src/senses/pipeline.ts:688` | Forwards `daemonHealth: ctx.daemonHealth` into a sense pipeline frame. | None. |

## Bootstrap-degraded inputs (not the same as rollup status)

These write into `degradedComponents[]` — they're inputs the rollup function reads. Out of scope for this PR (the planning doc says "DO NOT MODIFY recordRecoverableBootstrapFailure"):

| File:line | What it does |
| --- | --- |
| `src/heart/daemon/daemon-entry.ts:141` | `const degradedComponents: DegradedComponent[] = []` — the bootstrap-degraded array. |
| `src/heart/daemon/daemon-entry.ts:183-217` | `recordRecoverableBootstrapFailure` writes into `degradedComponents[]`. Behavior preserved; only the rollup's interpretation changes. |
| `src/heart/daemon/daemon-entry.ts:285,296` | Two callers of `recordRecoverableBootstrapFailure` (habit-scheduler bootstrap failure paths). |

## Out-of-scope but appearing in greps

These are unrelated `.status` fields that share a name but aren't the daemon rollup. Listed here so Unit 5's grep doesn't accuse them:

| File:line | Field | Why it's not the rollup |
| --- | --- | --- |
| `src/heart/daemon/process-manager.ts:19` | `DaemonAgentSnapshot.status: "starting" \| "running" \| "stopped" \| "crashed"` | Per-agent worker status. Already a tight union, separate semantic. |
| `src/heart/daemon/daemon.ts:264` | `status: "ok" \| "warn" \| "critical"` (HealthCheckResult) | Per-check health result, not daemon-wide rollup. |
| `src/heart/daemon/daemon.ts:398` | `DaemonStatusOverview.health: "ok" \| "warn"` | Per-status-command live overview field, written from `workers.every(running)` — not the rollup. |
| `src/heart/daemon/inner-status.ts:67-68` | `runtimeState.status` rendering | Inner-dialog agent runtime state (e.g. "idle"/"running"/"heartbeat"). Different concept. |
| `src/heart/daemon/startup-tui.ts:84-104` | `worker.status` branching on `"running"`/`"crashed"` | Per-agent worker status during startup poll. Different concept. |
| `src/heart/daemon/cli-render.ts:269-291` | `statusDot(status: string)` switch on `"running"`/`"ok"`/`"crashed"`/etc | Generic status-dot helper used for many tables (workers, senses, providers, sync). Tolerates many string values; not solely the rollup. **Will be reused** to color the rollup status in the new render switch but does not need its own union narrowing. |
| `src/heart/daemon/readiness-repair.ts:12` | `RepairSeverity = "blocked" \| "degraded" \| "advisory"` | Repair-step severity. Not the rollup. |

## Test fixtures (must update to new vocabulary)

These tests synthesize `DaemonHealthState` and currently pass `status: "running"` / `status: "ok"` / similar. After tightening `DaemonHealthState.status` to `DaemonStatus`, they MUST switch to the new values or break the build:

| File:line | What it does |
| --- | --- |
| `src/__tests__/heart/daemon/daemon-health.test.ts:38` | `makeHealthState()` factory: `status: "running"`. Must become `"healthy"` (default), with explicit overrides per-test. |
| `src/__tests__/heart/daemon/daemon-health.test.ts:108,113` | `status: "running"` / `status: "stopping"` overrides — both invalid. Replace with `"healthy"` / `"down"`. |
| `src/__tests__/heart/daemon/daemon-status-health.test.ts:85` | `status: "safe-mode"` — already in new vocabulary. No change. |
| `src/__tests__/heart/daemon/daemon-status-health.test.ts:107,142` | `status: "running"` — replace with `"healthy"`. |
| `src/__tests__/heart/daemon/daemon-entry-health-state.test.ts:226` | Asserts `status: "ok"` (the literal that's being replaced). Update to `"healthy"`. |
| `src/__tests__/heart/daemon/daemon-entry-health-state.test.ts:257,311` | Asserts `status: "degraded"` for two scenarios: bootstrap failure (`partial` per new rules — agents are healthy, only bootstrap is degraded) and crashed-agent-with-no-others (`degraded` per new rules — zero serving). Will need scenario-specific updates aligned with the new rollup table. |

## Add-a-hypothetical-state experiment plan (Unit 5)

After Units 1–4 land, add a 6th literal (`"experimental"`) to `RollupStatus` temporarily. Verify `tsc --noEmit` errors at every consumer that switches on it:

- Expected error sites: `cli-render.ts` rollup switch (Unit 4b), the rollup function itself (`daemon-rollup.ts`), `runtime-readers.ts` parse guard (if it switches), and the Unit 1 type-guard implementation (`isRollupStatus` will need the new literal too — that's the proof the guard is exhaustive).
- Then revert the experimental literal. Record results in this file's "Experiment results" section before merging.

## Experiment results

Performed during Unit 5 (2026-04-28 15:25 PT). Steps:

1. Edited `src/heart/daemon/daemon-health.ts` to add `"experimental"` to the source-of-truth `ROLLUP_STATUS_LITERALS` tuple (which derives `RollupStatus` and `DaemonStatus` via `typeof`-indexing). This automatically widens both the type unions and the runtime guard sets in lockstep — the literal tuple is the single source of truth, so consumers can't drift from the guard.

2. Ran `npx tsc --noEmit`. Output:

   ```
   src/heart/daemon/cli-render.ts(567,13): error TS2322: Type '"experimental"' is not assignable to type 'never'.
   ```

   Exactly one consumer compile-errors — `renderRollupStatusLine`'s `never`-typed default branch in `cli-render.ts`. That's the goal: every render-side switch on `DaemonStatus` is forced to handle the new literal explicitly.

3. The rollup function (`computeDaemonRollup` in `daemon-rollup.ts`) does not compile-error because it returns `RollupStatus` via an if-chain — widening the union doesn't constrain which subset of literals the function emits. That's correct behavior: the producer chooses which states to emit; widening the union is by design a non-blocking change for the producer. Behavior is exercised at runtime via the truth-table tests.

4. The type-guard tests in `daemon-health-status.test.ts` did NOT fail — `isRollupStatus("experimental")` now returns `true` (set membership), the guard is automatically in sync because both the type and the set derive from the same literal tuple. This is the desired outcome of the literal-tuple refactor (Unit 5 hardening).

5. Reverted the experimental literal. Final state: `ROLLUP_STATUS_LITERALS = ["healthy", "partial", "degraded", "safe-mode"] as const`. tsc clean; type-guard tests green.

**Conclusion**: Layer 1's compiler-forced exhaustiveness contract holds. A future PR adding a new rollup state to the literal tuple WILL compile-error at every render-side `switch (status)` consumer that uses a `never`-typed default — there's currently exactly one such consumer (`renderRollupStatusLine`). Future PRs adding more consumers (e.g. inner-status / startup-tui / mailbox UI) MUST follow the same `never`-default pattern; this is now the documented Layer 1 invariant.
