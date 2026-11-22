import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"
import { withCode } from "./tool-error-code"

export const orientationToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "orientation_get",
        description:
          "return my current turn orientation frame: user-visible speech, channel/source metadata, active referents from the previous assistant response, and the current action policy. use this before mutating durable state when the user's latest message is terse, corrective, or referent-dependent.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    handler: (_args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.orientation_get",
        message: "orientation frame requested",
        meta: { available: !!ctx?.orientationFrame },
      })
      if (!ctx?.orientationFrame) return withCode("no orientation frame is available for this turn.", "no-orientation-frame")
      return JSON.stringify(ctx.orientationFrame, null, 2)
    },
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:orientation_get", group: "turn-orientation", when: "Pick this when the latest message is terse, corrective or points back at something, to see what it refers to before changing anything.", effect: "read", idempotent: true, errors: [
      { code: "no-orientation-frame", means: "This turn has no orientation frame, as in a habit or private-runtime turn.", fix: "Read the conversation itself, and ask the person if what they meant is still unclear." },
    ] },
  },
]
