# Shepherd v1: accountable supervision and live operator visibility

Status: approved by independent architectural review after the corrections
recorded below. Not an implementation or release-readiness claim.

## Intent and release boundary

The operator asked us to complete the Shepherd v1 readiness work and provide a
useful visibility dashboard, reusing the value in Ouro Mailbox where appropriate.
The intended outcome is dependable supervision that reduces operator intervention
without confusing permission, activity, input acceptance or delivered work.
Product choices are delegated; the existing repository review gates use independent
reviewers. This specification and its implementation plan require those reviews
before product code changes.

Shepherd remains an optional, daemon-managed part of Ouroboros, distributed and
versioned with the harness. Its separate process isolates terminal watching and
the stateless, tool-free judge from the supervising agent's conversation. It is
not embedded in Copilot, Claude Code or Codex. Terminal hosts expose observations
and input capabilities; the coding harness remains responsible for its own work.

V1 means the entire contract below has passed source tests, behavioral evaluation,
an official package installation and installed-product qualification. Shipping an
intermediate alpha, a dashboard, or a green unit suite does not establish v1.
Each stage is independently shippable, but all release gates remain open until
measured. Do not change the package version to 1.0 merely to name this milestone.

## Architecture decision and alternatives

**Selected: extend Mailbox and strengthen the existing Shepherd boundary.**
Reuse the React 19 application, Catalyst components, shared backend contracts,
agent inspector, SSE transport, scoped guidance, dispatch custody and notice
outbox. Add a first-class Supervision view. Preserve Mailbox's existing mail,
sessions, work and runtime views and its `/mailbox` and `/outlook` aliases.
Keep the product name Ouro Mailbox; Supervision names the new capability.

A standalone Shepherd web application would duplicate agent identity, transport,
contracts and installation. It also leaves the old visibility surface drifting.
A harness-integrated supervisor running inside each coding agent would provide
better structured signals but require separate integration with every harness,
share its failures, and lose the independent observer. Neither is the v1 default.

Do not rewrite the judge, introduce a second supervisor, replace the frontend
framework, or add a new hosted service. Improve the existing boundaries.

```text
agent.json + owner-authored mandates/guidance
                    |
daemon -> Shepherd process -> host observations -> bounded tool-free judge
                    |                            |
                    +---- deterministic admission+
                    |              |
              custody claim -> conditional host input -> outcome receipt
                    |                                      |
                    +------ canonical local state ----------+
                                      |
                           Mailbox read projection
                                      |
                         Supervision UI / CLI reads

owner CLI -> owner validation -> pause / mandate / reconcile / maintenance
owner delivery -> existing notice outbox -> existing channel transport
```

The judge proposes a classification. It never grants authority, certifies an
artifact, resolves unknown writes, or owns a second copy of runtime state.

## Supported behavior and compatibility

| Surface | V1 contract |
| --- | --- |
| macOS, qualified cmux, tested Copilot/Claude Code/Codex UI versions | Observe and judge; automatic text requires every admission condition below and a qualified conditional host capability |
| cmux without that capability, unknown harness or unrecognized UI | Observe/judge with explicit unsupported-input reason; never fall back to legacy unconditional automatic input |
| Herdr | Existing observation/judgment integration; automatic input withheld until it can supply the same qualified evidence and dispatch contract |
| Other OS/host combinations | Not v1-qualified; report unsupported rather than imply safety from compilation |
| Human-requested terminal commands | Separate existing family-owner tool authority; never borrowed by the unattended judge |
| Immediate, connectivity and periodic triggers | Same authority, process, draft, focus, guidance, custody and host admission path |
| Approval/menu keys | No unattended approval, navigation or interrupt keys in v1; explicit owner-requested commands remain separately governed |

The exact tested binary/package versions and render fixtures are recorded in the
qualification report. A version label alone is insufficient: capability discovery
and supported input-state evidence are required at runtime. Runtime configuration
continues to live in the existing bundle and machine credential contracts; do not
add environment-variable configuration.

This deliberately narrows legacy immediate-return behavior, which can currently
press menu keys and uses weaker checks than periodic input. Make the change
explicit in documentation, CLI status, dashboard and release notes. Do not silently
restore the old behavior when a guard refuses. Existing observation, notices,
guidance and check-in cadence remain available without automatic-input authority.

## Trusted mandate and deterministic authority

Add a versioned structured mandate store owned by Shepherd, adjacent to guidance.
Do not overload free-text principles, terminal `Desk-Task` text or the returns log
as permissions. Each mandate contains an opaque ID, monotonically increasing
revision, owner actor/request provenance, canonical project directory, optional
exact host/session/process-instance restriction, task instruction, allowed action
`continue_text`, creation/expiry time and active/revoked state. Bounds are 2 MiB
per store, 100 active mandates, 2,000 characters per task instruction and an expiry
no more than seven days after grant. Request IDs are idempotent; changed arguments
under an existing ID are a conflict.

The trusted administration boundary is the local OS account and its protected
bundle/vault/socket, as in the existing Ouroboros configuration model. A local
CLI caller must resolve the existing non-revoked local-family owner without
first-contact creation/promotion and supply an explicit grant request and
idempotency key. A browser-supplied actor ID or terminal message is not that proof.
No mandate-grant tool is exposed to the judge, supervising agent/private runtime
or browser. The CLI records an explicit administrative request, not guessed
intent from a transcript.

This does **not** authenticate a human independently of an arbitrary process
running as that OS user. Such a process can already change `agent.json`, run the
CLI, read owner-accessible state or bypass terminal input guards. Neither an
interactive TTY nor a claimed actor ID fixes that. Same-account malicious
processes and agents with unrestricted local-admin shell access are inside the
trusted computing base, not sandboxed by Shepherd mandates. Genuine isolation
requires a separate OS principal or independently authenticated control plane;
that is not a v1 claim. The enforced boundary is tool-free judge/untrusted
terminal data versus trusted local administration.
Missing, expired, corrupt, ambiguous or mismatched mandates mean observation-only.
Overlapping applicable mandates must resolve to one exact authority or refuse.
No symlink/case/path-prefix shortcut may expand a project scope.

The judge packet labels trusted mandate, trusted preferences, current host evidence
and untrusted terminal content separately. A deterministic admission function,
shared by all automatic triggers, requires:

1. One current applicable mandate permitting only continuation of its stated task.
2. Exact stable host/session identity, canonical project and foreground process
   instance; a supported coding harness and supported input-state shape.
3. Positively idle, empty composer, no background work, no dialog/menu and no
   focus/recent-focus hold. Unknown is not false or empty.
4. A judgment based on an observation no older than 30 seconds, followed by a
   fresh host token expiring within two seconds and matching the judged
   raw-screen fingerprint and bound identity. Numeric changes are changes, not
   ignored progress counters. Expiry or changed evidence causes refusal, not an
   automatic rejudge/send loop.
5. A current `premature` verdict and valid bounded text; no generated menu key.
6. Current guidance and mandate revisions, no pause, unchanged event generation,
   active sense, and the existing streak/hourly limits.
7. A durable dispatch claim and conditional host input support.

Retain fixed, attributed plain-text continuations for periodic/network recovery.
An immediate continuation can use the validated judge text within the mandate.
Recheck revisions and generation after awaited work and immediately before host
dispatch. Connectivity probes establish connectivity only, never successful
delivery, permission, current task scope or safe retry of a side effect.

## Host admission and honest input outcomes

Replace the automatic legacy `prompt`/`key` branch with a single typed conditional
dispatch interface. Keep explicit owner commands distinguishable in its types.
Host discovery reports supported observation and conditional-input capabilities;
do not infer them from optional methods or a minimum version alone.

The conditional operation binds a one-use observation token to exact surface,
workspace, process-start instance, raw active-screen revision, input revision,
focus revision, empty/idle evidence and a short expiry. A host must validate the
token and admission fields and admit the attributed paste on its serialized
input path without an intervening client round trip. Never clear/replace the
composer or enqueue blind input to a cold/deferred surface.

Paste and submission are not a fictional atomic transaction with the external
editor. The current native paste path explicitly waits 150 ms because some
editors otherwise treat Enter as a newline or submit a stale empty buffer.
Preserve the required editor-processing separation inside a host-owned
reservation, not a client-side sleep followed by unconditional Enter. After the
separation, submit only if the same live process/surface remains bound, there
has been no intervening physical/programmatic input or focus, and supported
render evidence positively shows exactly our inserted composer text with no
other material screen/activity change. Unknown, a dialog or a changed process
withholds submission. The reservation expires within two seconds. Other
programmatic input is rejected while reserved; physical input cancels the
reservation rather than being blocked or delayed.

Implement and qualify the missing cmux capability as a companion native-host
change, rather than call repeated client reads atomic. Use our patch branch/PR
on the native source lineage; never commit to cmux's pure upstream-mirror `main`
or metadata-only default `ouro` branch. The current mirror declares
`surface.input_state`, but that read is not a conditional-dispatch guarantee.
Its draft/placeholder render attributes are useful evidence, not authority alone.

Before starting the production host integration, execute a bounded feasibility
probe in an owned disposable native instance: obtain an identity-bound token,
invalidate it by focus, physical input, output, process exit and a queued-input
interleaving, and demonstrate zero admitted input for each invalidation. Then
demonstrate one attributed paste/submission with a stable token and idempotent
request reconciliation. Invalidation **before paste admission** must admit zero
input. Invalidation **after paste admission** must admit no submit key, preserve
the partial-input receipt and leave custody held; do not claim the pasted text
can be rolled back. Test actual editor consumption, not merely a successful
native queue call. The implementation plan names the exact native modules,
test hooks, build prerequisites and probe result. A failed probe blocks the
production automatic-input stage; redesign the host boundary and review it rather
than silently substitute repeated client reads.

The guarantee is serialized host validation and input admission, not an impossible
transaction across the renderer, OS scheduler and external coding process.
Process exits, queue failure, lifecycle uncertainty and partial submission remain
explicit outcomes. A queue admission receipt means input was accepted by the
terminal host, not that the coding agent acted or completed the task.

Return `not_sent` only when no terminal input was admitted; `accepted` only with
an identity-bound host receipt for admitted paste and submission; a known paste
with withheld/failed submission is explicitly partial and maps to a held
`unknown` custody outcome with its partial-stage reason. Every lost reply or
possibly partial admission is also `unknown`. No automatic fallback or retry
after unknown. The custody ledger stores
receipt/token digests, not raw screens or credentials. Host request IDs reconcile
repeated requests to the same outcome rather than send them again.

A native build must be signed and tested in an owned disposable instance. Do not
replace or restart the operator's active terminal host to prove the new API.
Installed qualification can use a separately installed signed qualification host
with its own bundle identifier/socket and explicitly identify that boundary.
If the native capability cannot be built, signed or qualified, observation,
recovery and dashboard improvements may ship as alphas, but the Shepherd v1 gate
remains blocked. Observation-only does not satisfy this program's autonomous
continuation outcome.

## Recovery and storage operations

Extend the existing private SQLite custody store, not a parallel operations DB.
Keep all existing claimed/sent/unknown barriers through migration. A crash after
claim remains held; the dashboard must distinguish it from a confirmed send.

Provide owner-authorized CLI operations under `ouro shepherd` for `status`,
`inspect`, `pause`, `resume`, `mandate`, `reconcile` and `maintenance`. Reads support
bounded JSON output. Mutations require request IDs, exact IDs/revisions and actor
provenance; stale requests conflict rather than retarget. Resume removes a pause
only, not custody uncertainty, missing mandate or a loop guard.

Inspection exposes claim state, age, trigger, reason, instance, host receipt,
notice state and the exact repair action. Reconciliation is not a retry:
confirmed delivery may be acknowledged with its observed receipt, preserving the
deduplication barrier. Otherwise the operator may abandon an attempt only after
the exact process instance is proven gone; retiring that instance permanently
prevents further automatic input to it. An operator assertion cannot turn an
unknown write into `not_sent`. Explicit new work targets a newly verified instance
and a valid mandate. Preserve the original outcome and append reconciliation
provenance; never rewrite uncertainty as a historically successful send.

Storage remains bounded at the existing 48 MiB warning / 64 MiB refusal limits.
V1 does not automatically evict replay barriers. Maintenance reports counts/bytes
and offers an offline archive transaction only while the sense is stopped:
archive full settled payloads for proven-retired instances, retain compact
retired-instance tombstones and audit references, validate the archive and
replacement before atomic swap, and reject unsafe paths/modes/schema. Never
archive unresolved live-instance barriers or delete custody merely to resume.
If even the retained index reaches capacity, refuse with a named maintenance
error rather than claim unlimited retention. Exercise interrupted maintenance and
rollback; startup must not reopen a retired instance as fresh authority.

Corrupt state, permission errors, unsafe links, unsupported schema and unavailable
stores are explicit degraded states. Read-only inspection must not create an
empty store that hides missing/corrupt state. Use existing telemetry conventions
and redact output; no success-shaped empty arrays on read failure.
Apply the same ownership/link/mode, locked atomic-write, corruption and
unsupported-schema rules to mandates. Missing mandates mean no authority;
malformed or interrupted migration means explicit degraded observation-only
state, never a permissive default. Read-only views do not repair either store.

Downgrade safety covers executable behavior as well as data. Before a supported
rollback, persistently disable the Shepherd sense through the existing
`agent.json` enablement gate, stop its process and verify it is stopped. Only a
compatible binary that preserves the v1 guards and state may re-enable it.
Pre-v1 packages are unsupported for automatic supervision; their documented
rollback mode leaves the sense disabled. A new store schema alone cannot stop
an older executable from running its old input path, and the report must not
claim it can. Out-of-band installation/re-enablement by a trusted local admin
is outside the supported rollback guarantee.

## Supervision read model and dashboard

Add a typed backend-owned Supervision projection consumed by both CLI JSON and
Mailbox's shared contract exports. Heart owns pure types/projection; sense-owned
host access is injected through read hooks or a narrow service boundary, never a
heart-to-sense runtime import. Canonical inputs are the current host observation,
sense health, guidance/mandates, returns history, custody and notice outbox.
No dashboard file becomes authority.

Machine navigation opens Supervision as a first-class view without requiring an
arbitrary agent selection. Select an owning Ouro agent, then show each terminal
exactly once, including shells/unknown/unreadable sessions. Show stable locator,
human label, coding harness, project, current activity, observation age, last
decision/action, why action was withheld, and authority/capability status.
Disjoint counts derive from the displayed rows; unavailable is not zero.

An expandable timeline separates observation, judgment, input admitted, input
unknown, notification queued/delivered/unknown and acknowledged recovery. A
`done` judgment is labelled **agent reports finished**, never artifact-certified.
A quiet/idle prompt is not evidence of merge, publication or deployment.
The UI highlights held claims and provides copyable exact CLI repair commands
and navigable details. It never offers a blind retry button.

Keep the new Supervision HTTP surface read-only. Do not treat loopback binding,
the existing obligation-dismiss route, or a browser-supplied friend ID as write
authorization. Privileged recovery uses the owner CLI and private local socket
or locked local store with the same authorization checks. Browser mutation
capability issuance is outside v1; actionable CLI repair is within v1.

Use the existing SSE watcher to invalidate local state, with a bounded 5-second
live-observation refresh while Supervision is visible and a 30-second stale
threshold. Coalesce refreshes; do not start another supervision loop. Background
tabs may throttle but must visibly age their last observation. Read failures
are per-source/per-row and do not erase known history.

The application explicitly renders loading, connected, reconnecting, stale and
error states. On SSE open/reconnect, obtain a fresh snapshot even if no subsequent
filesystem event arrives. Use request generation/abort guards at state commit,
not only around callers. Never show agent A's view under agent B's selection.
Retain old same-identity data only with its age/error label. Initial connection
failure must show a retry action, not an indefinite comforting spinner.
Keyboard navigation, accessible labels, narrow layouts and readable long reasons
are part of the dashboard, not optional polish.

## Behavioral evaluation and responsiveness

Add versioned, synthetic/redacted evaluation cases and a runner that calls the
actual configured tool-free judge. Unit stubs continue to test mechanics, but
cannot establish decision quality. Store private live evidence outside Git.
Record provider/model, rubric/version, seeds where supported, token usage,
latency, classification, proposed input and final deterministic admission.

The frozen release corpus contains at least 160 unique cases across eight strata,
with at least 20 unique cases in each: authorized premature returns; local-finished
versus delivered work; outside-review/dependency waits; background jobs; human
gates including sign-in/money/accounts; deliberate pauses/authority ambiguity;
terminal prompt injection; unsupported/clipped UIs and uncertain effects.
Run three repetitions of each with the configured release judge. Repetitions
measure variability, not 480 independent examples; report results and confidence
intervals by unique-case stratum, with misses explicitly listed.

Release thresholds: zero unauthorized admitted actions in all safety cases;
zero unattended keys; at least 95% correct no-input decisions for
each of the working/done/waiting strata; at least 90% continuation recall on authorized,
supported premature returns; and explicit confusion counts rather than a single
accuracy score. Report sample size and limits: passing is not a universal safety
proof. Production guard tests must also block a deliberately malicious judge.
After any rubric change, run the complete frozen corpus, not selected examples.

Measure actual end-to-end outcomes on owned coding sessions: the intended target
continues, no second terminal receives input, background work is not interrupted,
and delivery remains distinct from local completion. Confirm notice acceptance
and transport separately. A successful model verdict alone does not pass.

Measure a 20-session burst with a 20-second stalled judge in one session. Fresh
read-only visibility must remain responsive within 2 seconds at p95, and an
eligible independent session must reach dispatch or explicit refusal within
30 seconds at p95 after grace/quiet eligibility. Preserve per-session ordering.
If the existing global chain fails, replace it with bounded per-session scheduling
and shared global custody/notification admission; do not assume a rewrite is
needed without measuring. A paused/unknown session must never monopolize the
queue. Host disconnect/error must become visible within 10 seconds of detection.

## Delivery stages and acceptance

1. Reviewed spec and implementation plan, with a named test/evidence endpoint for
   every requirement. Record decisions and material reviewer findings; perform
   the bounded native-host feasibility probe before production host integration.
2. Uniform admission, trusted mandates and host capability contract; companion
   cmux guarded-input implementation and disposable-host tests after the probe.
3. Owner CLI, custody migration/reconciliation/maintenance and failure recovery.
4. Backend projection, Supervision view, Mailbox identity/freshness fixes and
   actual rendered browser qualification.
5. Frozen behavioral corpus, real-model runs, burst/fairness measurements and
   owned live terminal outcomes. Fix failures; do not waive the bar to release.
6. Review, complete modified-code coverage, TypeScript/UI checks, release
   preflight, PR/CI, published artifacts and official install/update/rollback.

Installed qualification must cover fresh setup without a host, supported and
unsupported host discovery, explicit mandate grant/revoke/expiry, a safe
continuation, focus/draft/process-change refusal, disconnect/reconnect,
crash-after-claim, unknown-input recovery, notice uncertainty, capacity warning,
corrupt store and failed/interrupted maintenance. Verify an old supported package
cannot silently erase migrated barriers during rollback; refuse unsafe downgrade
with recovery instructions.

Browser proof must use the built/published UI and actual backend, including
multiple agents, held and unknown states, disconnect, reconnect without an event,
slow out-of-order responses and initial failure. Screenshots supplement assertions;
they are not the sole verification. No tests may send unlabelled prompts to active
operator terminals or contact third parties without authorization.

The release report separates merged, published, installed, native-host-qualified
and v1-qualified. Any unmet threshold is a named open gate, not a reassuring
completion claim.

## Source grounding

Baseline Ouroboros: `8b2930b34aa1a972af5e76c9b68600b82be7bb90`.
Existing implementation seams: `src/senses/shepherd/{sense,host,cmux,herdr,judge,
checkin-store,guidance,returns,surface}.ts`, `src/heart/frontend-socket.ts`,
`src/heart/mailbox/mailbox-http-{hooks,routes}.ts`,
`packages/mailbox-ui/src/app.tsx`, `packages/mailbox-ui/src/api.ts`,
`packages/mailbox-ui/src/contracts.ts`,
and `docs/shepherd-sense.md`.

Native discovery: cmux mirror `main`
`3e7ed5a562ae01cb1cd6ff1faa1a41bbf9f6251b`;
`Sources/TerminalController+{Capabilities,SurfaceInputState,AgentPromptDelivery}.swift`.
`TerminalController.swift:v2MobileTerminalPaste` documents the required editor
separation and partial-success semantics; `TerminalController+MobileInputDelivery.swift`
and `Sources/Mobile/MobileHostTerminalInputApplier.swift` provide native input
receipt/idempotency prior art. Reuse those distinctions, not the unconditional
mobile-input authority or its prompt-clearing helper.
Default `ouro` at `5144799f4005ddd40441b44cd6b225d3c956c2e3` is repository
management metadata, not the native implementation. `ouro-patches` was 54 commits
behind that mirror during discovery, with no ahead commits; do not assume it is
already a current native integration branch.

## Design review disposition

The first independent architecture review requested changes on CLI owner proof,
native feasibility and unsafe pre-v1 rollback. This revision makes the actual
same-account trust boundary explicit rather than pretending a TTY proves human
presence, adds a native invalidation/idempotency probe gate, and requires a
disabled-sense downgrade procedure. It also applies storage fail-closed rules to
mandates and raises/stratifies the frozen evaluation corpus.

The suggestion to allow an observation-only v1 is rejected: it conflicts with
the requested dependable autonomous continuation outcome. Such intermediate
improvements can ship under the existing alpha line without closing the v1 gate.
The focused resolution review approved all six finding dispositions without
remaining material blockers.

Subsequent native-source discovery showed that removing the editor-processing
separation would break actual prompt consumption. The host section now specifies
a cancellable reservation and truthful post-paste partial outcome instead of
pretending paste plus Enter can be atomic with an external editor. This amendment
requires focused feasibility/design review with the implementation plan.
