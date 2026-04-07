import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentToolsRoot } from "../../heart/identity"
import { getModelCapabilities } from "../../heart/model-capabilities"
import { rememberBlueBubblesAttachment } from "./attachment-cache"
import type { BlueBubblesAttachmentSummary } from "./model"

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

// Pin the exact wrapper strings so tests and code read from one source.
export const VLM_TEXT_WRAPPERS = {
  description: (desc: string): string => `[image description: ${desc}]`,
  unsupported: (mimeType: string): string =>
    `[image attachment not shown: unsupported format ${mimeType}]`,
  failure: (reason: string): string => `[image description failed: ${reason}]`,
} as const

// VLM supported formats for the /v1/coding_plan/vlm endpoint. The client in
// minimax-vlm.ts enforces the same set — this helper lets the sense skip the
// call entirely and emit a clearer `vision_format_unsupported` event instead
// of letting the VLM client throw.
const VLM_SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])

function isSupportedVlmFormat(contentType: string): boolean {
  return VLM_SUPPORTED_MIME_TYPES.has(contentType.toLowerCase())
}

// D3 prompt template. Included here (not templated out) because the contract
// is load-bearing — see planning doc section D3 and AX-4.
function buildVlmPrompt(userText: string | undefined): string {
  const body = userText ?? ""
  return `User message: "${body}"\n\nDescribe this image in detail, focusing on anything relevant to what the user said above.\nInclude any text visible in the image verbatim.`
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
const WHISPER_CPP_FORMULA = "whisper-cpp"
const WHISPER_CPP_MODEL_NAME = "ggml-base.en.bin"
const WHISPER_CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_CPP_MODEL_NAME}`

// Lazy — getAgentToolsRoot() requires identity to be resolved, which isn't
// true at module-load time in most unit test contexts. Tests that only touch
// the image/VLM path shouldn't break because the audio path asked for a
// tools root they don't need.
function whisperCppPaths(): { toolsDir: string; modelsDir: string; modelPath: string } {
  const toolsDir = path.join(getAgentToolsRoot(), "whisper-cpp")
  const modelsDir = path.join(toolsDir, "models")
  const modelPath = path.join(modelsDir, WHISPER_CPP_MODEL_NAME)
  return { toolsDir, modelsDir, modelPath }
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

async function execFileText(file: string, args: string[], timeout: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout }, (error, stdout = "", stderr = "") => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message
        reject(new Error(detail))
        return
      }
      resolve(stdout)
    })
  })
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function resolveWhisperCppBinary(timeoutMs: number): Promise<string> {
  try {
    const existing = (await execFileText("which", ["whisper-cli"], timeoutMs)).trim()
    if (existing) {
      return existing
    }
  } catch {
    // fall through to managed install
  }

  let prefix = ""
  try {
    prefix = (await execFileText("brew", ["--prefix", WHISPER_CPP_FORMULA], timeoutMs)).trim()
    if (prefix) {
      const candidate = path.join(prefix, "bin", "whisper-cli")
      if (await pathExists(candidate)) {
        return candidate
      }
    }
  } catch {
    // fall through to managed install
  }

  await execFileText("brew", ["install", WHISPER_CPP_FORMULA], Math.max(timeoutMs, 300_000))
  prefix = (await execFileText("brew", ["--prefix", WHISPER_CPP_FORMULA], timeoutMs)).trim()
  if (!prefix) {
    throw new Error("whisper.cpp installed but brew did not return a usable prefix")
  }
  const candidate = path.join(prefix, "bin", "whisper-cli")
  if (!await pathExists(candidate)) {
    throw new Error("whisper.cpp installed but whisper-cli binary is missing")
  }
  return candidate
}

async function ensureWhisperCppModel(timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  const { modelsDir, modelPath } = whisperCppPaths()
  try {
    await fs.access(modelPath)
    return modelPath
  } catch {
    await fs.mkdir(modelsDir, { recursive: true })
    const response = await fetchImpl(WHISPER_CPP_MODEL_URL, {
      method: "GET",
      signal: AbortSignal.timeout(Math.max(timeoutMs, 300_000)),
    })
    if (!response.ok) {
      throw new Error(`failed to download whisper.cpp model: HTTP ${response.status}`)
    }
    await fs.writeFile(modelPath, Buffer.from(await response.arrayBuffer()))
    return modelPath
  }
}

async function convertAudioForWhisperCpp(sourcePath: string, outputPath: string, timeoutMs: number): Promise<void> {
  try {
    await execFileText(
      "ffmpeg",
      ["-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath],
      Math.max(timeoutMs, 120_000),
    )
    return
  } catch (ffmpegError) {
    try {
      await execFileText(
        "afconvert",
        ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", sourcePath, outputPath],
        Math.max(timeoutMs, 120_000),
      )
      return
    } catch (afconvertError) {
      const ffmpegReason = (ffmpegError as Error).message
      const afconvertReason = (afconvertError as Error).message
      throw new Error(`failed to prepare audio for whisper.cpp (ffmpeg: ${ffmpegReason}; afconvert: ${afconvertReason})`)
    }
  }
}

async function transcribeAudioWithWhisperCpp(
  params: BlueBubblesAudioTranscriptionParams,
  modelFetchImpl: typeof fetch = fetch,
): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-bb-audio-"))
  const filename = sanitizeFilename(describeAttachment(params.attachment))
  const extension = fileExtensionForAudio(params.attachment, params.contentType)
  const audioPath = path.join(workDir, `${path.parse(filename).name}${extension}`)
  const wavPath = path.join(workDir, `${path.parse(audioPath).name}.wav`)
  const outputBase = path.join(workDir, path.parse(audioPath).name)

  try {
    await fs.writeFile(audioPath, params.buffer)
    const whisperCliPath = await resolveWhisperCppBinary(params.timeoutMs)
    const modelPath = await ensureWhisperCppModel(params.timeoutMs, modelFetchImpl)
    await convertAudioForWhisperCpp(audioPath, wavPath, params.timeoutMs)
    await execFileText(
      whisperCliPath,
      ["-m", modelPath, "-f", wavPath, "-oj", "-of", outputBase],
      Math.max(params.timeoutMs, 120_000),
    )

    const transcriptPath = `${outputBase}.json`
    const raw = await fs.readFile(transcriptPath, "utf8")
    const parsed = JSON.parse(raw) as { text?: unknown; transcription?: Array<{ text?: unknown }> }
    if (typeof parsed.text === "string") {
      return parsed.text.trim()
    }
    if (Array.isArray(parsed.transcription)) {
      return parsed.transcription
        .map((entry) => (typeof entry?.text === "string" ? entry.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
        .trim()
    }
    return ""
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachmentSummary,
  config: BlueBubblesConfig,
  channelConfig: BlueBubblesChannelConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ buffer: Buffer; contentType?: string }> {
  return downloadAttachment(attachment, config, channelConfig, fetchImpl)
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
  const fetchImpl = deps.fetchImpl ?? fetch
  const modelFetchImpl = deps.modelFetchImpl ?? fetch
  const transcribeAudio = deps.transcribeAudio ?? ((params: BlueBubblesAudioTranscriptionParams) =>
    transcribeAudioWithWhisperCpp(params, modelFetchImpl))
  const preferAudioInput = deps.preferAudioInput ?? false
  const chatModel = deps.chatModel
  const visionCapable = chatModel ? getModelCapabilities(chatModel).vision === true : true
  const inputParts: OpenAI.Chat.ChatCompletionContentPart[] = []
  const transcriptAdditions: string[] = []
  const notices: string[] = []

  for (const attachment of attachments) {
    const name = describeAttachment(attachment)
    // Remember every attachment we see — the describe_image agent tool looks
    // up guids against this cache later to re-fetch bytes on demand.
    rememberBlueBubblesAttachment(attachment)
    try {
      const downloaded = await downloadAttachment(attachment, config, channelConfig, fetchImpl)
      const base64 = downloaded.buffer.toString("base64")
      const byteCount = downloaded.buffer.length

      if (isImageAttachment(attachment, downloaded.contentType)) {
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

        // Non-vision chat model — try the VLM describe fallback.
        if (!isSupportedVlmFormat(mimeType)) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_vision_format_unsupported",
            message: "bluebubbles vision format unsupported",
            meta: {
              mimeType,
              transferName: attachment.transferName,
              attachmentGuid: attachment.guid,
              chatModel,
            },
          })
          inputParts.push({
            type: "text",
            text: VLM_TEXT_WRAPPERS.unsupported(mimeType),
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
              hydrationPath: "skip-unsupported",
            },
          })
          continue
        }

        const dataUrl = `data:${mimeType};base64,${base64}`
        try {
          if (!deps.vlmDescribe) {
            throw new Error(
              "no VLM describer configured — wire a vlmDescribe dep or configure a vision-capable chat model",
            )
          }
          const description = await deps.vlmDescribe({
            prompt: buildVlmPrompt(deps.userText),
            imageDataUrl: dataUrl,
            attachmentGuid: attachment.guid,
            mimeType,
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
            mimeType,
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
