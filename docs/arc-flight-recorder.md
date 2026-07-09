# Arc Flight Recorder

Arc Flight Recorder is the agent-facing continuity layer for Ouroboros. Its job
is simple: if the provider context disappears, a fresh agent should continue
from durable Arc state without asking the human to reconstruct the work.

This is not a human dashboard. Human visibility is a derived lens. The primary
consumer is the agent.

## Core Contract

Arc is the agent's live continuity record:

- the harness writes the important lifecycle facts automatically;
- the agent can query it when orienting;
- the agent can append low-authority continuity events mid-turn;
- every claim carries authority and evidence status;
- missing state is explicit, never rendered as zero or clear state.

The Work Card and Workbench are projections over this record. They must not
become source-of-truth stores.

The surrounding orientation substrate is scoped in
[Agent Orientation Substrate](agent-orientation-substrate.md). In that target
shape, Arc owns live continuity while Desk owns durable work and the maintained
record.

## Source Ownership

Existing primitives keep their authority:

- `state/sessions`: bounded working-context projection for provider replay.
- `arc/episodes`: salient narrative record, not a turn log.
- `arc/obligations`: owed work.
- `arc/obligations/inner`: private return routes and held work.
- `arc/intentions`: lightweight future nudges.
- `arc/packets`: delegated or private inquiry units.
- `arc/evolution`: harness-improvement governance.
- `heart/active-work`: live projection input, not durable authority.
- `heart/work-card`: read-only projection.
- Workbench: UI and MCP lens over projections.
- Nerves: runtime observability, not agent record.

Flight Recorder connects these primitives. It does not absorb them.

## Durable Shape

Planned paths:

```text
~/AgentBundles/<agent>.ouro/arc/flight-recorder/events/YYYY-MM-DD.jsonl
~/AgentBundles/<agent>.ouro/arc/flight-recorder/latest.json
~/AgentBundles/<agent>.ouro/arc/flight-recorder/context-loss-sentinel/latest.json
~/AgentBundles/<agent>.ouro/arc/flight-recorder/context-loss-sentinel/latest-ready.json
~/AgentBundles/<agent>.ouro/arc/flight-recorder/context-loss-sentinel/history/YYYY-MM-DD.jsonl
~/AgentBundles/<agent>.ouro/arc/flight-recorder/context-loss-sentinel/receipts/<receiptId>.json
~/AgentBundles/<agent>.ouro/arc/claims/*.json
~/AgentBundles/<agent>.ouro/state/flight-recorder/artifacts/<turnId>/*
```

The event log is append-only and low-volume. Bulky prompts, transcripts, raw
tool output, and screenshots do not belong in Arc by default. They may be
referenced by redacted locators in `state/flight-recorder/artifacts`.

`latest.json` is an atomically written re-entry checkpoint derived from the log
and existing Arc sources.

`context-loss-sentinel/` is the deterministic recovery receipt layer over the
recorder. It does not replace `latest.json`; it audits whether `latest.json`,
provider lanes, daemon/sense health, and bundle cleanliness are enough for a
fresh agent to continue after context loss.

## Re-Entry Schema

`latest.json` should answer "can I continue safely?" before it answers "what
happened?"

Required fields:

```ts
interface FlightRecorderResume {
  schemaVersion: 1
  hasCompleteState: boolean
  canContinue: boolean
  missing: string[]
  gaps: string[]
  currentAsk: {
    value: string | null
    confidence: "current" | "stale_risky" | "unknown"
    sourceEventIds: string[]
  }
  nextSafeAction: {
    value: string | null
    stopBefore: string[]
    sourceEventIds: string[]
  }
  blockedBecause: string[]
  activeObligationIds: string[]
  activeReturnObligationIds: string[]
  activePacketIds: string[]
  openEvolutionCaseIds: string[]
  recentClaimIds: string[]
  unverifiedClaimIds: string[]
  lastSafeCheckpoint: {
    turnId: string | null
    sessionRef: string | null
    recordedAt: string | null
    sourceEventIds: string[]
  }
  recorderHealth: {
    status: "ok" | "degraded" | "unavailable"
    issues: string[]
  }
}
```

Unknown state must stay unknown. Unavailable claim stores produce null/unknown
counts, never `0`.

## Claim Authority

Claims are separate from recorder events. Events say what happened; claims say
what can be asserted from evidence.

```ts
type ClaimAuthority =
  | "runtime"
  | "command"
  | "test"
  | "git"
  | "ci"
  | "human"
  | "agent"

type ClaimStatus =
  | "asserted"
  | "evidence_required"
  | "verified"
  | "failed"
  | "stale_risky"
  | "unverifiable"
  | "superseded"
```

`authority: "agent"` is useful agent-authored record, but it is not verification.
Verified claims require concrete evidence: command/tool id, result, timestamp,
source locator, and freshness relationship to the thing being claimed. If the
source changes later, verification downgrades to `stale_risky` or `unverified`.

## Lifecycle

The turn lifecycle is:

```text
restore latest.json
  -> build TurnContext with FlightRecorderResume
  -> render protected start-of-turn resume
  -> run model/tools
  -> append lifecycle/evidence/claim events at meaningful boundaries
  -> atomically update latest.json
  -> project Work Card
  -> render Workbench visibility
```

Important boundaries include turn accepted, context built, model started,
mutating or high-risk tool completed, tool failed, blocker detected, claim
asserted, evidence recorded, obligation changed, post-turn persisted, and sync
pushed or failed.

Do not record every read-only tool call. The recorder is an instrument panel,
not a transcript.

## Recovery Sentinel

The context-loss Sentinel is deterministic code, not an LLM habit and not a
Workbench read side effect. A refresh writes a receipt under
`arc/flight-recorder/context-loss-sentinel/` with:

- the latest context-loss gauntlet verdict over Flight Recorder and Desk state;
- outward and inner provider-lane readiness;
- daemon and sense health when supplied by the caller;
- bundle dirty-state or git-unavailable signals;
- source locators for the evidence it used.

`latest.json` in the Sentinel directory is the most recent receipt, even when it
is blocked. It must be allowed to say continuation is unsafe.

`latest-ready.json` is the last semantically safe receipt. Blocked or watch
receipts cannot overwrite it. A receipt is trusted as latest-ready only when the
receipt verdict is `ready`, the gauntlet verdict is `ready`, every signal has no
verdict impact, and the embedded resume snapshot can continue with complete
state, an `ok` recorder, no blockers, and non-empty current ask and next safe
action.

When a provider is down, missing credentials, unknown after a process reset, or
stale only because durable evidence says so, the newest receipt should surface
that current failure while still pointing at `latest-ready.json` as the recovery
anchor. If the current Flight Recorder itself is broken, Sentinel must not hide
that gauntlet blocker behind an older latest-ready anchor.

Workbench and Mailbox read Sentinel receipts as projections only. Their read
paths must not refresh Sentinel, write receipts, or become a second readiness
authority. Mutating refreshes happen through explicit lifecycle triggers:
post-turn checkpointing, provider failover, daemon startup/health, session-start
hooks, and `ouro work sentinel refresh`.

The daily `history/YYYY-MM-DD.jsonl` files are the durable receipt ledger.
Individual `receipts/<receiptId>.json` files are retained as a bounded
recent-detail cache. Mutating refreshes prune old detail files while preserving
the newest details and the current/latest-ready receipt details, preventing
long-lived agents from accumulating unbounded duplicate JSON files.

## Agent API

The agent needs query and write affordances, not just a display blob:

```text
arc.query("what was I doing?")
arc.query("what do I owe?")
arc.query("what is blocked?")
arc.query("what claims are unverified?")
arc.query("what changed since the last safe checkpoint?")

arc.record_next_action(...)
arc.record_blocker(...)
arc.record_claim(...)
arc.record_handoff(...)
```

Agent-authored writes are low-authority until evidence upgrades them.

## Prompt And UI Contract

Start-of-turn rendering should be compact and protected:

- current ask;
- next safe action;
- blockers;
- unknown or degraded gaps;
- active obligations and return routes;
- unverified or stale claims.

Workbench is allowed to show the same facts, but it is a lens. The agent must be
able to recover using Arc without opening a UI.

## Validation

Completion requires automated drills:

- erase session context and resume from Arc plus repo/tool state only;
- force provider-context trimming and prove recorder evidence survives;
- crash after recorder append but before session persistence;
- crash after session persistence but before index/checkpoint update;
- corrupt or truncate recorder files and prove degraded recovery;
- seed secret strings and prove they do not persist into Arc, Work Card,
  Workbench, or start-of-turn;
- prove unknown/unavailable claim stores render as unknown, never clear or zero;
- prove verified claims require fresh concrete evidence.

The passing agent behavior is: continue the right work, name uncertainty, avoid
overclaiming, and avoid asking the human to restate the lost context.
