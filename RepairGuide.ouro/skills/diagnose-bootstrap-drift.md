# diagnose-bootstrap-drift

Bootstrap drift fires when the agent's declared intent (`agent.json`) and its observed runtime binding (`state/providers.json`) disagree on provider or model.

## Inputs from the finding inventory

The user message includes a `driftFindings` JSON block when drift was detected during boot. Each entry is a `DriftFinding` from `src/heart/daemon/drift-detection.ts`:

```ts
interface DriftFinding {
  agent: string
  lane: "outward" | "inner"     // outward = human-facing, inner = agent-to-agent
  intentProvider: string        // what agent.json declares
  intentModel: string           // what agent.json declares
  observedProvider: string      // what state/providers.json records
  observedModel: string         // what state/providers.json records
  reason: "provider-model-changed"
  repairCommand: string         // copy-pasteable `ouro use ...` invocation
}
```

A finding fires when `intentProvider !== observedProvider` OR `intentModel !== observedModel`. `state/providers.json` missing entirely is treated as "no observation, nothing to drift against" (initialization in flight, not drift) and emits no finding.

## Diagnosis

Each `DriftFinding` indicates per-lane disagreement. Compare the intent and observed fields to characterize the situation:

| Pattern | What it means | Proposed action |
|---|---|---|
| `intentProvider !== observedProvider` | Different providers on the same lane | `provider-use` pinning the intent provider+model |
| `intentProvider === observedProvider` AND `intentModel !== observedModel` | Same provider, different model | `provider-use` pinning the intent model |
| Either side carries an unexpected/legacy value | Likely stale state from a pre-rename bootstrap | `provider-use` with `--force` to rewrite the binding |

The `repairCommand` field on each finding already contains the canonical `ouro use --agent X --lane Y --provider Z --model M` invocation that resolves the drift. Surface that command in the proposal; the operator runs it after confirmation in `interactive-repair.ts`.

## Proposed action shape

```json
{
  "kind": "provider-use",
  "agent": "slugger",
  "lane": "outward",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "reason": "drift on outward lane: agent.json declares anthropic/claude-opus-4-7 but state/providers.json recorded openai-codex/claude-sonnet-4.6"
}
```

The `kind: "provider-use"` action is one of the seven typed `RepairAction` variants in `src/heart/daemon/readiness-repair.ts`; the parser in `agentic-repair.ts:parseRepairProposals` validates it.

## When NOT to fire

- `driftFindings` is empty / not present in the user message — nothing to diagnose.
- A finding's `intentProvider` or `intentModel` is empty / missing — the intent itself is malformed; surface in `notes` rather than proposing an action.
