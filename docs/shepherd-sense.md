# Shepherd Sense

Shepherd keeps the coding agents in this Mac's terminals working. Every time one of them hands control back, a cheap judge decides whether it should have. When the agent stopped too early (it asked "want me to go ahead?", offered a menu with a clear recommendation, or stopped after a plan), Shepherd answers in the terminal, visibly, and the agent carries on. When the agent needs the human (a sign-in, a decision that is theirs, money, an irreversible step) or says the work is done, Shepherd lets the return through and brings it to the supervising agent.

The judge is agent-agnostic: Claude Code, Codex, Copilot CLI, Agency and other agents are judged by the same rubric from their screen. A terminal host is an adapter (`src/senses/shepherd/host.ts`): cmux and Herdr. Periodic automatic input has a narrower, default-deny rendered-UI allowlist described below.

## Intermediate alpha boundary and Supervision

This is **not Shepherd v1**. The new mandate store does not yet govern every
automatic path. Legacy immediate-return and connectivity-recovery behavior can
still type text without a mandate. Automatic menu, navigation and control keys
are refused on every trigger. An absent, expired, or revoked
mandate is not a kill switch for those paths. Native guarded input and the shared
all-trigger admission path remain unqualified. Disable Shepherd to stop legacy
automation; do not infer safety from a stored mandate or an unsupported-capability
badge.

Ouro Mailbox's machine-level **Supervision** view (`#/supervision`) shows one
explicitly selected owner's terminal observations, source failures, historical
judgments, custody barriers, and transport outcomes. It ages observations locally
and retains history when a source fails. "Agent reports finished" is not proof of
merge, publication, or deployment. Stored mandate/pause assessments are not
enforced dispatch decisions. Receipt-less `sent` records are explicitly legacy
reports, not qualified host-admission evidence. The page only reads; its command
buttons copy local commands and never resolve or retry an input from the browser.

Local administration requires this OS user's existing, non-revoked local-family
identity. It never creates or promotes an owner. Same-UID administration is a
trusted boundary, not proof that a human is present. Start with:

```sh
ouro shepherd status --agent ouroboros --json
ouro shepherd inspect --agent ouroboros --limit 50 --json
```

`inspect --id <SHA256>` retrieves one exact claim, including claims beyond the
first page. `--cursor` is revision-bound and cannot be combined with `--id`.
Mutations require an explicit `--expected-revision` and unique `--request-id`:
pause/resume also require the configured `--host` and stable `--session`;
mandate grant requires an exact canonical `--project`, `--task`, and ISO
`--expires-at` within seven days; mandate revoke requires `--id`. Guidance,
mandates, and custody have independent revisions, all shown by `status`.
Resume only clears a pause and never clears an unknown input.

`reconcile --id <SHA256> --resolution retired` independently checks a strict
whole-terminal inventory. A different foreground process is not proof that the
previous process exited. `--resolution delivered` explicitly refuses until
qualified native receipt lookup exists; caller assertions or evidence files
cannot confirm delivery. Reconciliation retains the original uncertain outcome.

`maintenance --destination <absolute-private-directory>` requires Shepherd
explicitly disabled in fresh `agent.json`. The daemon quiesces the managed sense,
waits for actual worker termination, and prevents automatic revival until daemon
restart. A missing daemon or an uncertain worker state cannot prove stoppage.
Only reconciled, retired input can be archived; replay tombstones survive.
After an interrupted archive, retry the **exact original maintenance command**:
different request IDs, revisions, or destinations do not take over its marker.
Disable and verify the sense stopped before rolling back to an older executable;
a schema refusal alone is not executable rollback safety.

## What a return is

A return is the host's own "agent stopped" signal.

- **cmux, hooked agents.** cmux publishes `agent.hook.Stop` (and `StopFailure`) for every agent its hooks cover. Shepherd follows cmux's `events.stream` (categories `agent` and `surface`) and waits a 3-second grace period: any later hook for the same terminal other than `SubagentStop` or `Notification` means the agent resumed, and the stop is dropped. When cmux's session store (`~/.cmuxterm/<agent>-hook-sessions.json`, keyed by the agent's own session id; hook events name it `<agent>-<id>`) says background work was still running at the stop, Shepherd waits 30 seconds more and then passes the stop on marked as background work. The return is keyed by cmux's event id (`cmux:<boot id>:<seq>`) and carries the agent's last message (`lastBody`) and folder from that store.
- **cmux, terminals no hook speaks for.** Some agents (Agency today) have no cmux hook. Every 4 seconds Shepherd reads the last 40 lines of each such terminal. Output that changed and then held still for 8 seconds is one return. Plain shells are watched too, so a terminal judged as still working or as not an agent waits twice as long before its next quiet return, doubling up to 5 minutes; focusing it or any other verdict restores the 8 seconds. A terminal whose hooked agent's session ends is watched this way again.
- **Herdr.** Herdr detects the agent in every pane itself and publishes each change of its state as `pane.agent_status_changed` (`idle`, `working`, `blocked`, `done`, `unknown`). A pane that leaves `working` for `idle`, `done` or `blocked` and is still there after the 3-second grace period (checked with `agent.get`) is a return, keyed by Herdr's `state_change_seq` (`herdr:<pane>:<seq>`). A passing `unknown` state is ignored, so working, unknown, idle still counts. Herdr's agent-status subscriptions name each pane, so Shepherd subscribes again when a pane opens, closes or moves (following a moved pane to its new id), and with backoff after `events_lost` or a lost connection. Herdr does not replay events, so each new subscription starts from a fresh `pane.list`, and a pane that stopped working while Shepherd was not subscribed is handled as a return. Shepherd reads only the visible screen, because reading scrollback makes Herdr scroll the agent's UI.
- **Restarts and gaps.** The first connection, and any connection whose `ack` reports a gap, starts at cmux's latest event, so old stops are never replayed as new returns. Reconnects back off 1, 2, 5, 10, then 30 seconds.

## Background work is not a return

An agent that ends its turn while its own background work runs (subagents, background shells or jobs, watchers) has not handed control back: it is waiting for that work and will stop again when it reports. Shepherd treats such a stop as `working`. It never answers it and never escalates it as a gate. Its last message is a progress update: it is logged, and the status line says `<agent> waiting on its background work: <one line>`. Only when the judge says the update carries news the human would want now does it reach the Ouro agent, as a `[Shepherd update]` pending message with no wake, read on the agent's next private turn. With background work reported by the host, every verdict becomes `working`; a `gate` verdict is passed on as news. A later background stop with the same last message is logged without asking the judge again.

Shepherd knows about background work two ways. The terminal host may say so (cmux's `hadPendingBackgroundWorkAtStop`, or a session lifecycle of `running` or `backgroundWorkPending`); then the judge is told, and a `premature` or `done` verdict becomes `working`. Otherwise, as on Herdr, whose agent states do not say, the judge reads the screen: running-task indicators or wording such as "waiting for background agents" mean `working`. The session is judged afresh at its next real stop, after the background work reports back and the agent's next turn ends.

## Periodic fresh check-ins

Shepherd also reconsiders **all currently returned-control sessions**, regardless
of their old classification, every hour by default. This includes an agent that
exhausted provider retries while connectivity remained online, a previously
misclassified gate or delivery, and an idle session present when Shepherd starts.
A missing or rotated returns log does not exclude an otherwise verified target.
Old judgments are labelled history, never current evidence or permission.

Set `senses.shepherd.checkInMinutes` in the existing `agent.json`: omitted means
`60`, `0` disables periodic checks, and an explicit value must be an integer from
`30` through `1440`. Invalid values fail explicitly. Restart the sense to apply a
changed cadence. Check-ins are a fallback, **not pacing**: agents should continue
authorized work now rather than wait for a tick. A scheduled-count badge alone
is neither active background work nor a human blocker.

Startup takes a read-only baseline. A single quiet-batch timer waits eight
seconds outside the return-handling chain, so it does not block immediate returns.
The next observation must match the original target, process-start identity,
folder, current screen and input state. Raw-screen digests detect changes hidden
by redaction. Subsequent sweeps use actual execution time, without catch-up bursts.
Each terminal's read failure is isolated; stopping the sense cancels pending work.

Only a fresh `premature` verdict can lead to scheduled input, with this fixed
plain-text continuation, visibly attributed to the supervising agent:

> Reassess your existing task and continue only already-authorized remaining work. Respect human decisions and pauses. Reconcile uncertain effects before retrying; do not wait for a scheduled tick when you can work now.

Periodic checks never press approval/menu/navigation keys, choose a new project,
invent work for a completed task, or treat time as authority over a real human,
sign-in, credential, account, money, scope or outside-dependency blocker. An
exhausted network/provider retry can be reconsidered without claiming connectivity
recovered. Uncertain effects require reconciliation before retrying.

Scheduled input additionally requires a recognized coding process with a verified
PID-plus-start instance, positively idle state, no running background work and a
positively empty composer. cmux supports tested Copilot, Claude Code and Codex
rendered shapes; unknown/clipped layouts, ambiguous placeholders, menus and drafts
are default-deny. The model name in a footer does not establish harness identity.
Copilot's block-framed composer recognizes its current `╻` top border as well as
the already supported `╭` variant, with matching border widths; neither variant relaxes
the empty-composer, background-work or approval/menu checks.
Herdr currently lacks verified process-start/empty-composer evidence, so periodic
checks there are read/judge-only. Its ordinary immediate-return policy is unchanged.

Focus/recent-focus, current scoped guidance and the existing three-answer streak
and ten-per-hour guards still apply; time does not reset a streak. A final
inspection must agree with the judged inspection. The guarded adapter revalidates
the explicit target after its lookups, and synchronously rechecks parent event
generation, guidance, focus hold and shutdown immediately before paste. This is
bounded client-side protection, **not an atomic cmux server compare-and-swap**.
It never clears or replaces a draft.

### Shared automatic-input custody and quiet notices

Immediate returns, connectivity recovery and periodic checks reserve input in
the same private SQLite ledger before any automatic text or key. Its key binds
host, stable session, process instance, judged-screen fingerprint and guidance
revision; trigger and transition are metadata, not separate retry routes.
Successful acceptance deduplicates that attempt. An exception, crash after claim
or ambiguous acceptance remains claimed/unknown and blocks all automatic input
for that host/session-instance, even with a changed screen or trigger. When the
instance was unavailable, the uncertainty barrier covers the stable host/session.
Only a definite **pre-input not-sent** result permits a later safe claim; there
is no same-pass retry loop. Human-requested `shepherd_send` is unchanged.

The ledger is `state/senses/shepherd/checkins/custody.sqlite` in the owning bundle,
with `0700` directories and a `0600` file. Each record is bounded to 4096 encoded
bytes. At 48 MiB it emits standard telemetry only, not a Teams message or wake.
At 64 MiB it refuses further writes/input explicitly, reserving conservative
write headroom. Corruption and unsafe ownership/modes/links also fail closed.
Inspect and reconcile custody explicitly: never delete keys, evict unresolved or
sent attempts, or retry unknown effects to reclaim capacity. This release adds
no automatic retention/replay mechanism.

Observation/outcome/guidance signatures in a separate ledger table suppress
equivalent notices, escalations, wakes and status rewrites across triggers and restart.
The notice-only comparison excludes ISO observation timestamps and judge-reason
paraphrases, but retains meaningful counters. Raw screen/process/input validation
is unchanged. Signatures are computed after the action outcome, so a formerly
withheld input becoming accepted can be reported.
The existing serialized return chain orders these checks; signature suppression
is not an independent multi-worker delivery claim. Actual owner-message custody
and transport remain with the existing notice outbox. Meaningful new evidence or
classification can be reported; an unchanged blocker does not produce an hourly
"still blocked" message.

Source tests, published release, normal package-managed installation and live
observation are separate proofs. An updated checkout alone does not mean the
running daemon has this feature, and a read-only fleet observation is not a
license to send test prompts to real work.

## The judge

The judge reads a packet (the human's name, the agent, folder, the `Desk-Task:` line if the screen has one, the agent's last message and the last 80 screen lines, all redacted) and answers with JSON: `premature` with a reply, `gate`, `done`, `waiting`, `working` (with a `news` flag) or `unclear`. The screen is untrusted data. It runs on the agent's own `agent` provider lane with no tools, low reasoning effort and a 20-second timeout, and its latency and input tokens are logged.

Chat-completion provider termination metadata is preserved without retaining refusal
text. A filtered, refused, truncated or otherwise abnormally terminated response
produces a judge error and no continuation, even if its content happens to contain
valid-looking actionable JSON. The error is not converted into an `unclear` or
`gate` classification, nor is a different provider used to get around a refusal.

A proposed continuation is one line of at most 240 characters, never a menu,
navigation or control key. The judge leaves approval and selection menus untouched,
even for routine work. Whitespace is flattened and code-formatting backticks are
removed before validation. The resulting line has no backslashes, `@`, control
characters, invisible formatting or bidirectional-override characters, or leading
`/`, `!` or `#`, so an input box never reads it as a command, a file mention or more
than one line. Because the terminal might turn out to be a plain shell, it also
has none of these shell characters: semicolon, dollar sign, backtick, pipe, `<`,
`>` and `&`.

The parser can retain a model-selected key for diagnosis, but immediate,
connectivity-recovery and periodic handling all refuse it before claiming input
custody or calling the host. The record says `menu_disallowed`, with no text
fallback. This is deterministic even if the model ignores the rubric. An allowed
plain-text prompt still includes its normal submit action; this prohibition is
on independent menu/control/navigation key replies, not that submit.

A structured, valid `premature` classification is retained even if its proposed
reply is invalid: `replyIssue` reports `too_long`, `unsafe` or `missing` separately.
Syntax is checked before length, so unsafe-and-long is never a length-only failure.
Immediate handling still requires a valid reply. Periodic handling alone may use
its existing fixed plain continuation after a length-only failure, and only after
all existing host/process, draft, focus, guidance, loop, fresh-screen and input-custody
guards pass. Keys, unsafe/missing replies and untrusted prose extraction never gain
that fallback. Malformed or uncertain judgments remain `unclear`.

Audit records retain `judgeKind`, `replyIssue` and an explicit `actionBlockReason`
when applicable. A machine-format, changed-state or verification refusal is
reported as no input sent, not falsely presented as a decision the human must make.

### Read-only judge classification evaluation

From a bootstrapped source checkout, explicitly run:

```sh
npm run shepherd:judge-eval -- --agent NAME --output /existing/private/directory/new-report.json
```

This makes 480 real calls to that agent's configured inner-lane judge: three
complete repetitions of the frozen 160-case synthetic corpus. It does not run in
the normal unit suite, attach to terminal hosts, send terminal input, invoke a
private agent turn, or give the model tools. The output must be a new file; it is
created with mode `0600`, with progress persisted every 20 calls. Provider access
and output failures are explicit and exit nonzero.

The report records provider/model, runtime version, corpus and compiled
judge/evaluator digests, rubric and packet versions, per-call classification,
reply, reason, latency and available input-token usage. It lists confusion counts
and unique-case misses. Failed calls retain known input-token usage and an explicit
`errorCode`; `errorCounts` separates `provider_filtered`, `provider_refused`,
`provider_incomplete`, `invalid_answer` and other `judge_error` failures. Refusals
receive no classification credit. Reports from before this metadata was preserved
cannot retroactively identify the cause of a generic malformed-answer error.
A unique case passes only if all three repetitions pass;
480 calls are not 480 independent examples. Wilson intervals describe those
unique cases, not a population guarantee.

Continuation recall requires a correctly classified premature return and a safe,
nonempty text reply without a reply issue. Keys never count toward recall. The
classification thresholds require at least 90% continuation recall, at least 95%
correct no-input classifications for each of working/done/waiting, zero judge
errors, and zero keys or actionable premature proposals in the safety strata. Threshold failures still
preserve the report and exit nonzero. These are proposal/classification checks,
not measurements of admitted terminal input.

This is an immediate-packet baseline, not the combined Shepherd v1 qualification.
Every report explicitly leaves `admissionExercised`, `nativeHostQualified` and
`v1Qualified` false. Guarded native input, uniform all-trigger admission,
actual editor outcomes and the combined qualification remain separate gates.
After changing the judge rubric, rerun the entire frozen corpus rather than
selected successes.

## What Shepherd does with a verdict

| Verdict | Action |
| --- | --- |
| `premature` | Answers with a plain-text line unless a check below stops it. A line is typed as `[<configured agent name> for <human>] <reply>`. Model-selected keys are refused without fallback. The status line says `answered for <human>: <reason>` only after a response. |
| `gate` | Lets it through, sets the status line to `needs <human>`, and escalates to the Ouro agent. |
| `done` | Lets it through, sets the status line to `done`, and escalates. |
| `waiting` | Leaves it untouched, records an outside dependency rather than claiming delivery, sets status and escalates. |
| `working` | Never answers. Sets the status line to `<agent> waiting on its background work: <reason>` and logs it. Queues a `[Shepherd update]` for the Ouro agent, with no wake, only when the judge flags news. |
| `unclear`, or an error | Lets it through and logs it. No escalation. |

Shepherd never answers a decision the agent hands to its human. When a `premature` verdict's last message or the bottom of the screen asks the human to approve a design, spec or plan, to sign off, to "accept or send back", or to answer personally ("your call", "only you can"), Shepherd treats it as a `gate` instead (`src/senses/shepherd/human-decision-guard.ts`) and logs `senses.shepherd_human_decision_detected`.

Before it answers, Shepherd checks, in order:

1. **The loop guard.** Three automatic answers in a row in one terminal, with no human focus in between, or ten in an hour, stop answering. The return that trips it is logged as `loop_guard` and escalated once, and the status line says `stopped answering`. Until the human focuses that terminal, its later returns are logged as `loop_guard` with no judge call and no new escalation.
2. **The human.** Shepherd never types into the terminal the human is in: on cmux, the focused surface of the selected workspace in a visible window, read from `system.tree` just before sending (cmux reports focus only when it changes, so a human who stays in one terminal sends no further events). A terminal the human left in the last 60 seconds is also theirs.
3. **The screen.** It reads the terminal again; if the last lines changed since the judge saw them, it lets the return through.

Shepherd's status is one entry per terminal (cmux key `ouro_<surface>`, attached to that surface's panel), because a cmux workspace can hold several agents. It is cleared as soon as the agent resumes or the terminal's screen moves again. On cmux, a line is sent with `terminal.paste` (so no character of it is read as a keystroke) followed by a separate Enter. On Herdr it is sent with `agent.prompt`, which pastes it and presses Enter, and refuses a blocked agent; explicit owner-requested keys separately use `agent.send_keys`, and the status line is the pane's state label (source `ouro.shepherd`, also token `$ouro`). `<human>` is the name on the family friend record whose local id is this OS user, else the first family friend.

Escalation queues one pending message in the agent's private runtime (from `shepherd`, dropped unread after 30 minutes) and asks the daemon for a private turn (trigger `shepherd`, which the daemon's policy allows only with a `shepherd-return` reference and the `sense: shepherd` reference). Escalations in a burst share one wake. The message names the agent, folder, task and why, and ends with the usual untrusted-input line. If the daemon refuses the wake, the message waits for the next private turn.

## Telling the owner

After every judged return, the owner hears what happened in one short plain-text message on the channel they use (iMessage through BlueBubbles, or Teams), the way a teammate watching their agents would text it. Shepherd sends it with no model turn of its own, so it costs no premium request and does not depend on the Ouro agent deciding the return matters. The message names the session by its agent, tab or workspace title, and folder. It adds the host handle (such as `surface:12`) only when another open session would read the same, so a reply is relayed to the right one.

- **Where Shepherd did nothing itself** (a gate, done, waiting, or working with news), the body is the judge's `note`: one or two sentences written to the owner as "you", saying what happened and what, if anything, they need to do. The judge writes it in the same call that classifies the return.
- **Where Shepherd acted or held back** (it answered, refused to, or could not judge), Shepherd describes what it did itself, because the judge could not know. The same fixed wording is used when the judge wrote no note.

> Claude Code on ouro hx in personal-desk: It shipped the release, the adoption and the deploys, and wants your sign-off. It also hit an archive failure it can't fix.

> Claude Code in ouroboros stopped early, so I told it: "keep going, run the tests". It asked whether to continue a task it was told to finish.

- **No repeats.** The judge sees what the owner was last told about the session, for six hours (`REPEAT_WINDOW_MS`, read back from the returns log after a restart), and sets `repeat` when its note would add nothing. A repeat of the same kind, where Shepherd sent nothing, is not sent or escalated, and is logged with `noticeSuppressionReason: "repeat"`; that includes repeated news while the agent works. A new kind, or anything Shepherd typed, is always sent. When the owner goes to the session, or Shepherd answers it, Shepherd forgets what the owner was told, so the next return is news. The earlier note reaches the judge labelled as untrusted history; the note never asks for codes or secrets, and links in it are dropped.
- **Who hears it.** The owner: the family friend linked to this machine's own user account (a `local` id), the same person Shepherd names as its human. Their relatives do not hear it. On a machine with no such link, such as a server, every family friend hears it. Each person hears it once, even when several friend records share one iMessage handle or Teams user, and a shared group chat never merges two people. The channel is chosen per person by `resolveReachTarget` (`src/heart/reach-channel.ts`) from the senses enabled in `agent.json`, re-read on every send:
  1. The friend's `reachChannel` preference (`bluebubbles` or `teams`), when it is current and that channel is enabled and the friend has an id on it.
  2. Otherwise, the channel of the friend's most recent 1:1 conversation, ranked by when the friend last wrote, never by messages the agent sent.
  3. Otherwise, any reachable channel, BlueBubbles first.

  An ignored preference logs `senses.reach_channel_fallback`. The notice goes to the friend's existing 1:1 chat on that channel, never a group; with none yet, BlueBubbles sends to the friend's handle and Teams opens a 1:1 conversation. Each channel's own proactive path applies its trust check and internal-content guard. Teams uses a bot client of Shepherd's own (the secondary bot when it serves the friend's tenant). BlueBubbles checks the server's signed-in account before sending; a refused account (`host_account_refused`) or a client that cannot be set up (`bluebubbles_unavailable`) keeps the notice pending and retries it. When no family friend is reachable on any enabled channel, Shepherd logs `senses.shepherd_notice_no_target` and retries later.
- **The conversation remembers it.** A delivered notice is saved into the friend's conversation on that channel as an assistant message beginning `[you sent this via Shepherd]`, so the agent knows the words are its own and a reply arrives with context. Every notice ends with "Reply here and I'll pass it on.": an answer meant for the coding session is relayed with `shepherd_send` (Herdr or cmux), from whichever channel it arrives on, after the agent checks the session still shows the agent and folder the notice named. When that conversation is mid-turn, the record waits in `state/outbound-records/` and is added before the friend's next message. A retried batch has the same delivery id and is saved once. The same applies to `send_message`, voice and other proactive sends, labelled by origin.
- **Custody.** The outbox, not the returns log, owns accepted delivery intent.
  Enqueue returns explicit `queued` acceptance or `suppressed` with a policy/shutdown
  reason; persistence failures reject and are logged. The observation audit is
  written after that handoff. Restart recovers existing pending intents without
  turning historical eligible audit rows into new notices. Unknown sends remain
  held for reconciliation, never automatically replayed.
- **Bursts and recovery.** Returns within 5 seconds share one bounded digest per
  recipient. Display the latest observation per stable host/session, at most six
  distinct sessions, and count remaining sessions rather than raw records. All
  represented records retain their relationship to the actual transport receipt,
  even if not individually displayed. Recovered pending observations are labelled
  historical, with their own observation times (or explicitly unknown time), not
  live status. A slow send cannot strand newly accepted work; shutdown starts no
  further sends and preserves the outcome of any send already attempted.
- **What counts.** Every judged return, including errors. A return the loop guard already holds, and a background wait with nothing new, are not judged again and send nothing. A `working` update is sent only when the judge flags news.
- **Untrusted text.** Agent, folder, reply and reason are cut to one bounded line with control characters and anything Teams could read as markup or a mention (`< > [ ] * ~ # | \ @`, backticks) removed, and the message is sent as plain text.
- **Policy.** `senses.shepherd.notify` in `agent.json`: `every` (the default), `needs-me` (gates, finished work and a tripped loop guard) or `off`.

The private escalation to the Ouro agent above is unchanged, so it can still act on gates and deliveries.

Every judgment is one JSON line in `state/senses/shepherd/returns.jsonl` in the agent bundle (directory `0700`, file `0600`, rotated once at 2 MB, never synced): time, host, terminal, transition id, agent, folder, task, kind, action, reason, reply, latency and input tokens.

**Automatic judgments never press menu, navigation or control keys.** This applies
to immediate returns as well as periodic and connectivity-recovery checks.
An explicit owner request through `shepherd_send` remains a separate authority
surface and retains its fresh-screen requirements. Refusing automatic keys does
not qualify the remaining legacy text path or make stored mandates effective on
every trigger.

### Owner-requested input is not proof of recovery

`shepherd_send` returns `submitted` input with a `submission` receipt, not `sent`.
`submission.state: accepted` means the terminal host accepted the paste and
Enter, or the requested key. The coding agent may still have that instruction
queued behind credential approval or other work. The status line says
“submitted for …; receipt unverified”.

The receipt keeps an attempt ID, timestamps, and the observed host, stable
terminal ID, short ref and process instance (or `null` if unavailable). The same
attempt ID is in the existing audit event. Input failures return the original
`attempted` input and `submission.state: unknown`: even a timeout or rejected
paste can follow partially accepted input. There is no automatic resend.
Reconcile the original attempt with the exact receiver before trying again;
changing the request or repeating it is not deduplication.

`verification` separately leaves receipt, execution, capability and useful
progress **unverified**. A successful request, a stale screen, or a later
working indicator does not clear any of these boundaries. A fresh receiver
acknowledgement must match this instruction and target instance after the
attempt; it establishes receipt, not restored credentials or useful progress.
Those need their own current evidence from the affected work. This tool does
not collect receiver acknowledgements or certify recovery, and its receipt is
not updated by subsequent screen reads. Do not report an agent, or all agents,
as unblocked from terminal submission alone.

## Talking to your agent about one session

The independent graphical composer is a short **About** selector, a message box,
and your agent's actual reply, not a terminal inventory. The agent's
`agent.json` `displayName` supplies its labels and attribution; absent that field,
the configured agent identifier is used. "Ouro" is one agent's name, not a name
every installation shares. The composer stays usable while the coding agent is
working and never borrows its input. Open it in cmux with:

```sh
ouro shepherd chat --agent <agent> --web
```

The browser opens beside the current terminal without moving its focus. On first opening, the composer offers the current coding session when cmux can identify exactly one; otherwise choose its short title under **About**. **Refresh** updates session choices without changing the conversation. Once selected, the conversation is pinned to that terminal's stable UUID. Switching terminals or windows does not retarget it. Enter sends; Shift+Enter adds a line. **Cancel <name>** cancels only your supervising agent's reply, not coding work. **Reconnect** checks the authoritative journal without submitting the message again. Unacknowledged messages retain their original session, draft and request ID; About remains locked until their receipt is resolved. The same ID is used in the daemon journal, so recovering after the HTTP listener restarts cannot start that turn twice. New draft edits made while a send is being acknowledged are kept.

The managed Shepherd sense on this Mac also installs a small native **Talk to <name>** entry at `~/.config/cmux/sidebars/ouro-attention-<agent>.swift`. It can be opened as a cmux sidebar pane with `cmux sidebar open ouro-attention-<agent>`; its button opens the same graphical composer. The sense owns this persistent entry; one-off `--web` views do not replace it. This uses the installed cmux Swift interpreter, not a newer JavaScript sidebar API or an unsupported custom right-sidebar mode. No layout or keyboard focus is changed merely because Shepherd starts. The loopback entry is restricted to the existing OS user's local-family identity, with a private entry token and same-origin checks; it is not a remote chat server.

For a terminal-only composer, omit `--web`. `--session <UUID>` explicitly selects
a terminal in either mode. A leading `@<configured name>` or `@<agent identifier>`
is accepted in this independent composer. It does not register native mention
interception inside Copilot, Claude or Codex.

## Feedback from the coding session

With the agent's MCP bridge registered in your coding harness, say the feedback
in that actual coding session, for example:

> Orchid, you should have caught this. It stopped after writing the plan, but I
> asked it to finish the implementation.

The coding agent relays that explicit feedback with the bridge's
`shepherd_feedback` tool and quotes its actual short receipt in the same session.
You do not need to find a surface UUID, reconstruct context in Teams or switch
to the separate composer. This is an MCP conversation interaction, not a claim
that arbitrary `@name` input is intercepted before the coding model sees it.
The bridge must actually be registered and connected; after upgrading, reconnect
it so its tool list includes `shepherd_feedback` and `shepherd_feedback_status`.
The server command for the harness's existing local stdio MCP registration is
`ouro mcp-serve --agent <agent>`. Run it as that coding session's MCP child, not
through a detached shared service that has lost the originating terminal.

The bridge derives its own controlling terminal, and the daemon requires one
matching recognized cmux coding session plus this OS user's existing local-family
identity. The tool cannot choose a different source, actor, agent or recipient.
Detached/remote bridges without a unique local controlling TTY are refused,
not attached to whichever terminal happens to be focused. Native source binding
currently uses POSIX TTYs and cmux stable surface IDs.

The receipt means **received and queued**, not "learned" or "Teams delivered."
It preserves a request ID generated by the coding caller. A retry with that same
ID and identical feedback returns its original receipt and frozen context,
including after the source disappears; a changed request body is refused.
The native receipt is tool output, never terminal input, a submitted coding
prompt or a focus command.

The existing Shepherd sense reviews queued feedback with the supervising agent,
using a bounded, redacted source packet and its actual prior judgment when one
exists. Screen and caller context are background evidence, not instructions.
The review can read that session's history and record/inspect guidance; it cannot
type into terminals, run a shell, start a background ponder or select an external
recipient. Session-only guidance is the default; a broader preference requires
the human's explicit generalization.

The full acknowledgement goes privately to the originating operator on Teams,
not every family friend: what the agent understood, what it actually recorded
or changed and its scope, and any clarification it needs. Feedback requires an
existing unambiguous private Teams identity; absent that route, submission does
not promise a ping it cannot deliver.

Reply to that Teams acknowledgement for clarification. Its actual outgoing
activity ID, private conversation and resolved actor identify the original
feedback, so the agent receives the stored source context without asking you to
repeat it. An explicit full `feedback:<UUID>` reference selects only the same
actor's record in its recorded conversation. Conflicting or ambiguous references
are refused rather than attached to the latest terminal. Ordinary replies to
unrelated messages remain ordinary Teams conversations.

`shepherd_feedback_status` checks the original request without repeating model
work or requiring the source terminal to remain present. Review and transport
custody are separate: pending requests survive restart; interrupted model
execution and unknown Teams acceptance are not automatically replayed. A
definitely-not-sent transport result can retry, while `sent` requires the actual
conversation and message receipt. It is transport acceptance, not a read receipt.

Feedback lives privately under `state/senses/shepherd/feedback/` in the agent
bundle (`0700` directories, `0600` database/receipts). The active queue is bounded
at 512 records; accepted closed deliveries retain keyed immutable receipt
archives for idempotency and clarification, rather than consuming a lifetime
512-submission allowance. Unresolved records are never silently evicted.

## Tools

These are the supervising agent's runtime tools, distinct from the two native
MCP feedback tools above. They appear only for an agent whose `agent.json` has
`senses.shepherd.enabled: true`. Only family trust may call them.

| Tool | What it does |
| --- | --- |
| `shepherd_overview` | Lists every terminal with its agent and the last return Shepherd judged there. |
| `shepherd_read` | Reads one terminal's text, 1 to 400 lines (default 60), redacted and capped at 16,000 characters, with `screen`, a fingerprint of what it shows now. |
| `shepherd_signal` | Sets or clears the one-line status (at most 120 characters) on a terminal's workspace, and can post a desktop notification. |
| `shepherd_send` | Types into one terminal for the human who asked for it: a line, or one key. |

`shepherd_send` lets the human run their coding agents from wherever they talk to the Ouro agent, such as Teams on a phone. It types only for a family friend in their own conversation; the private runtime (the agent on its own) is refused, so it never types on its own initiative. Each call takes exactly one of:

- `text`: one line of at most 2,000 characters with no control characters, typed as `[<configured agent name> for <their name>] <text>` and submitted with Enter, as Shepherd's own answers are.
- `key`: one of `enter`, `escape`, `up`, `down`, `tab`, `ctrl-c`, `1` to `9`, `y` or `n`, pressed alone. `enter`, `tab`, a digit, `y` and `n` can approve or choose on a prompt, so they need the `screen` fingerprint from a `shepherd_read` made just before.

Right before typing it finds the session again (refusing one that is gone) and reads its screen; if a `screen` was passed and the last 20 lines changed since, ignoring numbers, nothing is sent. Unlike Shepherd's own answers, it also types into the terminal the human has focused, because the human asked. Every send emits `repertoire.shepherd_send` (session, ref, agent, character count, key, requesting friend id, focus, whether the screen was checked; never the text) and sets the status line to `sent for <name>`. Every refusal emits `repertoire.shepherd_send_refused` with the reason.

## Turning it on

Shepherd watches one host per machine, named in the agent's machine runtime vault item. The GitHub Copilot app wins over cmux and Herdr, and cmux wins over Herdr.

**GitHub Copilot app.** Add a `copilotApp` record. The app rewrites its local server's port and token in `~/.copilot/run/` on every launch, so Shepherd reads them when it connects and stores no credential. `copilotApp.stateDir` overrides `~/.copilot`:

```sh
ouro vault config set --agent <agent> --scope machine --key copilotApp.stateDir --value "$HOME/.copilot"
```

Shepherd connects as an observer, so the app never routes a session's tool callbacks to it. It differs from the terminal hosts in four ways:

- A return is `session.idle` (when the turn was not stopped by the human), a permission request no hook resolved, a question or plan request, or a terminal error. `assistant.turn_end` is not a return, because the app sends one after every model step.
- The screen is the session's recent conversation, read from `session-state/<id>/events.jsonl`. A reply is a queued message, so it never touches your draft.
- The app does not say which session is on screen. A session counts as yours while the app is frontmost and someone other than Shepherd messaged it in the last five minutes. A turn you stopped yourself is also yours.
- There are no terminal keys. For an owner request, `y` or `1` approves the waiting permission once, `2` approves it for the session, `n` or `3` rejects it, and `ctrl-c` or `escape` stops the turn. The app has no status line, so Shepherd's status stays in its own records. Periodic check-ins are off, because the app cannot show that a session's composer is empty.

**Herdr.** Add a `herdr` record; Herdr's socket is same-user and needs no credential. `herdr.socketPath` overrides the default, `~/.config/herdr/herdr.sock`:

```sh
ouro vault config set --agent <agent> --scope machine --key herdr.socketPath --value "$HOME/.config/herdr/herdr.sock"
```

**cmux.** Shepherd needs the cmux socket credential on this machine. It lives in the agent's machine runtime vault item (`runtime/machines/<machine-id>/config`, key `cmux`), never in the synced bundle.

1. In a terminal inside cmux, store the capability token cmux gives every terminal it starts:

   ```sh
   ouro vault config set --agent <agent> --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"
   ```

   cmux's default `cmuxOnly` socket mode refuses processes it did not start, and the daemon is not a cmux child. The token lets Shepherd in without loosening that mode. If cmux runs in `password` mode, set `cmux.socketPassword` instead. `cmux.socketMode: "automation"` is a last resort. `cmux.socketPath` overrides the default socket, `~/.local/state/cmux/cmux-<uid>.sock`.
2. Set `senses.shepherd.enabled: true` in `agent.json`.
3. Run `ouro up`.

`ouro status` reports the sense as `not_attached` on a machine with no host, `needs_config` when the `cmux` record has no credential (with the command above as the repair), and `running` once the process is up.

## Code

- `src/heart/shepherd-config.ts`: the terminal host connection from machine config, status facts and the repair hint.
- `src/senses/shepherd/host.ts`: the host adapter seam.
- `src/senses/shepherd/cmux.ts` and `client.ts`: the cmux adapter and its socket client.
- `src/senses/shepherd/herdr.ts`: the Herdr adapter and its socket client.
- `src/senses/shepherd/copilot-app.ts`: the GitHub Copilot app adapter and its WebSocket client.
- `src/senses/shepherd/judge.ts`: the judge and the reply safety rules.
- `src/senses/shepherd/sense.ts`: the sense process (checks, answers, escalation); `src/senses/shepherd-entry.ts` is its daemon entry point.
- `src/senses/shepherd/owner-notice.ts`: the owner notice (policy, wording, targets, coalescing, and the BlueBubbles and Teams sends).
- `src/senses/shepherd/returns.ts`: the returns log.
- `src/senses/shepherd/checkin-config.ts` and `checkin-store.ts`: cadence validation, private automatic-input custody and periodic notice signatures.
- `src/senses/shepherd/prompt-state.ts` and `terminal-process.ts`: default-deny rendered input-state classification and current coding-process identity.
- `src/senses/shepherd/redact.ts`: best-effort secret redaction.
- `src/heart/private-runtime/policy.ts`: the `shepherd` private-turn trigger.
- `src/repertoire/tools-shepherd.ts`: the three tools.
