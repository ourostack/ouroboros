# Scheduled Shepherd Check-ins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconsider every returned coding session on a configurable low-noise
cadence and safely continue only unfinished, already-authorized work.

**Architecture:** Add a periodic variant to the existing sense's serial
`handle` chain, using fresh conservative host inspections and the existing
judge/guards. One private SQLite database owns cross-trigger dispatch custody
and periodic-notice suppression. Normal return events remain immediate.

**Tech Stack:** TypeScript, existing Node process/socket APIs, better-sqlite3,
Vitest fake clocks, existing cmux/Herdr adapters. No new dependencies.

**Spec:** `docs/shepherd-checkins-design.md`; independent design gate approved
`e8d80be2fb310d21ef11fdc7f70ec26cc61bfcaa`.

## Global Constraints

- Product default `60` minutes; `0` disables; integers `30` through `1440` valid.
  No environment variable, extra process or independent model runtime.
- Timers are fallback, never pacing. No catch-up burst or overlapping sweep.
  A scheduled badge alone is not active background work.
- Every prior return classification is inspected; old history is not authority.
- Only verified idle, empty-composer, unchanged-current-instance candidates can
  receive periodic plain text. Unknown UI/identity/state refuses.
- True human decisions/auth/approvals, scopes, pauses, focus/recent focus, drafts,
  active work and existing streak `3`/hourly `10` guards remain authoritative.
- All automatic dispatches share one chain and durable reservation helper.
  Transition and trigger are metadata, not dispatch-key components.
- Claimed/unknown transport blocks automatic replay, including other triggers
  and changed fingerprints. No transaction spans model or host I/O.
- Private state directories `0700`, files `0600`; reject ownership/type/symlink/
  corruption/capacity faults before accepting a claim.
- No unchanged-blocker Teams/status/wake spam. One custody database also owns
  persisted classification suppression; the existing outbox owns delivery.
- No real terminal/Teams/learning/paid-provider fixtures, focus changes, draft
  clearing, permission keys for periodic work, developer-runtime switch or
  blocked fleet-reopen/ownership changes.
- Private real-fleet observations may inform synthetic shapes, not be copied.

## Review Focus

1. A fallback timer badge beside an empty prompt is not a running job; real
   background/active indicators still suppress input (Task 2 and Task 4).
2. A restarted process reusing a PID/TTY/surface must not inherit an old target
   or escape an unresolved legacy uncertainty barrier (Task 2 and Task 3).
3. Immediate, network and periodic transitions with different IDs but identical
   input must collide; changed input cannot evade unknown custody (Task 3/4).
4. Human focus/draft/guidance changes during final target resolution or awaited
   reads must refuse without even initiating a paste (Task 2 and Task 4).
5. Startup discovery must check old gate/done/error/working sessions without
   inventing a task, repeatedly notifying or disturbing an unsupported UI
   (Task 4 and Task 5).

## File Map and Execution

Parent owns contracts/config, custody, integration, docs and delivery. Native
execution is selected under the standing delegated-review authority. After
Task 1, one bounded host-adapter implementation may run in a separate worktree
in parallel with parent Task 3; it owns only the Task 2 files. No other coding
delegation or nested agents. Parent integrates its tested commit before Task 4.
An independent whole-source/code/scope/debt gate precedes release.

- `checkin-config.ts`: pure interval validation and partial read-only config
  access, avoiding provider initialization merely to read a sense setting.
- `host.ts`: optional inspection/guarded-prompt contracts; `terminal-process.ts`,
  `cmux.ts`, `herdr.ts`, `prompt-state.ts`: actual fresh host evidence.
- `checkin-store.ts`: dispatch reservations/barriers and classification
  suppression in one SQLite database, no scheduler/model/socket ownership.
- `sense.ts`: existing chain, timers, fresh observations, dispatch and notice
  integration; `judge.ts`: periodic packet/rubric, not another judge.
- Mirrored test files, one hermetic pipeline fixture, existing Shepherd docs.

### Task 1: Typed Configuration and Host Contracts

**Files:** create `src/senses/shepherd/checkin-config.ts`,
`src/__tests__/senses/shepherd/checkin-config.test.ts`; modify
`src/heart/identity.ts`, `src/senses/shepherd/host.ts`,
`src/__tests__/heart/identity.test.ts`,
`src/__tests__/heart/auth/auth-flow.test.ts`.

**Interfaces:**
- `normalizeShepherdCheckInMinutes(value: unknown): number`: exact global bounds,
  undefined returns `60`; invalid explicit values throw.
- `readShepherdCheckInMinutes(agentRoot: string): number`: parse only this
  setting from `agent.json`, reuse the pure validator; unreadable/corrupt config
  surfaces an error rather than silently disabling supervision.
- `AgentSenseConfig.checkInMinutes?: number`; unconditional Shepherd normalizer
  branch preserves `enabled`, optional `notify`, normalized `checkInMinutes`.
- `HostSession.instance?: string | null`, a verified opaque process-start ID.
- `ShepherdInspection` exactly as the spec, with a redacted `screen`.
- Optional `ShepherdHost.inspect(sessionId): Promise<ShepherdInspection>` and
  `promptIfUnchanged(sessionId, line, expected): Promise<GuardedPromptResult>`.
  `GuardedPromptResult` is `{ state: "sent" | "not_sent"; reason?: string }`;
  `not_sent` means no terminal input was attempted. Any exception after paste
  begins is uncertain, never `not_sent`.

- [ ] **Step 1: Write failing interval/normalizer parity tests.**

  ```ts
  expect(normalizeShepherdCheckInMinutes(undefined)).toBe(60)
  expect(normalizeShepherdCheckInMinutes(0)).toBe(0)
  expect(normalizeShepherdCheckInMinutes(30)).toBe(30)
  expect(normalizeShepherdCheckInMinutes(1440)).toBe(1440)
  for (const value of [1, 29, 1441, 30.5, "60", null, false]) {
    expect(() => normalizeShepherdCheckInMinutes(value)).toThrow()
  }
  ```

  Both actual config readers must preserve `{enabled:true, checkInMinutes:30}`
  without `notify`, and all three fields when `notify:"off"` is present.
- [ ] **Step 2: Observe RED with** `npx vitest run src/__tests__/senses/shepherd/checkin-config.test.ts src/__tests__/heart/identity.test.ts src/__tests__/heart/auth/auth-flow.test.ts`.
  Missing dependencies are infrastructure, not the required behavioral RED.
- [ ] **Step 3: Implement the validator/read helper and contracts.**
  Follow existing configuration error events, and preserve other senses.
- [ ] **Step 4: Run the same tests, `npx tsc --noEmit`, changed-source ESLint and
  `git diff --check`; expect all pass.**
- [ ] **Step 5: Commit exact Task 1 paths.**

### Task 2: Fresh Read-only Inspection and Guarded Host Input

**Files:** create `src/senses/shepherd/prompt-state.ts`,
`src/__tests__/senses/shepherd/prompt-state.test.ts`; modify
`src/senses/shepherd/terminal-process.ts`, `cmux.ts`, `herdr.ts` and their
mirrored tests. Consume the Task 1 interfaces; do not change their signatures.

**Interfaces:**
- `inspectCodingPrompt(agent: string, screen: string): { activity:
  "idle"|"working"|"unknown"; composer: "empty"|"draft"|"unknown" }`.
- `TerminalProcessIdentity.instance?: string`: uniquely selected foreground PID
  plus actual process-start output from one batched `ps` query. Failed/ambiguous
  identity leaves it absent; no PID-only or title-based substitute.
- cmux `inspect` resolves the explicit target, verifies echoed UUID/TTY and
  current unique process instance, reads its screen, classifies supported UI,
  and returns current evidence. Do not select stale hook-store records.
- cmux `promptIfUnchanged` re-inspects after target resolution and checks exact
  session/instance/cwd/screen, idle/empty state and focus immediately before
  paste. Refusal returns `not_sent` with zero input calls. Successful paste plus
  submit returns `sent`; any partial/ambiguous effect throws.
- Herdr `inspect` uses current semantic reads. Unknown composer authority means
  no periodic guarded send. Existing ordinary `prompt`/`key` behavior remains.

- [ ] **Step 1: Add synthetic failing classifier and real-adapter tests.**
  Blank supported Copilot/Claude/Codex composers are empty; multiline drafts,
  clipped/unknown layouts, plain shells and permission menus are not eligible.
  Timer-only badge is idle, while active status/background indicators are
  working even with a timer. Same PID/new start fingerprint changes identity.

  ```ts
  expect(inspectCodingPrompt("Copilot", screens.timerOnly)).toEqual({
    activity: "idle", composer: "empty",
  })
  expect(inspectCodingPrompt("Copilot", screens.multilineDraft).composer).toBe("draft")
  expect(inspectCodingPrompt("unknown", screens.timerOnly).activity).toBe("unknown")
  ```

  Adapter races: target echo mismatch, process replacement, cwd change,
  focus/draft/screen change during target resolution; assert no paste/key call.
  Paste accepted then Enter throws must throw, never return `not_sent`.
- [ ] **Step 2: Observe RED with** `npx vitest run src/__tests__/senses/shepherd/prompt-state.test.ts src/__tests__/senses/shepherd/terminal-process.test.ts src/__tests__/senses/shepherd/cmux.test.ts src/__tests__/senses/shepherd/herdr.test.ts`.
- [ ] **Step 3: Implement default-deny known-shape inspection and guarded host
  methods using existing client APIs only.** No unsupported future API or
  claimed server-side atomic CAS. Process lookup remains batched.
- [ ] **Step 4: Same tests GREEN; complete coverage for changed host/classifier
  code, typecheck, scoped lint and diff check.**
- [ ] **Step 5: Commit exact Task 2 files and report test commands/resources.**

### Task 3: Cross-trigger Dispatch and Notice Custody

**Files:** create `src/senses/shepherd/checkin-store.ts` and
`src/__tests__/senses/shepherd/checkin-store.test.ts`.

**Interfaces:**
- `checkInStorePath(agentRoot: string): string`.
- `openCheckInStore(file: string): CheckInStore`, synchronous operations.
- `DispatchInput` includes host/session, nullable instance, screen fingerprint,
  guidance revision, reply, trigger/transition metadata and timestamp.
- `claimDispatch(input, owner): DispatchClaim | null` computes the trigger-neutral
  key required by the spec. Kernel transaction rejects prior sent/claimed/unknown
  keys and any applicable claimed/unknown barrier for that host/session-instance.
  A null-instance barrier covers the stable host/session; claiming with unknown
  instance must also respect existing known-instance barriers.
- `completeDispatch(id, owner, result): void`, result state
  `"sent"|"not_sent"|"unknown"` with bounded reason. `not_sent` is allowed only
  before input; it removes the barrier and permits a future safe claim, not an
  immediate retry loop. Never transition unknown back to pending automatically.
- `shouldNotify(signature): boolean` and `markNotified(signature, at): void`
  persist classification/evidence/guidance suppression in a separate table in
  this same database. They cannot claim input or replace the notice outbox.
- `close(): void`; no model/host/callback inside a transaction.

- [ ] **Step 1: Add failing real-file/kernel-connection tests.**
  Distinct immediate/network/periodic transition IDs with identical inputs collide;
  two connections produce one claim; changed screen or revision cannot evade
  claimed/unknown barrier; null-instance barrier cannot be bypassed by adding an
  instance later. After reopen, unknown remains blocked, sent dedupes and only
  definite `not_sent` can be safely reclaimed. Wrong owners cannot complete.

  ```ts
  expect(first.claimDispatch(input, "one")).not.toBeNull()
  expect(second.claimDispatch({ ...input, trigger: "periodic",
    transition: "different" }, "two")).toBeNull()
  expect(second.claimDispatch({ ...input, screenFingerprint: "changed" }, "two")).toBeNull()
  ```

  Suppression survives reopen but changes on meaningful new evidence. Permission,
  ownership, symlink, corrupt DB/rows and oversized values refuse explicitly.
  Bound each stored row to 4096 encoded bytes and database writes to 64 MiB;
  do not evict unresolved/sent keys to manufacture capacity.
- [ ] **Step 2: Observe RED with** `npx vitest run src/__tests__/senses/shepherd/checkin-store.test.ts`.
- [ ] **Step 3: Implement using existing better-sqlite3 claim/complete and private
  file patterns from `feedback-store.ts`, with no external I/O in transactions.**
- [ ] **Step 4: Same tests GREEN with all four coverage metrics complete for
  `checkin-store.ts`, plus typecheck/lint/diff check.**
- [ ] **Step 5: Commit exact Task 3 paths.**

### Task 4: Existing-chain Sweeps, Fresh Judgment and Shared Dispatch

**Files:** modify `src/senses/shepherd/sense.ts`, `judge.ts`, and existing
`sense.test.ts`, `judge.test.ts`; create
`src/__tests__/senses/shepherd/checkins.test.ts` for the fake-clock matrix.
Add optional typed trigger/custody metadata to `ReturnRecord` in `returns.ts`
only where the actual outcome needs it; keep old readers compatible.

**Interfaces:**
- `ReturnPacket.periodicCheckIn?: { priorJudgment: { kind: ReturnKind |
  "error"|"loop_guard"; reason: string; at: string } | null }`, presentation-only.
- `HandleTrigger` union covers immediate, existing network recovery, periodic.
  All variants call the same `handle` through the existing `chain`.
- `ShepherdSenseOptions` may inject a `CheckInStore` factory for disposable tests;
  production uses the owning agent's private store, not global state.
- Timer/discovery reads only prepare candidates. A single pending quiet-batch
  timer waits the existing `QUIET_MS` outside the serial chain, then enqueues
  periodic `handle` variants with the first inspection and its observation time.
  `handle` obtains the second fresh inspection, verifies unchanged evidence and
  event generation, judges and uses common custody. Never sleep eight seconds
  per terminal inside the chain or hold immediate events behind a quiet timer.
- One common `dispatch` helper, inside that chain, owns claim-before-input,
  definite not-sent/sent/unknown completion and existing guard accounting for
  all automatic text/key sends. Human-requested `shepherd_send` is not changed.

- [ ] **Step 1: Write fake-clock RED tests and prompt-rubric tests.**
  Cover all prior kinds, missing/rotated history, startup already idle, changing
  output, unsupported host/UI, timer disabled/default/bounds, congestion,
  missed ticks, overlapping sweeps, one terminal failing and shutdown.
  Assert fresh context, not old `lastBody`/background flags or kind, is decisive.

  ```ts
  expect(judge.mock.calls.at(-1)?.[0].periodicCheckIn).toBeDefined()
  expect(host.actions.filter(action => action.startsWith("prompt "))).toHaveLength(1)
  expect(host.actions.some(action => action.startsWith("key "))).toBe(false)
  ```

  Provider retry-exhaustion with connectivity staying online can receive one
  fresh safe continuation without `networkRecovered`. Completed work, real
  human/auth/approval blockers and scheduled badge versus real background work
  get distinct judgments. Fixed continuation text must match the spec exactly.
  For focus/draft/guidance/instance/cwd changes during every awaited boundary,
  assert zero input, including an event arriving while a periodic judge waits.
  Prove cross-trigger uncertain send remains blocked after restart and screen
  change. An unchanged blocker repeats neither notice, wake nor status rewrite
  after time advancement/reopen. Preserve existing immediate/menu/network tests.
- [ ] **Step 2: Observe RED with** `npx vitest run src/__tests__/senses/shepherd/checkins.test.ts src/__tests__/senses/shepherd/sense.test.ts src/__tests__/senses/shepherd/judge.test.ts`.
- [ ] **Step 3: Implement the existing-chain periodic variant and common dispatch,
  using Tasks 1-3 interfaces.** Actual-dequeue cadence, no catch-up burst.
  Startup establishes a quiet baseline; old returns only correlate. Current
  focused/recent-focus/guidance/loop guards are never reset by a timer.
  Unchanged-state classification suppression precedes periodic escalation,
  status and notifier; ordinary notice delivery remains with the existing outbox.
- [ ] **Step 4: Same tests plus the complete Shepherd subtree GREEN; all modified
  modules reach complete coverage, typecheck/lint/build/diff check pass.**
- [ ] **Step 5: Commit exact Task 4 files.**

### Task 5: Disposable Pipeline, Documentation and Delivery

**Files:** create `src/__tests__/integration/shepherd-checkins-pipeline.test.ts`;
update `docs/shepherd-sense.md`, `docs/auth-and-providers.md`; update the existing
release metadata set using `scripts/release-bump.cjs`, after implementation.

- [ ] **Step 1: Add a RED compiled-runtime pipeline fixture using owned PTYs,
  the existing fake cmux socket/provider and private temporary agent roots.**
  Two terminals stay isolated; one old premature/provider-stalled session can
  continue, one drafted/blocked session cannot. Reopen custody and advance time:
  no duplicate prompt or unchanged-blocker notice. Exercise actual adapter target
  checks and common claim-before-input, not only injected helper stubs.
- [ ] **Step 2: Build with** `npm run build -- --skip-mailbox-ui-install`, then run
  `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/shepherd-checkins-pipeline.test.ts`;
  observe RED, implement only the missing integration, then GREEN.
- [ ] **Step 3: Document cadence/default/disable, fallback-not-pacing, current
  supported UI/host limits, true blockers/drafts, no keys, shared unknown custody,
  quiet notices and honest source/release/install distinctions.**
- [ ] **Step 4: Run final frozen-source coverage/Nerves, typecheck, lint, UI,
  hermetic integration, package and release preflight.** Preserve exact logs.
  Use `npm run test:coverage -- --skip-mailbox-ui-install` with existing prepared
  dependencies. A Mac bare-fixture policy failure is not green and must be named;
  do not change global Git policy or unrelated source. Exact-head required Linux
  CI must actually pass, including coverage and Nerves.
- [ ] **Step 5: Independent whole-source/code/scope/debt/acceptance review,
  reviewed corrections, version/changelog last, exact-head PR CI, release gate,
  normal merge and automatic publication, then package-managed install/health.**
  Re-observe the actual fleet read-only after installation. No live work used as
  a test fixture, no invented success or manual “continue everywhere” substitute.
  Reconcile canonical task steps/resources and stop the CLI recovery schedule
  when all authorized work is complete or genuinely externally blocked.
