import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"

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
      if (!ctx?.orientationFrame) return "no orientation frame is available for this turn."
      return JSON.stringify(ctx.orientationFrame, null, 2)
    },
  },
]
