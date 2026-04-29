# Layer 3 — RepairGuide library bundle + loader + `kind: library` exclusion + override-path removal

Fourth and final PR in the sequential rollout (1 → 4 → 2 → 3). Builds on:
- Layer 1 (`#644`) — rollup vocabulary + `computeDaemonRollup`
- Layer 4 (`#645`) — `detectProviderBindingDrift` + drift advisories
- Layer 2 (`#646`) — `runBootSyncProbe` + sync-classification taxonomy

This PR composes those four substrates into the operator-facing repair surface.

## Summary

Four distinct things land together because they all trade in the same `kind: library` mechanism:

1. **`RepairGuide.ouro/` library bundle** — sibling to `SerpentGuide.ouro/` at repo root. Ships `agent.json` (`enabled: false`, `kind: "library"`), `psyche/SOUL.md`, `psyche/IDENTITY.md`, and five diagnostic skills under `skills/`. Content-only, never spawned.
2. **Loader integrated into `src/heart/daemon/agentic-repair.ts`** — reads `RepairGuide.ouro/{psyche,skills}/*.md` and prepends them to the existing one-shot LLM diagnostic call. The LLM emits a `\`\`\`json` block; `parseRepairProposals` extracts typed `RepairAction[]` from the existing catalog. v1 introduces no new action kinds.
3. **`kind: library` agent-discovery exclusion** — `agent.json` gains an optional `kind` field. `listEnabledBundleAgents` and `listBundleSyncRows` skip bundles with `kind === "library"`. SerpentGuide.ouro retroactively tagged.
4. **`~/AgentBundles/` override-path removal** — `getSpecialistIdentitySourceDir()` no longer reads the user-customizable override; in-repo is the only source.

## Activation contract (LOCKED — planning O4)

The pre-existing gate at `cli-exec.ts:6854` was `if (untypedDegraded.length > 0)`. This PR replaces it with `shouldFireRepairGuide({ untypedDegraded, typedDegraded, noRepair })`, which fires when:
- `noRepair === true` → false (escape hatch); OR
- `untypedDegraded.length > 0` (preserves today's behavior); OR
- `typedDegraded.length >= 3` (compound stacking — the new path).

Threshold of 3 (not 2) prevents common pairs like `vault-locked + provider-auth-needed` from firing on every boot. Encoded once in `shouldFireRepairGuide`; never duplicated.

`--no-repair` is the existing escape hatch (`cli-parse.ts:1435`, `cli-exec.ts:6621,6680`). No new env knob.

## What's in the diff

### New files
- `RepairGuide.ouro/agent.json` — `{"version": 2, "enabled": false, "kind": "library"}`
- `RepairGuide.ouro/psyche/SOUL.md` — orientation: "structured proposals only, never an actor"
- `RepairGuide.ouro/psyche/IDENTITY.md` — diagnostician persona
- `RepairGuide.ouro/skills/diagnose-bootstrap-drift.md` — consumes Layer 4 `DriftFinding[]`
- `RepairGuide.ouro/skills/diagnose-broken-remote.md` — consumes Layer 2 sync findings (404, auth-failed, network-down)
- `RepairGuide.ouro/skills/diagnose-sync-blocked.md` — consumes Layer 2 sync findings (dirty-working-tree, non-fast-forward, merge-conflict). NEW — split out from broken-remote per O2.
- `RepairGuide.ouro/skills/diagnose-vault-expired.md` — consumes existing `credential-revision-changed` signal
- `RepairGuide.ouro/skills/diagnose-stacked-typed-issues.md` — catch-all for `typedDegraded >= 3`
- `src/__tests__/heart/daemon/agent-discovery-kind.test.ts` — `kind: library` exclusion behavior
- `src/__tests__/heart/daemon/serpentguide-library-kind.test.ts` — SerpentGuide tagged retroactively
- `src/__tests__/heart/daemon/repair-guide-loader.test.ts` — `loadRepairGuideContent` (12 tests, edge cases incl. missing bundle, empty dirs, partial content)
- `src/__tests__/heart/daemon/repair-guide-activation.test.ts` — `shouldFireRepairGuide` (9 tests, all branches of the contract)
- `src/__tests__/heart/daemon/repair-proposal-parser.test.ts` — `parseRepairProposals` (18 tests, all 7 action kinds + unknown + malformed)
- `src/__tests__/heart/daemon/agentic-repair-with-repairguide.test.ts` — wiring tests (14 tests, content prepending, fallback paths, gate placement)
- `src/__tests__/heart/daemon/slugger-compound.test.ts` — canonical acceptance fixture (10 tests, four overlapping findings + healthy peer)

### Modified files
- `SerpentGuide.ouro/agent.json` — `"kind": "library"` added (architectural reason now)
- `src/heart/daemon/agent-discovery.ts` — `BundleAgentRow.kind?: string`, `isLibraryKind` predicate, filter applied in `listEnabledBundleAgents`
- `src/heart/daemon/agentic-repair.ts` — `loadRepairGuideContent`, `shouldFireRepairGuide`, `parseRepairProposals`, `forceDiagnosis`/`repoRootOverride` deps, `tryAgenticDiagnosis` prepends RepairGuide content and routes proposals through the typed catalog
- `src/heart/daemon/cli-exec.ts` — gate at `cli-exec.ts:6864` switched from bare `if (untypedDegraded.length > 0)` to `shouldFireRepairGuide({...})`
- `src/heart/daemon/cli-defaults.ts:451` — comment refreshed to note the override removal
- `src/heart/hatch/hatch-specialist.ts` — `getSpecialistIdentitySourceDir` no longer reads `~/AgentBundles/SerpentGuide.ouro/psyche/identities`; in-repo only
- `src/__tests__/heart/hatch/hatch-specialist.test.ts` — override-path test rewritten as positive "always returns __dirname-relative path"
- `src/__tests__/heart/hatch/hatch-flow.test.ts` — fixture pivoted from override path to explicit `specialistIdentitySourceDir` injection
- `src/__tests__/heart/daemon/daemon-cli.test.ts` — `agentic-repair` mock extended with `shouldFireRepairGuide`

## RepairGuide loader behavior

`loadRepairGuideContent(repoRoot)` returns a structured `{ psyche, skills }` shape, OR `null` on:
- Missing `RepairGuide.ouro/` directory (the bundle isn't installed — graceful, caller falls back to today's text-blob diagnostic).
- I/O errors (`readdirSync` / `readFileSync` throws).

When the bundle exists but is partially populated (e.g. `psyche/IDENTITY.md` missing, or empty `skills/`), the loader returns a populated object with the fields it could read. `tryAgenticDiagnosis` then prepends only what's available — no `psyche/IDENTITY.md`, no IDENTITY section in the prompt.

When the bundle exists but every directory is empty, the prepend reduces to zero sections and the system prompt falls back to `buildSystemPrompt(degraded)` unchanged.

## LLM output parsing

The persona content (`SOUL.md`) instructs the model to emit exactly one `\`\`\`json` fenced block:

```json
{
  "actions": [{ "kind": "...", "agent": "...", "reason": "..." }],
  "notes": ["..."]
}
```

`parseRepairProposals`:
- Extracts the first JSON block (or bare `{...}`); JSON-parses it.
- Walks `actions[]`, dropping entries with unknown `kind` or shaped wrong (with warnings).
- Backfills `label`, `command`, and `actor` so the result plugs into `interactive-repair.ts`.
- Returns `fallbackBlob: <raw output>` when no JSON can be extracted at all — preserves today's text-blob behavior.

## Coverage

100% on all new/modified code paths in `agent-discovery.ts`, `agentic-repair.ts`, `hatch-specialist.ts`. Slugger-compound fixture exercises Layer 1 (rollup → `partial`), Layer 2 (404 + dirty classifications), Layer 4 (drift finding), and Layer 3 (gate + parser).

## Activation gate snapshot (from cli-exec.ts:6864)

```ts
const repairGuideShouldFire = shouldFireRepairGuide({
  untypedDegraded,
  typedDegraded,
  noRepair: Boolean(command.noRepair),
})
if (repairGuideShouldFire) {
  const repairInput = [...untypedDegraded, ...typedDegraded]
  const forceDiagnosis = untypedDegraded.length === 0 && typedDegraded.length >= 3
  const repairResult = await runAgenticRepair(repairInput, { ..., forceDiagnosis })
}
```

`forceDiagnosis: true` is set only when the gate fired solely on typed-stacking — this bypasses `runAgenticRepair`'s pre-existing typed-only early-return so the diagnostic LLM call still fires with RepairGuide content.

## Visibility check

- RepairGuide is a `kind: library` bundle that lives in the repo root, not under `~/AgentBundles/`. `agent-discovery.ts` walks `getAgentBundlesRoot()` (= `~/AgentBundles/`), so RepairGuide is never enumerated even if a future operator symlinks the bundle into that directory — the `kind: library` filter in `listEnabledBundleAgents` is the architectural defense.
- SerpentGuide.ouro keeps `enabled: false` AND gains `kind: library`. The architectural reason is now `kind: library`; `enabled: false` survives for back-compat with anything still reading it.

## Test plan

- `npm test` — full suite green (350+ tests across daemon-cli + hatch + slugger-compound).
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run release:preflight -- --base-ref origin/main` — pass.

## Cross-cutting verification

- `ouro up --no-repair` short-circuits the gate (`shouldFireRepairGuide` returns `false`), surfaces structured per-agent diagnostics, exits 0.
- `ouro up` boot does not hang on any of the slugger-fixture failure modes (Layer 2's `runWithTimeouts` enforces this at 8s soft / 15s hard per agent).
- `ouro status` does NOT list RepairGuide regardless of internal state (filter via `listEnabledBundleAgents`).
- Override-pattern grep clean: `grep -rn "AgentBundles.*SerpentGuide.*identities"` returns only the cli-defaults.ts comment describing the removal and the test fixtures asserting the override is ignored.

## What this is NOT

- Not a chat loop. The diagnostic call is one-shot.
- Not an actor. RepairGuide proposes only; `interactive-repair.ts` runs the actions on operator confirmation.
- Not an agent. RepairGuide is `kind: library` — content-only.
- Not a new repair-action catalog. v1 reuses the existing seven kinds (`vault-create`, `vault-unlock`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use`).

## Dependencies

Cut this branch from main only after Layers 1, 4, and 2 land. Verified in Unit 0.
