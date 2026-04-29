import { describe, expect, it } from "vitest"

import { computeDaemonRollup } from "../../../heart/daemon/daemon-rollup"
import { detectProviderBindingDrift } from "../../../heart/daemon/drift-detection"
import { classifySyncFailure } from "../../../heart/sync-classification"
import {
  parseRepairProposals,
  shouldFireRepairGuide,
} from "../../../heart/daemon/agentic-repair"
import type { DegradedAgent } from "../../../heart/daemon/interactive-repair"

/**
 * Layer 3 — slugger-compound canonical acceptance fixture (O6 LOCKED).
 *
 * Mirrors today's slugger incident: a single agent with four overlapping
 * findings — bootstrap drift, expired vault credential, broken remote (404),
 * and a dirty working tree. Plus a healthy second agent.
 *
 * Asserts the end-to-end behavior across all four PR layers:
 *   Layer 1: rollup vocabulary → "partial" (slugger has finding, healthy serves)
 *   Layer 4: drift detection emits a `DriftFinding` for slugger's lane mismatch
 *   Layer 2: sync-classification routes 404 to `not-found-404` (blocking) and
 *            dirty tree to `dirty-working-tree` (advisory)
 *   Layer 3: shouldFireRepairGuide fires (untyped > 0); parseRepairProposals
 *            extracts a valid RepairAction; second agent unaffected
 *
 * The fixture deliberately avoids booting the full daemon — that exercise
 * lives in the integration suite. This is the unit-level acceptance gate
 * that proves the four layers compose correctly on the same input.
 */
describe("slugger-compound: four overlapping findings on one agent + healthy peer", () => {
  it("Layer 4: emits drift finding for slugger lane mismatch", () => {
    const findings = detectProviderBindingDrift({
      agentName: "slugger",
      agentJson: {
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-7" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-7" },
      } as Parameters<typeof detectProviderBindingDrift>[0]["agentJson"],
      providerState: {
        lanes: {
          outward: {
            provider: "openai",
            model: "gpt-4o",
            credentialRevision: "old",
            updatedAt: "2026-04-01T00:00:00Z",
          },
          inner: {
            provider: "anthropic",
            model: "claude-opus-4-7",
            credentialRevision: "old",
            updatedAt: "2026-04-01T00:00:00Z",
          },
        },
      },
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.agent).toBe("slugger")
    expect(findings[0]?.lane).toBe("outward")
    expect(findings[0]?.intentProvider).toBe("anthropic")
    expect(findings[0]?.observedProvider).toBe("openai")
  })

  it("Layer 2: classifies 404 remote as not-found-404 (blocking)", () => {
    const result = classifySyncFailure(
      "fetch failed: remote: Repository not found.",
      { phase: "fetch" },
    )
    expect(result.classification).toBe("not-found-404")
  })

  it("Layer 2: classifies dirty working tree as dirty-working-tree (advisory)", () => {
    const result = classifySyncFailure(
      "error: Your local changes to the following files would be overwritten by merge",
      { phase: "merge" },
    )
    expect(result.classification).toBe("dirty-working-tree")
  })

  it("Layer 1: daemon rollup is 'partial' when slugger is degraded but healthy peer serves", () => {
    const rollup = computeDaemonRollup({
      enabledAgents: [
        { name: "slugger", status: "running" },
        { name: "healthy", status: "running" },
      ],
      bootstrapDegraded: [{ agent: "slugger", reason: "vault locked" }],
      driftDetected: true,
      safeMode: false,
    })
    expect(rollup).toBe("partial")
  })

  it("Layer 1: rollup is NOT 'degraded' when at least one agent serves", () => {
    // Regression: pre-Layer-1, the codepath would call any non-empty
    // bootstrapDegraded `degraded`. Layer 1 vocabulary insists this is
    // `partial` because real work is still being served.
    const rollup = computeDaemonRollup({
      enabledAgents: [
        { name: "slugger", status: "running" },
        { name: "healthy", status: "running" },
      ],
      bootstrapDegraded: [{ agent: "slugger", reason: "vault locked" }],
      safeMode: false,
    })
    expect(rollup).not.toBe("degraded")
  })

  it("Layer 3: shouldFireRepairGuide fires on the compound finding mix", () => {
    // Simulate the partition cli-exec.ts performs on
    // `daemonResult.stability.degraded`. Slugger has 4 findings; if any are
    // typed (vault-locked is in the typed catalog) and others are untyped
    // (e.g. drift before it gets normalized), the gate fires on
    // `untypedDegraded.length > 0`.
    const slugger: DegradedAgent[] = [
      // typed: vault-locked
      {
        agent: "slugger",
        errorReason: "credential vault is locked",
        fixHint: "Run 'ouro vault unlock --agent slugger'",
        issue: {
          kind: "vault-locked",
          severity: "blocked",
          actor: "human-required",
          summary: "vault locked",
          actions: [],
        },
      },
      // untyped: drift, broken remote, dirty tree
      { agent: "slugger", errorReason: "drift detected: outward openai vs anthropic", fixHint: "" },
      { agent: "slugger", errorReason: "remote returns 404", fixHint: "" },
      { agent: "slugger", errorReason: "dirty working tree", fixHint: "" },
    ]
    const typed = slugger.filter((d) => d.issue !== undefined)
    const untyped = slugger.filter((d) => d.issue === undefined)
    expect(typed).toHaveLength(1)
    expect(untyped).toHaveLength(3)

    const decision = shouldFireRepairGuide({
      untypedDegraded: untyped,
      typedDegraded: typed,
      noRepair: false,
    })
    expect(decision).toBe(true)
  })

  it("Layer 3: --no-repair short-circuits the gate even on the compound stack", () => {
    const slugger: DegradedAgent[] = [
      { agent: "slugger", errorReason: "drift", fixHint: "" },
      { agent: "slugger", errorReason: "404", fixHint: "" },
      { agent: "slugger", errorReason: "dirty", fixHint: "" },
    ]
    const decision = shouldFireRepairGuide({
      untypedDegraded: slugger,
      typedDegraded: [],
      noRepair: true,
    })
    expect(decision).toBe(false)
  })

  it("Layer 3: parseRepairProposals turns LLM proposal into typed RepairAction[]", () => {
    // Simulates the LLM's RepairGuide-driven response for the slugger compound.
    // Using all the kinds that map to today's typed catalog.
    const llmOutput = [
      "## Diagnosis",
      "Vault expired drove the chain. Fix the credential first.",
      "",
      "```json",
      JSON.stringify({
        actions: [
          { kind: "vault-unlock", agent: "slugger", reason: "credential-revision-changed" },
          { kind: "provider-use", agent: "slugger", reason: "drift between agent.json and state/providers.json", lane: "outward" },
          { kind: "provider-retry", agent: "slugger", reason: "remote returned 404; verify URL and retry" },
        ],
        notes: ["dirty tree on slugger — operator must commit or stash"],
      }),
      "```",
    ].join("\n")

    const parsed = parseRepairProposals(llmOutput)
    expect(parsed.actions).toHaveLength(3)
    expect(parsed.actions.map((a) => a.kind)).toEqual([
      "vault-unlock",
      "provider-use",
      "provider-retry",
    ])
    expect(parsed.warnings).toEqual([])
    expect(parsed.fallbackBlob).toBeUndefined()
  })

  it("healthy peer agent: no findings → contributes no degraded marker, no rollup penalty", () => {
    // The compound fixture has a second agent that is healthy. Verify the
    // rollup with only the healthy agent is `healthy` — i.e., the peer
    // never inherits slugger's findings.
    const peerOnly = computeDaemonRollup({
      enabledAgents: [{ name: "healthy", status: "running" }],
      bootstrapDegraded: [],
      safeMode: false,
    })
    expect(peerOnly).toBe("healthy")
  })

  it("--no-repair variant: same diagnostics surface, no RepairGuide call", () => {
    // Combined assertion: the gate returns false, but the rollup is still
    // 'partial' (the diagnostics are still surfaced — they live in
    // bootstrapDegraded and drive the rollup, independent of whether
    // RepairGuide fires).
    const rollup = computeDaemonRollup({
      enabledAgents: [
        { name: "slugger", status: "running" },
        { name: "healthy", status: "running" },
      ],
      bootstrapDegraded: [{ agent: "slugger", reason: "vault locked" }],
      driftDetected: true,
      safeMode: false,
    })
    expect(rollup).toBe("partial")

    const slugger: DegradedAgent[] = [
      { agent: "slugger", errorReason: "drift", fixHint: "" },
      { agent: "slugger", errorReason: "404", fixHint: "" },
      { agent: "slugger", errorReason: "dirty", fixHint: "" },
    ]
    const gate = shouldFireRepairGuide({
      untypedDegraded: slugger,
      typedDegraded: [],
      noRepair: true,
    })
    expect(gate).toBe(false)
  })
})
