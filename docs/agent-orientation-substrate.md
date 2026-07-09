# Agent Orientation Substrate

This document records the target scope for Ouroboros' agent-facing orientation
substrate after the Arc Flight Recorder pivot and the "don't call it memory"
vocabulary reset.

The goal is not a prettier dashboard. The goal is that an agent can wake up
inside the harness, understand what matters, continue work, and ask for help
without the human rebuilding context.

## Source Inputs

This scope incorporates the website draft at `/blog/dont-call-it-memory`,
especially these rules:

- Memory is the wrong word for active record-keeping, searching, retrieval tools,
  compaction, or prompt-time prefetch.
- Name the verbs and artifacts: write a diary entry, file a fact, consult notes,
  search the record.
- The agent's durable record should be made of things the agent chose to keep,
  not a hidden archive of everything that fell out of context.
- Prompt-time retrieval can be useful, but it is still search moved earlier in
  the pipeline. It must never become the correctness path for continuity.

## Decision Summary

Keep these primitives:

- `arc/`: live continuity, claims, audit receipts, and resume state.
- `desk/`: the agent's durable workspace and maintained record.
- `habits/`: schedule definitions for recurring private sessions.
- `state/`: machine/runtime state and ephemeral session artifacts.

Delete these as active top-level primitives:

- `journal/`
- top-level `diary/`
- top-level `notes/`

No deprecation period. The implementation should make a hard cut: migrate what
is worth keeping, update the tools and prompt, and remove the stale top-level
surfaces. Compatibility migrations may read old paths once, but the runtime
should not keep old and new substrates alive indefinitely.

## Why Diary Moves Into Desk

The old split made sense when `diary/` and `journal/` were the main durable
places an agent could write. It stops making sense once `desk/` is real.

Desk is the agent's durable orientation room. It should contain not only active
work but also the record artifacts that help future-me work well:

- tasks and projects;
- friction;
- lessons;
- facts learned over time;
- reference notes.

Diary still has a real job: atomic learned facts, daily reflection, and entity
records. What should go away is not the diary. What should go away is `diary/`
as a separate top-level room the agent must remember to route to.

This is a record, not memory. The agent writes diary entries, files facts,
consults notes, and searches the record. These are active verbs over maintained
artifacts. Do not teach the agent that it has "memory" here; that word distorts
the self-model and hides the real responsibility to write down what should
survive the context wheel.

Target shape:

```text
desk/
  <track>/
    track.md
    <task>/task.md
    <task>/iterations/...
  _friction/
  _meta/
    tips/
    featured.md
  _record/
    diary/
      facts.jsonl
      entities.json
      daily/
    notes/
      *.md
      .index.json
```

In other words:

```text
desk/                 what i am doing and the record i maintain
desk/_record/diary/   what i chose to write down as learned facts/reflections
desk/_record/notes/   reusable reference notes i maintain and consult
arc/                  what is live, owed, claimed, audited, or resumable
habits/               when private recurring sessions fire
state/                runtime machinery and throwaway session records
```

Desk search should cover tasks, friction, lessons, diary entries, facts, and
notes. Arc should reference Desk records by locator instead of duplicating them.

## Journal Is Deleted

`journal/` does not keep a distinct authority.

If something is current operational state, it belongs in Arc. If it is active
work or a draft attached to work, it belongs in Desk. If it is a durable learned
fact, it belongs in the Desk record diary. If it is reusable reference, it
belongs in Desk record notes. If it is just scratch thinking, it can stay in the
throwaway session transcript and disappear.

So the target is to remove:

- `journalSection()` prompt rendering;
- `journal-index.ts`;
- journal search from pre-turn retrieval and record lookup;
- all prompts that teach the agent to journal as a normal durable move;
- `journal/` from new bundle templates.

Useful existing journal content should be migrated into Desk tasks, the Desk
record diary, or Desk record notes. Everything else should be dropped.

## Record, Diary, And Notes

Diary and notes remain distinct record kinds, but both live under Desk.

Diary:

- atomic facts;
- conclusions the agent learned;
- daily reflection;
- entity index;
- provenance and trust labels;
- deduplication and embedding search.

Notes:

- canonical markdown reference;
- longer reusable explanations;
- stable self notes;
- semantic search via the notes-native index.

Tool names must use active verbs and concrete artifacts:

- `diary_write` writes to `desk/_record/diary`;
- `consult_diary` reads or seeks diary entries;
- `search_facts` searches the fact/entity record;
- `consult_notes` searches Desk record notes;
- `desk_search` searches work plus record artifacts.

If a tool name becomes misleading during implementation, replace it outright.
Do not keep alias tools around as permanent compatibility debt. In particular,
do not preserve a generic "memory" vocabulary, and do not keep a generic
all-record search name that claims to search every durable thing.

## Prompt-Time Retrieval

Prompt-time retrieval is allowed only as an optimization, not as the truth
contract.

The harness may assemble selected Desk/Record snippets into the prompt when
they are attached to the current friend, task, Arc locator, or active surface.
Similarity-assisted prefetch may save a tool round trip, but it is still search:
a guess based on an index. It is not memory, and it is not allowed to become the
only way important state survives.

The correctness path is:

1. The agent writes the important thing to Arc or Desk when it happens.
2. Arc points at the next action, obligation, claim, and relevant Desk locators.
3. Prompt assembly loads Arc and the current Desk orientation deterministically.
4. Explicit tools let the agent consult or search deeper records when needed.

If the context window is wiped randomly, the agent should resume from Arc plus
Desk without needing a prior transcript, hidden archive, or lucky semantic hit.

## Arc

Arc owns live continuity and evidence, not durable knowledge shelves.

Arc stores:

- Flight Recorder events and `latest.json`;
- context-loss Sentinel receipts under
  `arc/flight-recorder/context-loss-sentinel/`;
- current ask and next safe action;
- obligations and return obligations;
- claims and evidence status;
- habit run receipts;
- audit facts;
- pointers into Desk for tasks, lessons, diary facts, and notes.

Arc does not store full transcripts, raw tool output, long reference notes, or
project task bodies.

Arc is the primitive that makes context loss survivable. The agent must keep Arc
fresh as a general habit, not only when it predicts a high-token operation. Each
material turn should leave Arc able to answer:

- what am I doing?
- what did I promise?
- what is the next safe action?
- what have I claimed, and is it evidenced?
- which Desk/Record artifacts carry the details?

This is why Arc is not diary and not Desk. Arc is the live flight recorder. Desk
is the durable room and maintained record. A randomly overwritten session
continues from Arc's latest truth and follows its locators into Desk.

## Context-Loss Sentinel

Sentinel is the deterministic guardrail that checks whether Arc and Desk are
actually enough to recover after a context wipe. It exists because agents should
keep Arc current as a general habit, not only when they predict a large prompt
or long tool run.

Sentinel receipts live at:

```text
arc/flight-recorder/context-loss-sentinel/latest.json
arc/flight-recorder/context-loss-sentinel/latest-ready.json
arc/flight-recorder/context-loss-sentinel/history/YYYY-MM-DD.jsonl
arc/flight-recorder/context-loss-sentinel/receipts/<receiptId>.json
```

`latest.json` is the current truth about recovery readiness. It may be blocked.
That is useful: a fresh agent needs to know the present failure.

`latest-ready.json` is the last-known-good recovery anchor. It survives provider
outages, missing credentials, daemon/sense warnings, dirty bundle state, and
other current risks. It is not trusted merely because it is shape-valid; it must
be semantically ready and contain a safe resume snapshot.

Provider-down behavior is explicit:

- failed live checks and missing credentials become provider-lane signals with
  source, severity, repair actor, and repair command when available;
- unknown readiness after a process reset stays unknown unless there is fresh or
  persisted evidence;
- stale readiness is only stale when a supplied readiness source says so;
- if provider/sense/bundle risk is the only blocker, recovery points to
  latest-ready;
- if the current Flight Recorder gauntlet fails, Sentinel keeps that current
  blocker visible instead of masking it with an older ready anchor.

Workbench history is a projection over these receipts. It is allowed to be
beautiful and useful, but it is not the source of truth and does not refresh
Sentinel by reading.

`history/YYYY-MM-DD.jsonl` is the append-only durable Sentinel ledger. Individual
`receipts/<receiptId>.json` detail files are a bounded recent-detail cache:
Sentinel keeps the newest detail files plus the current/latest-ready receipts
and prunes older duplicates during mutating refreshes so agent bundles do not
grow without limit.

## Habits

A habit is Ouro-native cron: a schedule that starts a private session.

Target habit run:

```text
cron/launchd/manual poke
  -> private habit session
  -> read Arc resume + Desk orientation
  -> execute bounded habit body
  -> write durable outputs to Arc or Desk
  -> create habit run receipt
  -> throw away transcript unless needed for debugging
```

Habit definitions stay in top-level `habits/` because they are schedule inputs,
not work records.

Every habit run writes an audit receipt in Arc:

```ts
interface HabitRunReceipt {
  schemaVersion: 2
  runId: string
  sessionId: string
  habitName: string
  trigger: "cron" | "launchd" | "poke" | "overdue" | "manual"
  startedAt: string
  endedAt: string
  outcome:
    | "no_change"
    | "wrote_arc"
    | "updated_desk"
    | "wrote_record"
    | "surfaced"
    | "blocked"
    | "error"
  definitionLocator: string
  sessionLocator: string
  pendingLocator: string
  runtimeStateLocator: string
  receiptLocator: string
  nextRunAt: string | null
  permissionEnvelope: {
    schemaVersion: 1
    canMessageOutward: boolean
    returnRoutes: Array<{
      kind: "family" | "originator" | "extra"
      recipient: string
      status: "allowed" | "unresolved"
      friendId?: string
      channel?: string
      key?: string
      reason?: string
    }>
    deniedTools: string[]
    warnings: string[]
  }
  toolPolicy: {
    requestedTools: string[] | null
    grantedTools: string[]
    deniedTools: string[]
    outwardMessagingAllowed: boolean
  }
  producedRefs: Array<{
    kind: "arc" | "desk_task" | "desk_record" | "claim" | "surface" | "none"
    locator: string
  }>
  surfaceAttempts: Array<{
    recipient: string
    channel: string
    reason: "needed_input" | "status" | "answer" | "blocked" | "other"
    result:
      | "sent"
      | "delivered"
      | "delivered_now"
      | "queued"
      | "deferred"
      | "blocked"
      | "failed"
      | "unavailable"
    rawStatus?: string
    routeKind?: "family" | "originator" | "extra"
    error?: string
  }>
  errors: string[]
}
```

This audit log is not a permission bureaucracy. It is the durable record of
what happened. After a context wipe, the agent should be able to reconstruct the
latest habit run from Arc habit receipts plus `state/habits/<habit>.json`
runtime state without loading the private session transcript.

## Habit Surfacing

Habits can surface by default to:

- family;
- the habit originator;
- explicit recipients listed in the habit file.

This is an allowed-recipient set, not a broadcast requirement. A habit should
message only when it has a concrete reason: needed input, status that was asked
for, answer to the originator, or a real blocker.

Minimal habit shape:

```yaml
title: inbox triage
cadence: 30m
status: active
origin:
  friendId: ari
  channel: bluebubbles
  key: session-or-thread
surface:
  family: true
  originator: true
  extra: []
```

Default surfacing when `surface` is omitted:

```yaml
family: true
originator: true
extra: []
```

Unsafe or irreversible external actions still require their normal tool-level
confirmation rules. The habit surfacing default only answers "who may this
private session contact when it needs help or needs to report back?"

## Private Runtime

Private runtime is the policy-gated execution path for private agent-facing
turns. It is not a record substrate and not memory. It may use the `inner`
provider/model lane for provider selection, but that lane is not the runtime.

It runs:

- habit sessions;
- private return work;
- awaits;
- self-maintenance checks;
- bounded private exploration.

Its transcript can be throwaway because the things that matter leave the lane:

- live continuity and audit -> Arc;
- work and task state -> Desk;
- learned facts -> Desk record diary;
- reference notes -> Desk record notes;
- outward messages -> the relevant sense.

Private runtime is where a habit or private turn can do bounded work. Arc and
Desk are how it remains true afterward. Private runtime is allowed to be
habit-driven, private, and throwaway; that is only safe because record-worthy
outputs are written explicitly before the transcript falls away.

## Implementation Cut

The cut should be implemented as one coherent migration, not a long deprecation.

Required changes:

1. Add Desk record paths and readers/writers.
2. Move diary store resolution from top-level `diary/` to
   `desk/_record/diary/`.
3. Move canonical notes from top-level `notes/` to `desk/_record/notes/`.
4. Remove journal prompt rendering and journal search/indexing.
5. Remove `journal/` from new bundle templates.
6. Replace note-search injection with Desk record orientation and explicit
   consult/search tools.
7. Remove prompt language that calls diary, notes, retrieval, or continuity
   "memory."
8. Update habit runs to write Arc receipts.
9. Update habit session startup to read Arc resume and Desk orientation.
10. Encode habit originator and lightweight surfacing defaults.
11. Update README, prompt, tests, and migration hooks in the same PR.

Completion criteria:

- new bundles contain no top-level `journal/`, `diary/`, or `notes/`;
- old bundles migrate valuable `diary/` and `notes/` content into Desk record;
- old `journal/` content is either migrated or quarantined, with a migration report;
- no prompt tells the agent that journal is its desk;
- no prompt or tool description calls the record "memory";
- prompt assembly loads Arc and current Desk orientation deterministically;
- prompt-time retrieval, if retained, is described as retrieval/search and is
  not required for context-loss recovery;
- Desk MCP search can find tasks, lessons, diary facts, and notes;
- habit runs always create Arc receipts;
- a habit can message family or its originator without special grant setup;
- context-loss drills can recover current work from Arc and Desk without
  reading old inner-lane transcripts or evicted context archives.

## Non-Goals

- Do not make Desk the source of live execution truth. Arc owns live continuity.
- Do not store raw transcripts in Arc or Desk record by default.
- Do not keep journal as "legacy scratch" in the active prompt.
- Do not preserve old top-level paths as permanent aliases.
- Do not make habit surfacing a heavy policy engine.
- Do not call record/search/retrieval/compaction "memory."
