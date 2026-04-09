import * as fs from "node:fs/promises"
import type OpenAI from "openai"
import { getMinimaxConfig } from "../heart/config"
import { getAgentName } from "../heart/identity"
import { MINIMAX_PROVIDER_BASE_URL } from "../heart/providers/minimax"
import { minimaxVlmDescribe } from "../heart/providers/minimax-vlm"
import { listRecentAttachments } from "../heart/attachments/store"
import { materializeAttachment } from "../heart/attachments/materialize"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"
import { frictionToolResult, okToolResult, type ToolFrictionEnvelope } from "./tool-results"

const LIST_ATTACHMENTS_DESCRIPTION =
  "List the most recent attachments the harness preserved across senses. Use this when you need a stable attachment_id, " +
  "when a repair flow says an attachment could not be found, or when you want to inspect what artifacts are currently on hand " +
  "before asking the user to resend anything."

const MATERIALIZE_ATTACHMENT_DESCRIPTION =
  "Materialize an attachment into a concrete file path the harness can inspect or hand to other tools. " +
  "Use variant=original when you want the raw file. Use variant=vision_safe for images when you want the harness to normalize " +
  "size and format into a VLM-safe image before retrying."

const DESCRIBE_IMAGE_DESCRIPTION =
  "Use this to inspect an image attachment with a targeted question, or to re-interrogate an image after a wrong first answer. " +
  "The harness materializes the original attachment, normalizes it into a VLM-safe image when needed, and sends it through the vision-language model. " +
  "Prefer specific prompts like 'what is the confirmation number?' over 'describe this image'. " +
  "Pass attachment_id when you have it; attachment_guid is accepted as a compatibility alias."

function trimArg(value: string | undefined): string {
  return value?.trim() ?? ""
}

function resolveAttachmentId(args: Record<string, string>): string {
  return trimArg(args.attachment_id) || trimArg(args.attachment_guid)
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function attachmentNotFound(tool: string, attachmentId: string): string {
  const friction: ToolFrictionEnvelope = {
    kind: "local_repair",
    recoverability: "transformable",
    summary: `Attachment ${attachmentId} is not in the recent attachment store anymore.`,
    signature: `${tool}:attachment-not-found`,
    suggested_next_actions: [
      {
        kind: "tool",
        tool: "list_recent_attachments",
        reason: "Find the current attachment_id for the artifact you want to inspect before retrying.",
      },
    ],
  }
  return frictionToolResult(tool, friction)
}

function missingAttachmentId(tool: string): string {
  return frictionToolResult(tool, {
    kind: "input_error",
    recoverability: "transformable",
    summary: "An attachment id is required for this tool call.",
    signature: `${tool}:missing-attachment-id`,
    suggested_next_actions: [
      {
        kind: "tool",
        tool: "list_recent_attachments",
        reason: "Inspect the current recent attachments and retry with attachment_id.",
      },
    ],
  })
}

function missingPrompt(): string {
  return frictionToolResult("describe_image", {
    kind: "input_error",
    recoverability: "transformable",
    summary: "describe_image needs a targeted prompt before retrying.",
    signature: "describe_image:missing-prompt",
    suggested_next_actions: [
      {
        kind: "message",
        message: "Retry with a specific question like 'what is the confirmation number?' or 'what date is shown?'",
      },
    ],
  })
}

function normalizeMaterializeError(tool: string, attachmentId: string, reason: string): string {
  if (reason.startsWith("Attachment not found:")) {
    return attachmentNotFound(tool, attachmentId)
  }
  if (reason.includes("is not an image")) {
    return frictionToolResult(tool, {
      kind: "input_error",
      recoverability: "transformable",
      summary: `Attachment ${attachmentId} is not an image, so it cannot produce a vision_safe variant.`,
      signature: `${tool}:not-image`,
      suggested_next_actions: [
        {
          kind: "tool",
          tool: "materialize_attachment",
          reason: "Retry with variant=original if you need the raw file instead.",
          args: { attachment_id: attachmentId, variant: "original" },
        },
      ],
    })
  }
  return frictionToolResult(tool, {
    kind: "local_repair",
    recoverability: "retryable",
    summary: reason,
    signature: `${tool}:materialize-failed`,
    suggested_next_actions: [
      {
        kind: "tool",
        tool: "materialize_attachment",
        reason: "Retry materialization once more in case the file path or normalization target changed.",
        args: { attachment_id: attachmentId, variant: "vision_safe" },
      },
    ],
  })
}

async function buildImageDataUrl(filePath: string, mimeType?: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  const encoded = buffer.toString("base64")
  const normalizedMime = mimeType?.trim().toLowerCase() || "image/jpeg"
  return `data:${normalizedMime};base64,${encoded}`
}

export const attachmentToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "list_recent_attachments",
        description: LIST_ATTACHMENTS_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["image", "audio", "document", "binary", "unknown"],
              description: "Optional attachment kind filter.",
            },
            limit: {
              type: "string",
              description: "Optional numeric limit for how many attachments to return.",
            },
          },
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: async (args) => {
      const agentName = getAgentName()
      const kind = trimArg(args.kind)
      const attachments = listRecentAttachments(agentName, {
        kind: kind ? kind as "image" | "audio" | "document" | "binary" | "unknown" : undefined,
        limit: parseLimit(args.limit),
      })
      return okToolResult("list_recent_attachments", attachments)
    },
    summaryKeys: ["kind", "limit"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "materialize_attachment",
        description: MATERIALIZE_ATTACHMENT_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            attachment_id: {
              type: "string",
              description: "Stable attachment id such as attachment:cli-local-file:... or attachment:bluebubbles:...",
            },
            attachment_guid: {
              type: "string",
              description: "Compatibility alias for older callers. Prefer attachment_id.",
            },
            variant: {
              type: "string",
              enum: ["original", "vision_safe"],
              description: "Which attachment variant to materialize.",
            },
          },
          required: ["variant"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: async (args) => {
      const attachmentId = resolveAttachmentId(args)
      if (!attachmentId) {
        return missingAttachmentId("materialize_attachment")
      }

      const agentName = getAgentName()
      const variant = trimArg(args.variant) === "vision_safe" ? "vision_safe" : "original"

      try {
        const materialized = await materializeAttachment(agentName, attachmentId, { variant })
        return okToolResult("materialize_attachment", materialized)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return normalizeMaterializeError("materialize_attachment", attachmentId, reason)
      }
    },
    summaryKeys: ["attachment_id", "attachment_guid", "variant"],
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
            attachment_id: {
              type: "string",
              description: "Stable attachment id for the image you want to inspect.",
            },
            attachment_guid: {
              type: "string",
              description: "Compatibility alias for older callers. Prefer attachment_id.",
            },
            prompt: {
              type: "string",
              description: "A targeted question about the image.",
            },
          },
          required: ["prompt"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: async (args) => {
      const attachmentId = resolveAttachmentId(args)
      if (!attachmentId) {
        return missingAttachmentId("describe_image")
      }

      const prompt = trimArg(args.prompt)
      if (!prompt) {
        return missingPrompt()
      }

      const agentName = getAgentName()
      try {
        const materialized = await materializeAttachment(agentName, attachmentId, { variant: "vision_safe" })
        const imageDataUrl = await buildImageDataUrl(materialized.path, materialized.mimeType)
        const { apiKey } = getMinimaxConfig()
        if (!apiKey) {
          return frictionToolResult("describe_image", {
            kind: "external_blocker",
            recoverability: "blocked",
            summary: "MiniMax credentials are missing, so image understanding is unavailable until credentials are fixed.",
            signature: "describe_image:minimax-missing-key",
            suggested_next_actions: [
              {
                kind: "message",
                message: "Repair the minimax credentials for this agent, then retry describe_image.",
              },
            ],
          })
        }

        const description = await minimaxVlmDescribe({
          apiKey,
          prompt,
          imageDataUrl,
          baseURL: MINIMAX_PROVIDER_BASE_URL,
          attachmentGuid: attachmentId,
          mimeType: materialized.mimeType,
        })
        emitNervesEvent({
          component: "tools",
          event: "tool.describe_image_success",
          message: "describe_image returned a description",
          meta: { attachmentId },
        })
        return description
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return normalizeMaterializeError("describe_image", attachmentId, reason)
      }
    },
    summaryKeys: ["attachment_id", "attachment_guid", "prompt"],
  },
]
