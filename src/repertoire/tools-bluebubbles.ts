import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig, getMinimaxConfig } from "../heart/config"
import { MINIMAX_PROVIDER_BASE_URL } from "../heart/providers/minimax"
import { minimaxVlmDescribe } from "../heart/providers/minimax-vlm"
import {
  lookupBlueBubblesAttachment,
} from "../senses/bluebubbles/attachment-cache"
import { downloadBlueBubblesAttachment } from "../senses/bluebubbles/media"

// AX-1: the tool description is the only instruction manual a future agent
// gets. It must teach WHEN to reach for the tool and HOW to write a good
// prompt. A type-signature-style "Describes an image." is a violation.
const DESCRIBE_IMAGE_DESCRIPTION =
  "Use this tool to look at an attachment the user sent, or to re-interrogate an image with a targeted question. " +
  "The current chat model can't see images natively; this tool runs the image through a vision-language model (VLM) " +
  "and returns a text description. " +
  "Prefer targeted prompts (\"what's the flight number in the bottom-right?\") over generic ones (\"describe this image\") — " +
  "you'll get better answers. " +
  "Call this when the user sent a screenshot and you need to read text from it, verify a detail, or double-check something " +
  "the ingestion-time auto-describe summary might have missed. " +
  "The attachment_guid comes from the attachment marker in the user's most recent message."

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
  {
    tool: {
      type: "function",
      function: {
        name: "describe_image",
        description: DESCRIBE_IMAGE_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            attachment_guid: {
              type: "string",
              description:
                "The guid of the attachment to describe. Usually pulled from the attachment marker in the user's most recent message.",
            },
            prompt: {
              type: "string",
              description:
                "A targeted question about the image. Prefer specific prompts over generic ones — e.g. 'what's the flight number in the bottom-right?' gives better answers than 'describe this image'.",
            },
          },
          required: ["attachment_guid", "prompt"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: async (args) => {
      const attachmentGuid = typeof args.attachment_guid === "string" ? args.attachment_guid.trim() : ""
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
      if (!attachmentGuid) {
        emitNervesEvent({
          level: "warn",
          component: "tools",
          event: "tool.error",
          message: "describe_image missing attachment_guid",
          meta: {},
        })
        return "describe_image: attachment_guid is required — pass the guid from the inbound attachment marker and retry"
      }
      if (!prompt) {
        emitNervesEvent({
          level: "warn",
          component: "tools",
          event: "tool.error",
          message: "describe_image missing prompt",
          meta: {},
        })
        return "describe_image: prompt is required — supply a targeted question (e.g. 'what's the flight number in the bottom-right?') and retry"
      }
      const summary = lookupBlueBubblesAttachment(attachmentGuid)
      if (!summary) {
        emitNervesEvent({
          level: "warn",
          component: "tools",
          event: "tool.error",
          message: "describe_image attachment not found in cache",
          meta: { attachmentGuid },
        })
        return `describe_image: no attachment with guid ${attachmentGuid} found in recent messages — ask the user to resend the image or verify the guid`
      }
      try {
        const config = getBlueBubblesConfig()
        const channelConfig = getBlueBubblesChannelConfig()
        const downloaded = await downloadBlueBubblesAttachment(summary, config, channelConfig)
        const mimeType = downloaded.contentType ?? summary.mimeType ?? "image/png"
        const base64 = downloaded.buffer.toString("base64")
        const dataUrl = `data:${mimeType};base64,${base64}`
        const { apiKey } = getMinimaxConfig()
        if (!apiKey) {
          throw new Error(
            "minimax API key not found in secrets.json — re-run credential setup or add a minimax key",
          )
        }
        const description = await minimaxVlmDescribe({
          apiKey,
          prompt,
          imageDataUrl: dataUrl,
          baseURL: MINIMAX_PROVIDER_BASE_URL,
          attachmentGuid,
          mimeType,
        })
        return description
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        emitNervesEvent({
          level: "warn",
          component: "tools",
          event: "tool.error",
          message: "describe_image failed",
          meta: { attachmentGuid, reason },
        })
        return `describe_image failed: ${reason}`
      }
    },
    summaryKeys: ["attachment_guid", "prompt"],
  },
]
