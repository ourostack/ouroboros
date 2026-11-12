import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentName, getAgentRoot } from "../../heart/identity"
import { transcribeAudioFile, VOICE_NOTE_TRANSCRIPT_PREFIX } from "../../heart/attachments/transcribe-audio"
import { IMAGE_DESCRIPTION_TEXT, imageDescriptionPrompt } from "../../heart/attachments/understand"
import { getModelCapabilities } from "../../heart/model-capabilities"
import { normalizeImageForVision } from "../../heart/attachments/image-normalize"
import { cacheRecentAttachment } from "../../heart/attachments/store"
import {
  buildBlueBubblesAttachmentRecord,
  persistBlueBubblesAttachmentSource,
} from "../../heart/attachments/sources/bluebubbles"
import type { BlueBubblesAttachmentSummary } from "./model"
import {
  downloadBlueBubblesAttachment,
  isBlueBubblesImageAttachment,
  type BlueBubblesChannelConfig,
  type BlueBubblesConfig,
} from "./attachment-download"

export interface BlueBubblesHydratedAttachments {
  inputParts: OpenAI.Chat.ChatCompletionContentPart[]
  transcriptAdditions: string[]
  notices: string[]
}

export interface BlueBubblesAudioTranscriptionParams {
  attachment: BlueBubblesAttachmentSummary
  buffer: Buffer
  contentType?: string
  timeoutMs: number
}

/**
 * VLM describe function injected by the BlueBubbles client. This is the
 * shape of `minimaxVlmDescribe` minus the apiKey/baseURL fields (those are
 * bound once at the call site so `hydrateBlueBubblesAttachments` stays
 * provider-agnostic). Returns the description text, or throws an
 * AX-2-compliant Error on any failure.
 */
export type VlmDescribeFn = (params: {
  prompt: string
  imageDataUrl: string
  attachmentGuid?: string
  mimeType?: string
  chatModel?: string
}) => Promise<string>

interface BlueBubblesMediaDeps {
  fetchImpl?: typeof fetch
  modelFetchImpl?: typeof fetch
  transcribeAudio?: (params: BlueBubblesAudioTranscriptionParams) => Promise<string>
  preferAudioInput?: boolean
  /**
   * Active chat model for this turn. When the model has `vision: true` in
   * ModelCapabilities, images are passed through natively as `image_url`
   * content parts. Otherwise the sense falls back to `vlmDescribe` and
   * replaces the image with a text description.
   *
   * When undefined, defaults to the legacy pass-through behavior (backward
   * compat with existing callers that don't yet thread `chatModel` through).
   */
  chatModel?: string
  /**
   * VLM describe function. Only invoked when `chatModel` lacks vision
   * capability and the attachment is a supported format (png/jpeg/webp).
   */
  vlmDescribe?: VlmDescribeFn
  /**
   * Inbound user text, used to construct the D3 VLM prompt template. When
   * omitted, the template still renders with an empty string so the
   * structure is consistent for image-only messages.
   */
  userText?: string
}

export const VLM_TEXT_WRAPPERS = IMAGE_DESCRIPTION_TEXT

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".caf", ".ogg"])
const AUDIO_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp3": ".mp3",
  "audio/mpeg": ".mp3",
  "audio/x-caf": ".caf",
  "audio/caf": ".caf",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
}
const AUDIO_INPUT_FORMAT_BY_CONTENT_TYPE: Record<string, "mp3" | "wav"> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
}
const AUDIO_INPUT_FORMAT_BY_EXTENSION: Record<string, "mp3" | "wav"> = {
  ".wav": "wav",
  ".mp3": "mp3",
}
function describeAttachment(attachment: BlueBubblesAttachmentSummary): string {
  return attachment.transferName?.trim() || attachment.guid?.trim() || "attachment"
}

function isAudioAttachment(attachment: BlueBubblesAttachmentSummary, contentType?: string): boolean {
  if (contentType?.startsWith("audio/")) return true
  const extension = path.extname(attachment.transferName ?? "").toLowerCase()
  return AUDIO_EXTENSIONS.has(extension)
}

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[\r\n"\\]/g, "_")
}

function fileExtensionForAudio(attachment: BlueBubblesAttachmentSummary, contentType?: string): string {
  const transferExt = path.extname(attachment.transferName ?? "").toLowerCase()
  if (transferExt) {
    return transferExt
  }
  if (contentType && AUDIO_EXTENSION_BY_CONTENT_TYPE[contentType]) {
    return AUDIO_EXTENSION_BY_CONTENT_TYPE[contentType]
  }
  return ".audio"
}

function audioFormatForInput(contentType?: string, attachment?: BlueBubblesAttachmentSummary): "mp3" | "wav" | undefined {
  const extension = path.extname(attachment?.transferName ?? "").toLowerCase()
  return AUDIO_INPUT_FORMAT_BY_CONTENT_TYPE[contentType ?? ""] ?? AUDIO_INPUT_FORMAT_BY_EXTENSION[extension]
}

async function transcribeAudioWithWhisperCpp(
  params: BlueBubblesAudioTranscriptionParams,
  modelFetchImpl: typeof fetch = fetch,
): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-bb-audio-"))
  const filename = sanitizeFilename(describeAttachment(params.attachment))
  const audioPath = path.join(workDir, `${path.parse(filename).name}${fileExtensionForAudio(params.attachment, params.contentType)}`)
  try {
    await fs.writeFile(audioPath, params.buffer)
    return await transcribeAudioFile(audioPath, { timeoutMs: params.timeoutMs, fetchImpl: modelFetchImpl })
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { downloadBlueBubblesAttachment } from "./attachment-download"

export async function hydrateBlueBubblesAttachments(
  attachments: BlueBubblesAttachmentSummary[],
  config: BlueBubblesConfig,
  channelConfig: BlueBubblesChannelConfig,
  deps: BlueBubblesMediaDeps = {},
): Promise<BlueBubblesHydratedAttachments> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const modelFetchImpl = deps.modelFetchImpl ?? fetch
  const transcribeAudio = deps.transcribeAudio ?? ((params: BlueBubblesAudioTranscriptionParams) =>
    transcribeAudioWithWhisperCpp(params, modelFetchImpl))
  const preferAudioInput = deps.preferAudioInput ?? false
  const chatModel = deps.chatModel
  const visionCapable = chatModel ? getModelCapabilities(chatModel).vision === true : true
  const agentName = getAgentName()
  const agentRoot = getAgentRoot(agentName)
  const inputParts: OpenAI.Chat.ChatCompletionContentPart[] = []
  const transcriptAdditions: string[] = []
  const notices: string[] = []

  for (const attachment of attachments) {
    const name = describeAttachment(attachment)
    const initialRecord = attachment.guid?.trim()
      ? cacheRecentAttachment(agentName, buildBlueBubblesAttachmentRecord(attachment), agentRoot)
      : null
    try {
      const downloaded = await downloadBlueBubblesAttachment(attachment, config, channelConfig, fetchImpl)
      const base64 = downloaded.buffer.toString("base64")
      const byteCount = downloaded.buffer.length
      const persistedRecord = initialRecord && initialRecord.source === "bluebubbles"
        ? await persistBlueBubblesAttachmentSource(
            agentName,
            initialRecord,
            {
              buffer: downloaded.buffer,
              mimeType: downloaded.contentType,
              byteCount,
            },
            agentRoot,
          )
        : null

      if (isBlueBubblesImageAttachment(attachment, downloaded.contentType)) {
        const mimeType = downloaded.contentType ?? "application/octet-stream"
        if (visionCapable) {
          inputParts.push({
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
              detail: "auto",
            },
          })
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_media_hydrate",
            message: "bluebubbles media hydrate",
            meta: {
              attachmentGuid: attachment.guid,
              mimeType,
              byteCount,
              hydrationPath: "native-passthrough",
            },
          })
          continue
        }

        try {
          if (!deps.vlmDescribe) {
            throw new Error(
              "no VLM describer configured — wire a vlmDescribe dep or configure a vision-capable chat model",
            )
          }
          if (!persistedRecord?.sourceData.localPath) {
            throw new Error("image attachment could not be persisted for normalization")
          }
          const normalized = await normalizeImageForVision({
            attachment: persistedRecord,
            sourcePath: persistedRecord.sourceData.localPath,
            agentName,
            agentRoot,
          })
          const normalizedBuffer = await fs.readFile(normalized.path)
          const normalizedMime = normalized.mimeType ?? persistedRecord.mimeType ?? "image/jpeg"
          const dataUrl = `data:${normalizedMime};base64,${normalizedBuffer.toString("base64")}`
          const description = await deps.vlmDescribe({
            prompt: imageDescriptionPrompt(deps.userText),
            imageDataUrl: dataUrl,
            attachmentGuid: attachment.guid,
            mimeType: normalizedMime,
            chatModel,
          })
          inputParts.push({
            type: "text",
            text: VLM_TEXT_WRAPPERS.description(description),
          })
        } catch (vlmError) {
          const reason = vlmError instanceof Error ? vlmError.message : String(vlmError)
          inputParts.push({
            type: "text",
            text: VLM_TEXT_WRAPPERS.failure(reason),
          })
        }
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_media_hydrate",
          message: "bluebubbles media hydrate",
          meta: {
            attachmentGuid: attachment.guid,
            mimeType: persistedRecord?.mimeType ?? mimeType,
            byteCount,
            hydrationPath: "vlm-describe",
          },
        })
        continue
      }

      if (isAudioAttachment(attachment, downloaded.contentType)) {
        const audioFormat = audioFormatForInput(downloaded.contentType, attachment)
        if (preferAudioInput && audioFormat) {
          inputParts.push({
            type: "input_audio",
            input_audio: {
              data: base64,
              format: audioFormat,
            },
          })
          continue
        }
        const transcript = (await transcribeAudio({
          attachment,
          buffer: downloaded.buffer,
          contentType: downloaded.contentType,
          timeoutMs: channelConfig.requestTimeoutMs,
        })).trim()
        if (!transcript) {
          notices.push(`attachment hydration failed for ${name}: empty audio transcript`)
          continue
        }
        transcriptAdditions.push(`${VOICE_NOTE_TRANSCRIPT_PREFIX}${transcript}`)
        continue
      }

      inputParts.push({
        type: "file",
        file: {
          file_data: base64,
          filename: sanitizeFilename(name),
        },
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      notices.push(`attachment hydration failed for ${name}: ${reason}`)
    }
  }

  return {
    inputParts,
    transcriptAdditions,
    notices,
  }
}
