import { TRUSTED_LEVELS } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { cancelHabit } from "../heart/habits/habit-cancel"
import { readBlueBubblesSemanticCaptureAtRoot } from "../senses/bluebubbles/semantic-receipts"
import { withCode, type ToolDefinition } from "./tools-base"

const CAPTURE_LOCATOR_PATTERN = /^capture:([a-f0-9]{64})$/
const ACTOR_AUTHORITY_ERROR = "habit_cancel requires trusted current-ingress actor authority"

async function requireTrustedCurrentIngressActor(
  agentRoot: string,
  captureKeyHash: string,
  context: Parameters<NonNullable<ToolDefinition["handler"]>>[1],
): Promise<void> {
  const capture = readBlueBubblesSemanticCaptureAtRoot(agentRoot, captureKeyHash)
  const actor = capture?.event.actor
  if (!actor || !context?.friendStore) throw new Error(withCode(ACTOR_AUTHORITY_ERROR, "actor-not-trusted"))

  try {
    const friend = await context.friendStore.findByExternalId(actor.provider, actor.externalId)
    if (!TRUSTED_LEVELS.has(friend?.trustLevel ?? "stranger")) {
      throw new Error(withCode(ACTOR_AUTHORITY_ERROR, "actor-not-trusted"))
    }
  } catch {
    throw new Error(withCode(ACTOR_AUTHORITY_ERROR, "actor-not-trusted"))
  }
}

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
      if (unexpected) throw new Error(withCode(`unexpected habit_cancel argument: ${unexpected}`, "bad-argument"))
      if (keys.length !== 2 || typeof args.habit !== "string" || args.habit.trim().length === 0) {
        throw new Error(withCode("habit_cancel requires exactly habit and evidence", "bad-argument"))
      }
      const match = CAPTURE_LOCATOR_PATTERN.exec(args.evidence)
      if (!match) throw new Error(withCode("habit_cancel evidence must use capture:<sha256>", "bad-argument"))
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
      ) throw new Error(withCode("habit_cancel requires authoritative current ingress evidence", "no-ingress-evidence"))
      if (currentIngressEvidence.captureKeyHash !== match[1]) {
        throw new Error(withCode("habit_cancel evidence mismatch with current ingress evidence", "evidence-mismatch"))
      }
      if (!context?.agentRoot) throw new Error(withCode("habit_cancel requires an agent root", "no-agent-root"))
      await requireTrustedCurrentIngressActor(
        context.agentRoot,
        currentIngressEvidence.captureKeyHash,
        context,
      )
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
    ax: { id: "tool:habit_cancel", group: "turn-habits", when: "Pick this when the message that started this turn asks to stop a named habit for good, citing that message's own capture.", effect: "write", destructive: true, errors: [
      { code: "bad-argument", means: "An argument other than habit and evidence was passed, habit is empty, or evidence isn't capture:<sha256>.", fix: "Call again with only habit and evidence, with evidence set to this turn's capture locator." },
      { code: "no-ingress-evidence", means: "This turn didn't start from a captured BlueBubbles message, so nobody's request can authorize it.", fix: "Don't retry; a habit is cancelled only from the person's own message asking for it." },
      { code: "evidence-mismatch", means: "evidence names a different capture from the message that started this turn.", fix: "Pass this turn's own capture locator; an older message can't authorize a cancel." },
      { code: "actor-not-trusted", means: "The person who sent the message isn't a trusted friend, or can't be found.", fix: "Don't retry; tell them a trusted friend has to ask for it." },
      { code: "no-agent-root", means: "The runtime gave this turn no agent home, so no habit can be found.", fix: "Report it to the owner; this is a runtime fault, not something to retry." },
    ] },
  },
]
