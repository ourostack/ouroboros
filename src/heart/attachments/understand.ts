import * as fs from "node:fs/promises"
import type OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import { getModelCapabilities } from "../model-capabilities"
import { readProviderCredentialRecord } from "../provider-credentials"
import { MINIMAX_PROVIDER_BASE_URL } from "../providers/minimax"
import { minimaxVlmDescribe } from "../providers/minimax-vlm"
import { materializeAttachment } from "./materialize"
import { renderAttachmentBlock } from "./render"
import { voiceNoteLine } from "./transcribe-audio"
import type { AttachmentRecord } from "./types"

// What an attachment says, in words, the same way for every sense: an image is described, a voice note is transcribed.

/** How long one inbound attachment may take to describe or transcribe. */
export const ATTACHMENT_WORDS_TIMEOUT_MS = 120_000

export const IMAGE_DESCRIPTION_TEXT = {
  description: (desc: string): string => `[image description: ${desc}]`,
  failure: (reason: string): string => `[image description failed: ${reason}]`,
} as const

export function imageDescriptionPrompt(userText: string | undefined): string {
  return `User message: "${userText ?? ""}"\n\nDescribe this image in detail, focusing on anything relevant to what the user said above.\nInclude any text visible in the image verbatim.`
}

export async function imageFileDataUrl(filePath: string, mimeType?: string): Promise<string> {
  const normalizedMime = mimeType?.trim().toLowerCase() || "image/jpeg"
  return `data:${normalizedMime};base64,${(await fs.readFile(filePath)).toString("base64")}`
}

export class UnsupportedImageModelError extends Error {}

const ignoreProgress = (): void => {}

/** Describe with the configured outward provider; never borrow another provider's credentials. */
export async function describeImage(agentName: string, params: {
  prompt: string
  imageDataUrl: string
  attachmentGuid?: string
  mimeType?: string
  chatModel?: string
  agentRoot?: string
  timeoutMs?: number
}): Promise<string> {
  emitNervesEvent({
    component: "senses",
    event: "senses.image_description_start",
    message: "describing an image with the configured provider",
    meta: { attachmentId: params.attachmentGuid },
  })
  try {
    // Loaded at call time because the provider runtime also imports the attachment tools.
    const { getProviderRuntime } = await import("../core")
    const runtime = await getProviderRuntime("human", { agentName, agentRoot: params.agentRoot ?? getAgentRoot(agentName) })
    let description: string
    if (getModelCapabilities(runtime.model).vision === true) {
      const messages: OpenAI.ChatCompletionMessageParam[] = [{
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          { type: "image_url", image_url: { url: params.imageDataUrl } },
        ],
      }]
      runtime.resetTurnState(messages)
      const signal = params.timeoutMs === undefined ? undefined : AbortSignal.timeout(params.timeoutMs)
      const result = await runtime.streamTurn({
        messages,
        activeTools: [],
        signal,
        callbacks: {
          onModelStart: ignoreProgress,
          onModelStreamStart: ignoreProgress,
          onTextChunk: ignoreProgress,
          onReasoningChunk: ignoreProgress,
          onToolStart: ignoreProgress,
          onToolEnd: ignoreProgress,
          onError(error) { throw error },
        },
      })
      signal?.throwIfAborted()
      if (!result.content.trim() || result.toolCalls.length > 0 || result.termination?.refused
        || result.termination?.finishReason === "length" || result.termination?.finishReason === "incomplete"
        || result.termination?.finishReason === "content_filter") {
        throw new Error(`image description from ${runtime.id} (${runtime.model}) was empty, refused or incomplete; retry the image request`)
      }
      description = result.content
    } else if (runtime.id === "minimax") {
      const credential = await readProviderCredentialRecord(agentName, "minimax")
      const apiKey = credential.ok ? credential.record.credentials.apiKey : undefined
      if (!apiKey) {
        throw new Error("image understanding needs a MiniMax API key in the agent vault — human-required: run `ouro auth --agent <agent> --provider minimax`")
      }
      description = await minimaxVlmDescribe({ ...params, apiKey: String(apiKey), baseURL: MINIMAX_PROVIDER_BASE_URL })
    } else {
      throw new UnsupportedImageModelError(`image understanding: configured outward model ${runtime.id} (${runtime.model}) does not support images; human-choice: select a vision-capable outward model with \`ouro use --agent ${agentName} --lane outward --provider <provider> --model <model>\``)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.image_description_end",
      message: "image description received",
      meta: { provider: runtime.id, model: runtime.model, descriptionLength: description.length },
    })
    return description
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.image_description_error",
      message: "image description unavailable",
      meta: { attachmentId: params.attachmentGuid },
    })
    throw error
  }
}

export interface AttachmentWords {
  /** Lines to add to the turn text: image descriptions and voice-note transcripts. */
  lines: string[]
  notices: string[]
}

/** Turn stored attachments into words for a text-only turn. Other kinds stay listed in the attachment block for the tools. */
export async function attachmentWords(records: readonly AttachmentRecord[], context: {
  agentName: string
  agentRoot: string
  userText?: string
  timeoutMs: number
}): Promise<AttachmentWords> {
  const lines: string[] = []
  const notices: string[] = []
  for (const record of records) {
    try {
      if (record.kind === "image") {
        const image = await materializeAttachment(context.agentName, record.id, { agentRoot: context.agentRoot, variant: "vision_safe" })
        try {
          const description = await describeImage(context.agentName, {
            prompt: imageDescriptionPrompt(context.userText),
            imageDataUrl: await imageFileDataUrl(image.path, image.mimeType),
            attachmentGuid: record.id,
            mimeType: image.mimeType,
            agentRoot: context.agentRoot,
            timeoutMs: context.timeoutMs,
          })
          lines.push(IMAGE_DESCRIPTION_TEXT.description(description))
        } catch (error) {
          lines.push(IMAGE_DESCRIPTION_TEXT.failure(error instanceof Error ? error.message : String(error)))
        }
      } else if (record.kind === "audio") {
        const audio = await materializeAttachment(context.agentName, record.id, { agentRoot: context.agentRoot })
        const result = await voiceNoteLine(record.displayName, audio.path, { timeoutMs: context.timeoutMs })
        if (result.line) lines.push(result.line)
        if (result.notice) notices.push(result.notice)
      }
    } catch (error) {
      notices.push(`attachment hydration failed for ${record.displayName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.attachment_words",
    message: "attachments turned into words for the turn",
    meta: { count: records.length, lines: lines.length, notices: notices.length },
  })
  return { lines, notices }
}

/** Everything a text-only turn shows about its attachments: the list for the tools, then what each one says. */
export async function attachmentTurnLines(records: readonly AttachmentRecord[], context: Parameters<typeof attachmentWords>[1]): Promise<string[]> {
  if (records.length === 0) return []
  const words = await attachmentWords(records, context)
  return [renderAttachmentBlock([...records]), ...words.lines, ...words.notices].filter(Boolean)
}
