import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

import { baseToolDefinitions } from "../../repertoire/tools-base"
import { habitToolDefinitions } from "../../repertoire/tools-habits"
import {
  SYNTHETIC_HABIT_ID,
  writeSyntheticCaptureEvidence,
  writeSyntheticHabitDefinition,
} from "../fixtures/habits/habit-cancel-evidence"

const CAPTURE_HASH = "a".repeat(64)

function temporaryAgentRoot(): { agentRoot: string; cleanup: () => void } {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "habit-cancel-tool-"))
  return {
    agentRoot,
    cleanup: () => fs.rmSync(agentRoot, { force: true, recursive: true }),
  }
}

function expectLifecycleUntouched(agentRoot: string): void {
  expect(fs.existsSync(path.join(agentRoot, "state", "habits", "lifecycle"))).toBe(false)
}

function habitCancelTool() {
  const definition = habitToolDefinitions.find((entry) => entry.tool.function.name === "habit_cancel")
  if (!definition) throw new Error("habit_cancel tool is not registered")
  return definition
}

describe("grounded habit cancellation tool", () => {
  it("registers an exact two-argument durable terminal projection", () => {
    const definition = habitCancelTool()
    expect(baseToolDefinitions).toContain(definition)
    expect(definition.tool).toEqual({
      type: "function",
      function: {
        name: "habit_cancel",
        description: expect.any(String),
        parameters: {
          type: "object",
          properties: {
            habit: { type: "string", description: expect.any(String) },
            evidence: { type: "string", description: expect.any(String) },
          },
          required: ["habit", "evidence"],
          additionalProperties: false,
        },
      },
    })
    expect(definition.riskProfile).toEqual({
      mutates: "durable_state_write",
      risk: "high",
      reason: expect.any(String),
    })
    expect(definition.terminalProjection).toBeDefined()
  })

  it("rejects missing or mismatched authoritative current-ingress evidence before cancellation", async () => {
    const definition = habitCancelTool()
    const args = { habit: "rsvp-demo", evidence: `capture:${CAPTURE_HASH}` }
    const temporary = temporaryAgentRoot()
    try {
      await expect(definition.handler(args, {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
      })).rejects.toThrow(/current ingress evidence/i)
      await expect(definition.handler(args, {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash: "b".repeat(64),
        },
      })).rejects.toThrow(/evidence.*mismatch/i)
      await expect(definition.handler(args, {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
        currentIngressEvidence: {
          schemaVersion: 2,
          provider: "bluebubbles",
          captureKeyHash: CAPTURE_HASH,
        } as any,
      })).rejects.toThrow(/current ingress evidence/i)
      await expect(definition.handler(args, {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "other-provider",
          captureKeyHash: CAPTURE_HASH,
        } as any,
      })).rejects.toThrow(/current ingress evidence/i)
      await expect(definition.handler({ habit: "rsvp-demo", evidence: "bridge-synthetic" }, {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash: CAPTURE_HASH,
        },
      })).rejects.toThrow(/capture:/i)
      expectLifecycleUntouched(temporary.agentRoot)
    } finally {
      temporary.cleanup()
    }
  })

  it("rejects caller-authored actor/request fields and invalid locator syntax", async () => {
    const definition = habitCancelTool()
    const temporary = temporaryAgentRoot()
    try {
      const context = {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
        currentIngressEvidence: {
          schemaVersion: 1 as const,
          provider: "bluebubbles" as const,
          captureKeyHash: CAPTURE_HASH,
        },
      }
      await expect(definition.handler({
        habit: "rsvp-demo",
        evidence: `capture:${CAPTURE_HASH}`,
        actor: "invented",
      }, context)).rejects.toThrow(/unexpected.*actor/i)
      await expect(definition.handler({
        habit: "rsvp-demo",
        evidence: `capture:${CAPTURE_HASH}`,
        request: "invented",
      }, context)).rejects.toThrow(/unexpected.*request/i)
      await expect(definition.handler({
        habit: "rsvp-demo",
        evidence: `capture:${CAPTURE_HASH}`,
        actorDisplayName: "invented",
      }, context)).rejects.toThrow(/unexpected.*actorDisplayName/i)
      await expect(definition.handler({
        habit: "rsvp-demo",
        evidence: `capture:${CAPTURE_HASH}`,
        requestText: "invented",
      }, context)).rejects.toThrow(/unexpected.*requestText/i)
      for (const evidence of [
        "capture:",
        `capture:${"A".repeat(64)}`,
        `capture:${"a".repeat(63)}`,
        `capture:${"a".repeat(64)}:extra`,
        "../capture",
      ]) {
        await expect(definition.handler({ habit: "rsvp-demo", evidence }, context))
          .rejects.toThrow(/evidence/i)
      }
      expectLifecycleUntouched(temporary.agentRoot)
    } finally {
      temporary.cleanup()
    }
  })

  it("executes grounded cancellation and returns only its deterministic acknowledgement", async () => {
    const definition = habitCancelTool()
    const temporary = temporaryAgentRoot()
    try {
      writeSyntheticHabitDefinition(temporary.agentRoot)
      const capture = writeSyntheticCaptureEvidence(temporary.agentRoot)
      const result = await definition.handler({
        habit: SYNTHETIC_HABIT_ID,
        evidence: capture.locator,
      }, {
        signin: async () => undefined,
        agentRoot: temporary.agentRoot,
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash: capture.capture.keyHash,
        },
      })

      expect(result).toMatch(new RegExp(`^Cancelled habit ${JSON.stringify(SYNTHETIC_HABIT_ID)} from confirmed requester `))
      expect(result).toContain("No concurrent send crossed the transport boundary.")
      expect(fs.readFileSync(path.join(temporary.agentRoot, "habits", `${SYNTHETIC_HABIT_ID}.md`), "utf8"))
        .toContain("status: cancelled")
    } finally {
      temporary.cleanup()
    }
  })

  it("rejects incomplete arguments, malformed context, and missing agent root", async () => {
    const definition = habitCancelTool()
    const validArgs = { habit: "rsvp-demo", evidence: `capture:${CAPTURE_HASH}` }
    const ingress = {
      schemaVersion: 1 as const,
      provider: "bluebubbles" as const,
      captureKeyHash: CAPTURE_HASH,
    }
    await expect(definition.handler({ evidence: validArgs.evidence }, {
      signin: async () => undefined,
      currentIngressEvidence: ingress,
    })).rejects.toThrow(/exactly habit and evidence/i)
    await expect(definition.handler({ habit: " ", evidence: validArgs.evidence }, {
      signin: async () => undefined,
      currentIngressEvidence: ingress,
    })).rejects.toThrow(/exactly habit and evidence/i)
    await expect(definition.handler(validArgs, {
      signin: async () => undefined,
      currentIngressEvidence: { ...ingress, extra: true } as any,
    })).rejects.toThrow(/authoritative current ingress/i)
    await expect(definition.handler(validArgs, {
      signin: async () => undefined,
      currentIngressEvidence: { ...ingress, captureKeyHash: "invalid" },
    })).rejects.toThrow(/authoritative current ingress/i)
    await expect(definition.handler(validArgs, {
      signin: async () => undefined,
      currentIngressEvidence: ingress,
    })).rejects.toThrow(/agent root/i)
  })
})
