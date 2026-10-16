# Scheduled returned-session check-ins

Status: proposed for independent design review.
Date: 2026-10-16.
Baseline: `aa79367887b36b391f707b33f221ae6136de70fe`.

## Outcome and authority

Shepherd should periodically revisit every coding session that has returned
control, regardless of its previous classification. It should distinguish a
real human blocker, completed work, active background work, an outside
dependency, unfinished authorized work, and a recoverable technical stall.
A provider request exhausting its retries must not require a machine-wide
offline-to-online transition before it can be reconsidered.

The operator explicitly authorized overnight implementation and using the
concurrently running fleet to identify gaps. Design, plan, code, scope, debt and
release gates use independent reviewers under the existing repository policy.
There is no requirement to wake the operator for another generic go-ahead.

The operator corrected an initially proposed five-minute recovery loop as too
noisy: thirty minutes or hourly is appropriate. The selected product default is
hourly, configurable to thirty minutes or longer. This is a fallback, not a
pacing mechanism: normal return events keep being handled immediately, and an
agent must not deliberately wait for a tick when work is available.

The CLI worker's separate thirty-minute recovery schedule is not this feature,
not a product scheduler, and not authority to operate another session.

## Established discrepancy

The existing sense handles return events and has process-local `latestReturns`
and `networkWaiting` maps. Connectivity recovery requires each candidate to
observe offline followed by online. A model/provider request can time out while
both independent network probes remain online.

The cmux quiet-screen fallback emits once after output changes and becomes
quiet. Hooked sessions marked idle are excluded. An old return, including one
not answered because the human was focused, can therefore remain untouched
indefinitely. Restart and subscription gaps deliberately do not replay old
events; a new process cannot assume it has seen all returned sessions.

Read-only observation of the current fleet found both active agents and old
returned sessions, including an older premature return that was not answered
because it was focused then. Its current focus is different. Existing judgments
also treat the mere presence of a scheduled fallback as active background work.
That inference is invalid: a timer is not a running operation.

Private fleet evidence stays outside Git. No real terminal transcript, personal
session, account detail or title becomes a test fixture.

## Alternatives

1. A separate cron script sends “continue” to idle-looking terminals. Reject:
   it duplicates supervision, bypasses state and delivery guards, and confuses
   a timer with authority.
2. Add more provider-error or previous-return-kind filters to connectivity
   recovery. Reject: this still misses arbitrary handed-back reasons and
   incorrectly equates a provider stall with machine-wide offline status.
3. Add a low-frequency sweep to the existing sense and serial return chain.
   Select: current observation and a fresh judgment, not the old reason,
   determine eligibility; existing immediate event handling remains intact.

## Scope and configuration

Add `senses.shepherd.checkInMinutes` to the existing typed sense configuration
and shared normalizer used by both config readers:

- absent: `60`;
- `0`: explicitly disabled;
- integer `30` through `1440`: configured interval;
- all other explicit values: fail configuration with the existing error event.

The field only applies to Shepherd. Preserve `enabled` and `notify` together;
the current normalizer's early return for `notify` must not discard it. Do not
add an environment variable, another process, another machine credential or a
separate agent conversation runtime.

Make the normalizer's Shepherd branch unconditional on
`senseName === "shepherd"`; validate and preserve `notify` and `checkInMinutes`
independently inside it, including when only the latter is set.

One serial timer belongs to `startShepherdSenseApp`. At most one sweep is
queued/running, with no catch-up burst after sleep. Shutdown cancels it and
invalidates work already awaiting I/O. The cadence is measured between sweep
actual dequeued starts using the existing injected clock/scheduler. A busy
serial chain can delay a sweep; it cannot start a concurrent sweep or accumulate
missed sweeps. Record scheduling delay as telemetry, and schedule the next due
start from the actual start rather than enqueuing catch-up work. Ordinary events
never wait for a timer tick. Config changes take effect on the normal sense
restart.

Periodic rejudgment is a third typed variant of the existing `handle(event,
recovery?)` path, enqueued onto the same `chain`. It reuses `guardFor()`,
`latestReturns` invalidation and `guidanceFor()`. No periodic path calls
`judge`, `host.prompt` or `host.key` outside that chain. Read-only discovery may
prepare candidates; it cannot mutate dispatch guards or send independently.

## Discovery and startup

Each sweep lists every current coding terminal rather than selecting a subset
by previous `kind`. Previous `gate`, `done`, `waiting`, `working`, `unclear`,
`error` and `loop_guard` records are all eligible for fresh inspection. A tripped
loop guard remains a hard no-send condition; a periodic tick never resets it.

Use existing return history as a discovery/correlation hint only. It is not live
permission, proof of idleness, a current task mandate or a source of commands.
Only the latest unambiguous record for the same host/stable terminal identity
may supply a prior transition; missing/truncated history is explicit.

On startup, discover current terminals and establish a read-only baseline.
Already returned, positively idle sessions can be considered after a quiet
observation interval instead of waiting an extra hour solely because the sense
restarted. Unknown/running/newly changing sessions establish a baseline but
cannot receive input. Startup never replays an old send.

Remove absent/replaced sessions from in-memory observation caches. A terminal
with no verified foreground coding agent is not a target. Do not restart
sessions, re-create terminals, infer child ownership or reopen the separately
blocked fleet work.

## Fresh observation contract

Add an optional read-only inspection seam to `ShepherdHost`, implemented for
supported adapters and injected by tests. An inspection returns an explicit
stable target, current process instance, current screen, activity and composer
state:

```ts
interface ShepherdInspection {
  session: HostSession
  instance: string | null
  screen: string
  screenFingerprint: string
  activity: "idle" | "working" | "unknown"
  composer: "empty" | "draft" | "unknown"
  backgroundWork: boolean | null
}
```

The instance is an opaque foreground PID plus process-start fingerprint, not
just a reusable PID, title, short surface ref or cwd. Extend the existing
batched terminal-process lookup to obtain it. Ambiguous foreground roots or
unavailable start identity leave inspection unknown; they do not select the
first process as a scheduled-action authority.
Periodic dispatch requires a positively verified non-null instance. A null
instance means unknown, never a fabricated identifier or a startup exception.
On unsupported operating systems or failed `ps`/process-start lookups, the
new instance evidence is unavailable/unknown rather than a startup exception
or a fabricated identifier.

The screen fingerprint is an opaque digest of the exact raw screen, so changes
hidden by exported redaction still invalidate the quiet interval and judgment.
The guarded input call receives the original judged inspection, not a copied or
newer snapshot. Its optional synchronous `canSend` callback rechecks the parent's
event generation, current guidance, focus hold and shutdown state after all
adapter I/O, immediately before attempting input. This closes awaited-lookup
invalidation without claiming a server-side atomic compare-and-swap.

The cmux adapter must use explicitly named UUID targets and validate target
echoes on the new inspection path. Never fall back to focus. Refresh its
process/TTY/cwd association for each inspection. Existing hook-store records
may corroborate current identity but may not be selected merely because they
are newest: observed stores do not necessarily describe current surfaces.

For terminal UIs without an authoritative input-state API, use a deliberately
conservative, separately tested screen classifier. Recognize actual supported
empty composer shapes and current active/background indicators. A nonempty
composer is a draft. Unknown layouts, clipped input areas, ambiguous placeholders
or unverified state remain unknown and cannot receive scheduled input. Never
clear or submit a pre-existing draft. Synthetic fixtures cover supported
Copilot, Claude and Codex shapes; unsupported shapes are an honest no-send limit,
not a guess that they are empty.
This is a default-deny allowlist of known rendered shapes, not a general-purpose
terminal parser that also accepts unrecognized providers by heuristic.

A scheduled-count badge by itself is neither a running job nor a human blocker.
Actual running subprocess/subagent indicators outrank the judge. Provider error
text is evidence for fresh judgment, not mechanical proof of resumability.

Herdr can inspect its current semantic state through its existing read APIs.
If it cannot positively establish an empty composer, its scheduled path remains
read/judge-only and reports that limitation. Its immediate return path is not
silently weakened or changed.

## Rejudgment and action policy

The sweep obtains a current inspection and verifies quiet stability before
asking the existing judge. Read the screen afresh rather than requiring it to
equal a possibly obsolete network-stop screen. Use current agent/cwd/task,
current background truth, existing applicable guidance and the actual prior
judgment as labelled history.

Add a typed periodic-check-in marker to `ReturnPacket`. The judge's periodic
rubric says:

- reconsider the current situation, regardless of the old classification;
- do not invent work for completed tasks or broaden the original mandate;
- an unchanged genuine human/approval/sign-in/credential/account/money/scope
  blocker remains a blocker, not something time authorizes;
- an outside dependency is not done and must not be kept busy artificially;
- a fallback timer alone is not active background work;
- exhausted provider/network retries may be reconsidered without alleging that
  connectivity recovered;
- uncertain mutations require reconciliation before any retry;
- scheduled actions use plain text only, never approval/menu/navigation keys.

Use a fixed bounded plain-text continuation after a `premature` verdict, rather
than letting screen text choose a command:

> Reassess your existing task and continue only already-authorized remaining
> work. Respect human decisions and pauses. Reconcile uncertain effects before
> retrying; do not wait for a scheduled tick when you can work now.

This is not an instruction to resume completed work, pick a new project, bypass
a permission prompt, retry a shell command, or repeat a paid model/tool effect.
If the judge is uncertain, the session stays untouched.

## Final dispatch guards and custody

Before scheduled input, require all of:

1. Fresh recognized instance and same stable host target throughout the pass.
2. Positively idle state, no active background work, positively empty composer.
3. Current `premature` verdict with plain text, no approval/menu key.
4. Current guidance permits it and has not changed revision or scope.
5. Existing streak/hourly guard has not tripped; time does not reset the streak.
6. No current focus or recent human-focus hold.
7. A fresh final observation agrees with the judged screen, process identity,
   composer and activity. A return/resume/focus event or shutdown during awaited
   work invalidates the pass.
8. Durable one-shot dispatch reservation succeeds before terminal mutation.

Scheduled dispatch needs a guarded host entry point, not a call to an unguarded
`prompt` followed by an assumption. The cmux implementation revalidates after
target resolution and immediately before initiating the paste. Preserve the
existing no-focus behavior and never clear/replace input. Do not claim an atomic
server-side compare-and-swap that the installed host does not expose.

Use one small private SQLite custody database under the existing Shepherd state
directory, mirroring `feedback-store.ts`'s `claimDelivery`/`completeDelivery`
two-phase pattern and private ownership/mode checks. No transaction spans
host/model I/O. The dispatch key binds host,
stable session, process-start identity, judged screen fingerprint and guidance
revision. The source transition and trigger are metadata only and are excluded
from the dispatch key. Claims are kernel-owned and durable before
send. A second worker or restart cannot send the same attempt twice.

Only positively reconciled successful host acceptance is recorded as sent.
An exception, disconnect, crash after reservation or ambiguous result remains
unknown and is never automatically replayed. The hourly sweep is not an
alternative retry route. New evidence/new returns can be judged, but do not
erase unresolved attempt identity or silently turn an unknown send into
definitely-not-sent. Bound ledger records; capacity or corruption is an explicit
no-send error rather than eviction or an in-memory success fallback.

Immediate return, network recovery and periodic handling all use one dispatch
reservation helper inside `handle`, before any automatic `prompt` or `key`.
This is necessary even for an immediate attempt: otherwise an uncertain
immediate send could later be replayed through the new periodic trigger.
Store the trigger as metadata, not as part of a key that permits duplicate
claims for the same input. A claimed/unknown attempt also places a durable
host/session-instance barrier against all automatic input, not merely a
same-fingerprint retry. A later tick, changed screen or different trigger
cannot clear that barrier. When instance evidence is unavailable on an existing
immediate path, its uncertainty barrier conservatively binds the stable
host/session and cannot be evaded by a newly observed instance.

Only positive transport completion closes its reservation; exceptions remain
unknown. Existing immediate menu policy is otherwise unchanged. Shared
loop/focus/guidance accounting remains in the existing chain. Do not introduce
another automatic sender or parallel sends to a terminal.

## Low-noise visibility

Record each sweep outcome with its trigger, old classification, current
classification, bounded refusal reason and action custody. Telemetry contains
identifiers/states/counts, not screen bodies, terminal titles, feedback text or
credentials. Store redacted private evidence only where existing state permits.

An unchanged blocked/done/working/unknown session does not produce a repeated
Teams notice, private wake or terminal status rewrite merely because a timer
fired. Notify under the existing policy for an actual continuation or a
meaningful newly changed human blocker. Do not alter ordinary return notices.
Persist the suppression key in a non-dispatch table in that same SQLite
custody database: host/session-instance plus classification signature and
guidance revision maps to the last-notified evidence fingerprint/timestamp.
This table must not claim a terminal send. Use it before issuing a periodic
notice, and keep an unchanged blocker suppressed across restart. The existing
notice outbox still owns delivery custody for the selected notice; it does not
own cross-sweep classification suppression. Do not add another durable store.

Provider/judge errors keep the scheduler alive and produce bounded error
telemetry, not false “recovered” or “continued” outcomes. A failure in one
terminal does not abort the rest of the fleet pass.

## Acceptance and delivery

- Defaults, disable, bounds, invalid types and both config readers preserve all
  Shepherd fields together.
- Fake-clock sweeps cover every prior kind, startup discovery, restart, missing
  history, no catch-up burst, overlapping timers, one terminal failing and stop.
- A provider-request timeout with both connectivity probes online is
  reconsidered; no invented offline/recovered transition.
- Completed work, true human decisions/auth/approvals, deliberate pauses, active
  jobs, focus/recent focus, drafts, unknown UIs and uncertain effects get no input.
- A timer badge is not running work; real background work still wins.
- Process exit/PID reuse/new instance/surface disappearance/changed cwd/task,
  screen/draft/focus/guidance changes during any awaited boundary refuse.
- Independent workers/restart/crash/ambiguous paste or submit cannot duplicate
  an attempt or evade shared guard caps.
- Unchanged blockers are reconsidered at the cadence but do not spam notices.
- Synthetic PTY/socket fixtures prove actual host target verification and
  guarded dispatch. Never copy private fleet text into source.
- Observe the real fleet read-only before/after; normal installed production
  judgments may be correlated, but no blind test intervention, paid probe,
  draft overwrite or deliberately stalled coworking session.
- Complete changed-code coverage, typecheck, lint, build, Nerves, package
  boundaries, independent code/scope/debt review and exact-head CI precede
  release. Source, publication, installation and live acceptance stay distinct.

## Review decisions required

Approve or reject the minimal host-inspection/guarded-dispatch seam, conservative
UI support boundary, startup baseline behavior, durable one-shot custody and
cross-trigger non-replay rule before implementation planning. Do not accept a
timer-only wrapper or an implementation that relies solely on an LLM to decide
whether a human's draft may be submitted.
