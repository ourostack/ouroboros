import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { BlueBubblesAttachmentSummary } from "./bluebubbles-model"

type BlueBubblesConfig = {
  serverUrl: string
  password: string
  accountId: string
}

type BlueBubblesChannelConfig = {
  port: number
  webhookPath: string
  requestTimeoutMs: number
}

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

interface BlueBubblesMediaDeps {
  fetchImpl?: typeof fetch
  transcribeAudio?: (params: BlueBubblesAudioTranscriptionParams) => Promise<string>
  preferAudioInput?: boolean
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".caf", ".ogg"])
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"])
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

function buildBlueBubblesApiUrl(baseUrl: string, endpoint: string, password: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const url = new URL(endpoint.replace(/^\//, ""), root)
  url.searchParams.set("password", password)
  return url.toString()
}

function describeAttachment(attachment: BlueBubblesAttachmentSummary): string {
  return attachment.transferName?.trim() || attachment.guid?.trim() || "attachment"
}

function inferContentType(attachment: BlueBubblesAttachmentSummary, responseType?: string | null): string | undefined {
  const normalizedResponseType = responseType?.split(";")[0]?.trim().toLowerCase()
  if (normalizedResponseType) {
    return normalizedResponseType
  }
  return attachment.mimeType?.trim().toLowerCase() || undefined
}

function isImageAttachment(attachment: BlueBubblesAttachmentSummary, contentType?: string): boolean {
  if (contentType?.startsWith("image/")) return true
  const extension = path.extname(attachment.transferName ?? "").toLowerCase()
  return IMAGE_EXTENSIONS.has(extension)
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

async function transcribeAudioWithWhisper(params: BlueBubblesAudioTranscriptionParams): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-bb-audio-"))
  const filename = sanitizeFilename(describeAttachment(params.attachment))
  const extension = fileExtensionForAudio(params.attachment, params.contentType)
  const audioPath = path.join(workDir, `${path.parse(filename).name}${extension}`)

  try {
    await fs.writeFile(audioPath, params.buffer)
    await new Promise<void>((resolve, reject) => {
      execFile(
        "whisper",
        [
          audioPath,
          "--model",
          "turbo",
          "--output_dir",
          workDir,
          "--output_format",
          "json",
          "--verbose",
          "False",
        ],
        { timeout: Math.max(params.timeoutMs, 120000) },
        (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        },
      )
    })

    const transcriptPath = path.join(workDir, `${path.parse(audioPath).name}.json`)
    const raw = await fs.readFile(transcriptPath, "utf8")
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed.text === "string" ? parsed.text.trim() : ""
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function downloadAttachment(
  attachment: BlueBubblesAttachmentSummary,
  config: BlueBubblesConfig,
  channelConfig: BlueBubblesChannelConfig,
  fetchImpl: typeof fetch,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const guid = attachment.guid?.trim()
  if (!guid) {
    throw new Error("attachment guid missing")
  }
  if (typeof attachment.totalBytes === "number" && attachment.totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`)
  }

  const url = buildBlueBubblesApiUrl(
    config.serverUrl,
    `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    config.password,
  )
  const response = await fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`)
  }

  return {
    buffer,
    contentType: inferContentType(attachment, response.headers.get("content-type")),
  }
}

export async function hydrateBlueBubblesAttachments(
  attachments: BlueBubblesAttachmentSummary[],
  config: BlueBubblesConfig,
  channelConfig: BlueBubblesChannelConfig,
  deps: BlueBubblesMediaDeps = {},
): Promise<BlueBubblesHydratedAttachments> {
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_media_hydrate",
    message: "hydrating bluebubbles attachments",
    meta: {
      attachmentCount: attachments.length,
      preferAudioInput: deps.preferAudioInput ?? false,
    },
  })
  const fetchImpl = deps.fetchImpl ?? fetch
  const transcribeAudio = deps.transcribeAudio ?? transcribeAudioWithWhisper
  const preferAudioInput = deps.preferAudioInput ?? false
  const inputParts: OpenAI.Chat.ChatCompletionContentPart[] = []
  const transcriptAdditions: string[] = []
  const notices: string[] = []

  for (const attachment of attachments) {
    const name = describeAttachment(attachment)
    try {
      const downloaded = await downloadAttachment(attachment, config, channelConfig, fetchImpl)
      const base64 = downloaded.buffer.toString("base64")

      if (isImageAttachment(attachment, downloaded.contentType)) {
        inputParts.push({
          type: "image_url",
          image_url: {
            url: `data:${downloaded.contentType ?? "application/octet-stream"};base64,${base64}`,
            detail: "auto",
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
        transcriptAdditions.push(`voice note transcript: ${transcript}`)
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
