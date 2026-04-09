import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"

export const bluebubblesToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "bluebubbles_set_reply_target",
        description:
          "choose where the current iMessage turn should land. use this when you want to widen back to top-level or route your update into a specific active thread in the same chat.",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["current_lane", "top_level", "thread"],
              description: "current_lane mirrors the current inbound lane, top_level answers in the main chat, and thread targets a specific active thread.",
            },
            threadOriginatorGuid: {
              type: "string",
              description: "required when target=thread; use one of the thread ids surfaced in the inbound iMessage context.",
            },
          },
          required: ["target"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const target = typeof args.target === "string" ? args.target.trim() : ""
      const controller = ctx?.bluebubblesReplyTarget
      if (!controller) {
        emitNervesEvent({
          level: "warn",
          component: "tools",
          event: "tool.error",
          message: "bluebubbles reply target missing controller",
          meta: { target },
        })
        return "bluebubbles reply targeting is not available in this context."
      }
      if (target === "current_lane") {
        const result = controller.setSelection({ target: "current_lane" })
        emitNervesEvent({
          component: "tools",
          event: "tool.end",
          message: "bluebubbles reply target updated",
          meta: { target: "current_lane", success: true },
        })
        return result
      }
      if (target === "top_level") {
        const result = controller.setSelection({ target: "top_level" })
        emitNervesEvent({
          component: "tools",
          event: "tool.end",
          message: "bluebubbles reply target updated",
          meta: { target: "top_level", success: true },
        })
        return result
      }
      if (target === "thread") {
        const threadOriginatorGuid =
          typeof args.threadOriginatorGuid === "string" ? args.threadOriginatorGuid.trim() : ""
        if (!threadOriginatorGuid) {
          emitNervesEvent({
            level: "warn",
            component: "tools",
            event: "tool.error",
            message: "bluebubbles reply target missing thread id",
            meta: { target: "thread" },
          })
          return "threadOriginatorGuid is required when target=thread."
        }
        const result = controller.setSelection({ target: "thread", threadOriginatorGuid })
        emitNervesEvent({
          component: "tools",
          event: "tool.end",
          message: "bluebubbles reply target updated",
          meta: { target: "thread", success: true },
        })
        return result
      }
      emitNervesEvent({
        level: "warn",
        component: "tools",
        event: "tool.error",
        message: "bluebubbles reply target invalid target",
        meta: { target },
      })
      return "target must be one of: current_lane, top_level, thread."
    },
    summaryKeys: ["target", "threadOriginatorGuid"],
  },
]
