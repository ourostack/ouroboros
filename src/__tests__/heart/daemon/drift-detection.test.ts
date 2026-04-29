/**
 * Unit 1a: tests for detectProviderBindingDrift — the pure intent-vs-observed
 * comparator that surfaces per-lane drift between agent.json (intent) and
 * state/providers.json (observation).
 *
 * The comparator:
 * - Compares agent.json's `humanFacing`/`agentFacing` (legacy) or
 *   `outward`/`inner` (new) per-lane provider bindings against the matching
 *   lane in the on-disk ProviderState.
 * - Uses normalizeProviderLane via the loader to decide which key set to read
 *   from agent.json; this comparator function itself accepts a typed input and
 *   does not parse raw JSON.
 * - Emits one DriftFinding per drifted lane (provider differs, model differs,
 *   or both) with reason="provider-model-changed" and a copy-pasteable
 *   `ouro use` repair command.
 * - Returns [] when both lanes match or when there is no observed binding
 *   (providerState === null) — fresh-install case has nothing to drift
 *   against.
 *
 * The function is pure: no fs, no network, no globals. The caller (Unit 2's
 * loader) is responsible for reading inputs from disk.
 */

import { describe, expect, it } from "vitest"
import {
  detectProviderBindingDrift,
  type DriftFinding,
} from "../../../heart/daemon/drift-detection"
import type { AgentConfig, AgentFacingConfig } from "../../../heart/identity"
import type { ProviderState } from "../../../heart/provider-state"

const TS = "2026-04-28T19:30:00.000Z"

function facing(provider: AgentFacingConfig["provider"], model: string): AgentFacingConfig {
  return { provider, model }
}

function baseAgentJson(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    version: 2,
    enabled: true,
    humanFacing: facing("anthropic", "claude-opus-4-6"),
    agentFacing: facing("anthropic", "claude-opus-4-6"),
    phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
    ...overrides,
  }
}

function providerState(input: {
  outward?: { provider: AgentFacingConfig["provider"]; model: string }
  inner?: { provider: AgentFacingConfig["provider"]; model: string }
} = {}): ProviderState {
  const outward = input.outward ?? { provider: "anthropic", model: "claude-opus-4-6" }
  const inner = input.inner ?? { provider: "anthropic", model: "claude-opus-4-6" }
  return {
    schemaVersion: 1,
    machineId: "machine_test",
    updatedAt: TS,
    lanes: {
      outward: { provider: outward.provider, model: outward.model, source: "bootstrap", updatedAt: TS },
      inner: { provider: inner.provider, model: inner.model, source: "bootstrap", updatedAt: TS },
    },
    readiness: {},
  }
}

describe("detectProviderBindingDrift — pure intent-vs-observed comparator", () => {
  describe("no drift cases", () => {
    it("returns [] when both lanes match (legacy keys)", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson(),
        providerState: providerState(),
      })
      expect(result).toEqual([])
    })

    it("returns [] when both lanes match using new outward/inner keys", () => {
      // The new field-name path: the agent.json carries outward/inner directly,
      // not legacy humanFacing/agentFacing. The comparator must read the new
      // keys and treat them as canonical when both sets are present we prefer
      // the new ones; when only legacy is present we fall back; when only new
      // is present we use those. This test pins the "new keys honored" path.
      const augmented = {
        ...baseAgentJson({
          humanFacing: facing("anthropic", "claude-opus-4-5-LEGACY-IGNORED"),
          agentFacing: facing("anthropic", "claude-opus-4-5-LEGACY-IGNORED"),
        }),
        outward: facing("anthropic", "claude-opus-4-6"),
        inner: facing("anthropic", "claude-opus-4-6"),
      } as AgentConfig
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: augmented,
        providerState: providerState(),
      })
      expect(result).toEqual([])
    })

    it("returns [] when providerState is null (fresh install, nothing to drift against)", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson(),
        providerState: null,
      })
      expect(result).toEqual([])
    })

    it("returns [] when providerState matches and agent.json mixes legacy outward + new inner", () => {
      // Mixed path: one lane uses legacy field name, the other uses the new
      // field name. Rename is in flight; this MUST work.
      const mixed = {
        ...baseAgentJson({
          humanFacing: facing("anthropic", "claude-opus-4-6"),
          agentFacing: facing("anthropic", "claude-opus-4-5-LEGACY-IGNORED"),
        }),
        inner: facing("anthropic", "claude-opus-4-6"),
      } as AgentConfig
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: mixed,
        providerState: providerState(),
      })
      expect(result).toEqual([])
    })

    it("returns [] when providerState matches and agent.json mixes new outward + legacy inner", () => {
      const mixed = {
        ...baseAgentJson({
          humanFacing: facing("anthropic", "claude-opus-4-5-LEGACY-IGNORED"),
          agentFacing: facing("anthropic", "claude-opus-4-6"),
        }),
        outward: facing("anthropic", "claude-opus-4-6"),
      } as AgentConfig
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: mixed,
        providerState: providerState(),
      })
      expect(result).toEqual([])
    })
  })

  describe("provider-only mismatch", () => {
    it("emits drift on outward when provider differs but model matches", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson({
          humanFacing: facing("openai", "claude-opus-4-6"),
          agentFacing: facing("anthropic", "claude-opus-4-6"),
        }),
        providerState: providerState(),
      })
      const expected: DriftFinding = {
        agent: "alpha",
        lane: "outward",
        intentProvider: "openai",
        intentModel: "claude-opus-4-6",
        observedProvider: "anthropic",
        observedModel: "claude-opus-4-6",
        reason: "provider-model-changed",
        repairCommand: "ouro use --agent alpha --lane outward --provider openai --model claude-opus-4-6",
      }
      expect(result).toEqual([expected])
    })

    it("emits drift on inner when provider differs but model matches", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson({
          agentFacing: facing("openai", "claude-opus-4-6"),
        }),
        providerState: providerState(),
      })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        agent: "alpha",
        lane: "inner",
        intentProvider: "openai",
        observedProvider: "anthropic",
        reason: "provider-model-changed",
      })
      expect(result[0].repairCommand).toBe(
        "ouro use --agent alpha --lane inner --provider openai --model claude-opus-4-6",
      )
    })
  })

  describe("model-only mismatch", () => {
    it("emits drift on outward when model differs but provider matches", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson({
          humanFacing: facing("anthropic", "claude-opus-4-7"),
        }),
        providerState: providerState(),
      })
      expect(result).toEqual([{
        agent: "alpha",
        lane: "outward",
        intentProvider: "anthropic",
        intentModel: "claude-opus-4-7",
        observedProvider: "anthropic",
        observedModel: "claude-opus-4-6",
        reason: "provider-model-changed",
        repairCommand: "ouro use --agent alpha --lane outward --provider anthropic --model claude-opus-4-7",
      }])
    })
  })

  describe("both differ", () => {
    it("emits drift when both provider AND model differ on the same lane", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson({
          humanFacing: facing("openai", "claude-opus-4-7"),
        }),
        providerState: providerState(),
      })
      expect(result).toEqual([{
        agent: "alpha",
        lane: "outward",
        intentProvider: "openai",
        intentModel: "claude-opus-4-7",
        observedProvider: "anthropic",
        observedModel: "claude-opus-4-6",
        reason: "provider-model-changed",
        repairCommand: "ouro use --agent alpha --lane outward --provider openai --model claude-opus-4-7",
      }])
    })

    it("emits two findings when both lanes have drift", () => {
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson({
          humanFacing: facing("openai", "claude-opus-4-7"),
          agentFacing: facing("minimax", "minimax-m2.5"),
        }),
        providerState: providerState(),
      })
      expect(result).toHaveLength(2)
      const lanes = result.map((finding) => finding.lane).sort()
      expect(lanes).toEqual(["inner", "outward"])
      const outwardFinding = result.find((finding) => finding.lane === "outward")
      const innerFinding = result.find((finding) => finding.lane === "inner")
      expect(outwardFinding?.intentProvider).toBe("openai")
      expect(innerFinding?.intentProvider).toBe("minimax")
      expect(outwardFinding?.repairCommand).toContain("--lane outward")
      expect(innerFinding?.repairCommand).toContain("--lane inner")
    })
  })

  describe("legacy ↔ new field-name normalization (the locked contract)", () => {
    it("treats agent.json humanFacing as outward when matching against providerState.lanes.outward", () => {
      // The locked normalization: humanFacing IS outward, agentFacing IS inner.
      // If agent.json says humanFacing={anthropic, opus-4-6} and providerState
      // says lanes.outward={anthropic, opus-4-6}, that is NOT drift — the names
      // are aliases.
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: baseAgentJson({
          humanFacing: facing("anthropic", "claude-opus-4-6"),
          agentFacing: facing("anthropic", "claude-opus-4-6"),
        }),
        providerState: providerState({
          outward: { provider: "anthropic", model: "claude-opus-4-6" },
          inner: { provider: "anthropic", model: "claude-opus-4-6" },
        }),
      })
      expect(result).toEqual([])
    })

    it("prefers new outward/inner fields over legacy humanFacing/agentFacing when both are present", () => {
      // Pinned lookup precedence: if agent.json carries BOTH the legacy and
      // new field name for the same lane, the new field name wins. Without
      // this, a partially-renamed agent.json would silently keep using stale
      // legacy values — exactly the drift-detection failure mode this PR
      // exists to surface.
      const augmented = {
        ...baseAgentJson({
          humanFacing: facing("openai", "claude-opus-4-7"),
        }),
        outward: facing("anthropic", "claude-opus-4-6"),
      } as AgentConfig
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: augmented,
        providerState: providerState(),
      })
      // outward wins: "anthropic"/"claude-opus-4-6" matches state, no drift.
      expect(result).toEqual([])
    })
  })

  describe("missing-lane-intent path", () => {
    it("emits no finding for a lane whose agent.json has neither legacy nor new key set", () => {
      // The agent.json has no usable binding for the inner lane (humanFacing
      // is the only lane configured; agentFacing has been deleted/blanked
      // and no `inner` key exists either). The comparator stays silent on
      // that lane — drift detection has no intent to compare against.
      const partial = {
        version: 2,
        enabled: true,
        humanFacing: facing("anthropic", "claude-opus-4-6"),
        // agentFacing intentionally absent: cast through unknown so the test
        // can model an agent.json that doesn't carry an inner lane at all
        // (a real-world parse outcome when the rename is mid-flight and the
        // new key hasn't been added yet).
        phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
      } as unknown as AgentConfig
      const result = detectProviderBindingDrift({
        agentName: "alpha",
        agentJson: partial,
        providerState: providerState(),
      })
      expect(result).toEqual([])
    })
  })

  describe("repair command shape", () => {
    it("uses the agent name from input, not a hard-coded value", () => {
      const result = detectProviderBindingDrift({
        agentName: "weird-name_123",
        agentJson: baseAgentJson({
          humanFacing: facing("openai", "claude-opus-4-6"),
        }),
        providerState: providerState(),
      })
      expect(result[0].repairCommand).toBe(
        "ouro use --agent weird-name_123 --lane outward --provider openai --model claude-opus-4-6",
      )
    })
  })
})
