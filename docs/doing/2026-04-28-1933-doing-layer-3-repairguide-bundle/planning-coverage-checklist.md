# Planning Coverage Checklist

**Source**: `../planning/2026-04-28-1900-planning-harness-hardening-and-repairguide.md`
**Generated**: 2026-04-28 19:34 UTC during Pass 5 (Planning Coverage Check) of the four doing-doc conversion.

This file lives in the layer 3 artifacts directory because layer 3 is the PR that brings everything together; the per-layer coverage cross-references are aggregated here for the canonical lookup.

## In Scope items

| Planning Scope item | Doing PR | Doing Unit(s) | Status |
| --- | --- | --- | --- |
| Layer 1 — five-state rollup vocabulary | doing-layer-1 | Units 1a–1c, 2a–2c, 3a–3c, 4a–4c, 5, 6 | ✅ |
| Layer 1 — fix overloaded promotion at `daemon-entry.ts:164` | doing-layer-1 | Unit 3b (cites line 164 directly) | ✅ |
| Layer 1 — leave `cli-exec.ts:287` per-agent loop alone | doing-layer-1 | Stated in Objective; reinforced in Unit 3b | ✅ |
| Layer 1 — update `DaemonHealthState.status` + consumers | doing-layer-1 | Units 1b, 4a–4c | ✅ |
| Layer 2 — wire `preTurnPull` into `ouro up` | doing-layer-2 | Units 3a–3c, 4a–4c | ✅ |
| Layer 2 — sync probe BEFORE per-agent live-checks | doing-layer-2 | Unit 4b explicitly orders this | ✅ |
| Layer 2 — gate on each bundle's `sync.enabled: true` | doing-layer-2 | Unit 4a–4b (uses `listBundleSyncRows`) | ✅ |
| Layer 2 — surface (not crash) on 404, no-network, dirty, non-FF, conflict, auth-failed | doing-layer-2 | Unit 1a (taxonomy classifier covers all 6) | ✅ |
| Layer 2 — hard timeouts on git fetch / pull (LOCKED 8s/15s) | doing-layer-2 | Units 2a–2c (`runWithTimeouts`), Unit 3a–3c (preTurnPull AbortSignal) | ✅ |
| Layer 2 — never touch `state/` | doing-layer-2 | Unit 7 (no-write-to-state guard with grep) | ✅ |
| Layer 3 — `RepairGuide.ouro/` library bundle | doing-layer-3 | Unit 3 (build skeleton) | ✅ |
| Layer 3 — sibling to `SerpentGuide.ouro/`, ships with repo | doing-layer-3 | Unit 3 | ✅ |
| Layer 3 — loaded as content into `agentic-repair.ts` | doing-layer-3 | Units 4a–4c (loader), 7a–7c (wire-in) | ✅ |
| Layer 3 — RepairGuide NOT picked up by `agent-discovery.ts` | doing-layer-3 | Units 1a–1c (`kind: library` filter) | ✅ |
| Layer 3 — confirmed absent from `listEnabledBundleAgents`, `ouro status`, daemon spawn, `degraded[]` | doing-layer-3 | Unit 1a tests + Unit 10 manual checks | ✅ |
| Layer 3 — `kind: library` mechanism (LOCKED O3) | doing-layer-3 | Units 1a–1c, 2a–2c (SerpentGuide retroactive tag) | ✅ |
| Layer 3 — outputs flow through typed `RepairAction` catalog | doing-layer-3 | Unit 6a–6c (parser → catalog) | ✅ |
| Layer 3 — v1 introduces NO new action kinds | doing-layer-3 | Stated in Completion Criteria; tested in Unit 6a | ✅ |
| Layer 3 — v1 has zero tool surface for the LLM | doing-layer-3 | Unit 6b (JSON-block-only output, no tools) | ✅ |
| Layer 3 — fallback path on unparseable output | doing-layer-3 | Unit 6a–6b (`fallbackBlob` path) | ✅ |
| Layer 3 v1 file shape (LOCKED O5) | doing-layer-3 | Unit 4b (loader inlined into agentic-repair.ts) | ✅ |
| Layer 3 — five skills (LOCKED O2) | doing-layer-3 | Unit 3 (5 skill files enumerated explicitly) | ✅ |
| Layer 3 — activation contract (LOCKED O4) | doing-layer-3 | Units 5a–5c | ✅ |
| Layer 3 — `--no-repair` is escape hatch | doing-layer-3 | Unit 5a tests + Unit 7b implementation | ✅ |
| Layer 3a — remove `~/AgentBundles/` override fallback | doing-layer-3 | Units 8a–8c | ✅ |
| Layer 3a — symmetric for RepairGuide (no override path) | doing-layer-3 | Unit 8b (in-repo only for both) | ✅ |
| Layer 4 — `provider-model-changed` drift detection | doing-layer-4 | Units 1a–1c (`detectProviderBindingDrift`) | ✅ |
| Layer 4 — read-only (no `state/` writes) | doing-layer-4 | Completion criteria + Unit 6 grep | ✅ |
| Layer 4 — surface `ouro use` repair proposal | doing-layer-4 | Unit 1a (DriftFinding shape includes repairCommand) + Unit 4b (render) | ✅ |
| Layer 4 — read-side tolerates legacy `humanFacing/agentFacing` | doing-layer-4 | Unit 1a edge cases + Unit 2 `normalizeProviderLane` use | ✅ |
| Cross-cutting — hard timeouts on every external op | doing-layer-2 | Units 2a–2c (covers git ops); live-check timeout in env var `OURO_BOOT_TIMEOUT_LIVECHECK` | ✅ |
| Cross-cutting — slugger compound test fixture (LOCKED O6) | doing-layer-3 | Unit 9 (compound integration fixture mirrors today's slugger incident) | ✅ |

## Out of Scope items (correctly NOT covered)

| Out-of-scope item | Verification |
| --- | --- |
| Promoting RepairGuide to a real agent | No doing unit creates RepairGuide as an agent; `kind: library` enforces this | ✅ |
| Auto-applying any repair | All flows are propose-then-confirm | ✅ |
| New `RepairAction` kinds | doing-layer-3 explicitly forbids in Completion Criteria | ✅ |
| Healing 404 remotes by guessing | Skill `diagnose-broken-remote.md` proposes only "disable sync" or "ask operator for URL" | ✅ |
| Healing `state/` automatically | Layer 4 emits `ouro use` proposal; runner is existing, gated on operator confirmation | ✅ |
| New TUI surface for repair | Re-uses `interactive-repair.ts` | ✅ |
| Cross-machine RepairGuide sync | Bundle ships in repo; no per-machine drift surface | ✅ |
| Memory of declined repairs | Deferred per planning Out of Scope | ✅ |
| Replacing `safe-mode.ts` | Layer 1 surfaces existing safe-mode through new vocabulary, no replacement | ✅ |
| Writes to `state/` from new code | Layer 2 Unit 7 + Layer 4 completion criteria + grep guards | ✅ |

## Completion Criteria (planning)

| Planning criterion | Where verified | Status |
| --- | --- | --- |
| Slugger fixture → daemon rolls up `partial`, NOT `degraded` | doing-layer-3 Unit 9 | ✅ |
| Slugger marked with structured per-agent diagnostics | doing-layer-3 Unit 9 | ✅ |
| RepairGuide proposals via `RepairAction` catalog | doing-layer-3 Unit 9 | ✅ |
| Dirty tree as advisory, not blocker | doing-layer-2 Unit 4a + doing-layer-3 Unit 9 | ✅ |
| Second healthy agent rolls up `healthy` | doing-layer-3 Unit 9 | ✅ |
| `ouro up --no-repair` skips RepairGuide, exits 0 | doing-layer-3 Unit 7a–7b | ✅ |
| Existing text-blob fallback preserved | doing-layer-3 Unit 6a–6b | ✅ |
| RepairGuide absent from `ouro status`/discovery/`degraded[]` | doing-layer-3 Unit 1a tests + Unit 10 manual checks | ✅ |
| `~/AgentBundles/` override path removed | doing-layer-3 Units 8a–8c | ✅ |
| Layer 4 drift surfaces `ouro use` proposal | doing-layer-4 Unit 1a + Unit 4b | ✅ |
| Hard timeouts on every external op; no boot hang | doing-layer-2 Units 2, 3, 6 (slow-remote fixture) | ✅ |
| Five-state vocabulary in `DaemonHealthState`, `inner-status.ts`, `startup-tui.ts` | doing-layer-1 Units 1b, 4b | ✅ |
| 100% coverage on all new code | Each doing doc has Coverage section + per-unit coverage units (1c, 2c, 3c, ...) | ✅ |
| All tests pass | Unit "Full-suite green" in each doing doc | ✅ |
| No warnings | Unit "Full-suite green" in each doing doc | ✅ |

## Resolved Open Questions (planning O1–O8)

| Lock | Where applied | Status |
| --- | --- | --- |
| O1 — timeouts 8s/15s git, 10s live-check, AbortSignal e2e, env overrides | doing-layer-2 Units 2a–2c, 3a–3c | ✅ |
| O2 — 5 skills (psyche/SOUL.md, psyche/IDENTITY.md, 5 skills) | doing-layer-3 Unit 3 | ✅ |
| O3 — `kind: library` agent.json field, `agent-discovery.ts` filter | doing-layer-3 Units 1a–1c, 2a–2c | ✅ |
| O4 — fire on `untypedDegraded.length > 0 OR typedDegraded.length >= 3`; `--no-repair` is escape hatch | doing-layer-3 Units 5a–5c, 7b | ✅ |
| O5 — bundle + loader inlined into `agentic-repair.ts`, no standalone module | doing-layer-3 Unit 4b | ✅ |
| O6 — compound integration fixture as primary acceptance test | doing-layer-3 Unit 9 | ✅ |
| O7 — sequential PRs in order 1 → 4 → 2 → 3 | All 4 doing docs cite dependencies + each Unit 0 verifies prior PRs landed | ✅ |
| O8 — override removal scope (5 files) | doing-layer-3 Units 8a–8c lists all 5 files explicitly | ✅ |

## Cross-PR dependency check

| Doing PR | Cuts from main after | Verified in |
| --- | --- | --- |
| doing-layer-1 | (no prior dependencies) | Unit 0 (none) |
| doing-layer-4 | layer 1 PR merged | Unit 0 (verifies `DaemonStatus` + `computeDaemonRollup`) |
| doing-layer-2 | layer 1 PR merged | Unit 0 (verifies `DaemonStatus` + `computeDaemonRollup`); independent of layer 4 |
| doing-layer-3 | layers 1 + 4 + 2 PRs merged | Unit 0 (verifies all three: DaemonStatus, drift-detection, boot-sync-probe) |

## Coverage summary

✅ **Full coverage confirmed.** Every In-Scope item, every Completion Criterion, and every locked decision (O1–O8) maps to specific doing units. Out-of-Scope items are correctly NOT covered. PR sequencing is enforced via Unit 0 verification gates in each downstream PR.

No gaps surfaced during this pass.
