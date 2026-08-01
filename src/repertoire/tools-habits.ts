import { emitNervesEvent } from "../nerves/runtime"
import { cancelHabit } from "../heart/habits/habit-cancel"
import type { ToolDefinition } from "./tools-base"

const CAPTURE_LOCATOR_PATTERN = /^capture:([a-f0-9]{64})$/

export const habitToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "habit_cancel",
        description: "Cancel a named habit from the immutable evidence capture that triggered the current turn.",
        parameters: {
          type: "object",
          properties: {
            habit: {
              type: "string",
              description: "Exact habit identifier to cancel.",
            },
            evidence: {
              type: "string",
              description: "Current ingress evidence locator in capture:<sha256> form.",
            },
          },
          required: ["habit", "evidence"],
          additionalProperties: false,
        },
      },
    },
    riskProfile: {
      mutates: "durable_state_write",
      risk: "high",
      reason: "Permanently transitions a durable habit definition to cancelled.",
    },
    terminalProjection: {
      mode: "verbatim",
      requiresSoleCall: true,
      clearBufferedText: true,
    },
    summaryKeys: ["habit", "evidence"],
    handler: async (args, context) => {
      emitNervesEvent({
        component: "tools",
        event: "tools.habit_cancel_invoked",
        message: "habit cancellation tool invoked",
        meta: { habit: typeof args.habit === "string" ? args.habit : null },
      })
      const keys = Object.keys(args)
      const unexpected = keys.find((key) => key !== "habit" && key !== "evidence")
      if (unexpected) throw new Error(`unexpected habit_cancel argument: ${unexpected}`)
      if (keys.length !== 2 || typeof args.habit !== "string" || args.habit.trim().length === 0) {
        throw new Error("habit_cancel requires exactly habit and evidence")
      }
      const match = CAPTURE_LOCATOR_PATTERN.exec(args.evidence)
      if (!match) throw new Error("habit_cancel evidence must use capture:<sha256>")
      const currentIngressEvidence = context?.currentIngressEvidence
      if (
        !currentIngressEvidence
        || Object.keys(currentIngressEvidence).length !== 3
        || Object.keys(currentIngressEvidence).some((key) => (
          key !== "schemaVersion" && key !== "provider" && key !== "captureKeyHash"
        ))
        || currentIngressEvidence.schemaVersion !== 1
        || currentIngressEvidence.provider !== "bluebubbles"
        || !/^[a-f0-9]{64}$/.test(currentIngressEvidence.captureKeyHash)
      ) throw new Error("habit_cancel requires authoritative current ingress evidence")
      if (currentIngressEvidence.captureKeyHash !== match[1]) {
        throw new Error("habit_cancel evidence mismatch with current ingress evidence")
      }
      if (!context?.agentRoot) throw new Error("habit_cancel requires an agent root")
      const receipt = await cancelHabit({
        agentRoot: context.agentRoot,
        habitId: args.habit,
        evidenceLocator: args.evidence,
        authority: {
          kind: "current_ingress",
          currentIngressEvidence,
        },
      })
      return receipt.acknowledgement
    },
  },
]
