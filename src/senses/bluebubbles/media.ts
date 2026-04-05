import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentToolsRoot } from "../../heart/identity"
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

interface BlueBubblesMediaDeps {
  fetchImpl?: typeof fetch
  modelFetchImpl?: typeof fetch
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
const WHISPER_CPP_FORMULA = "whisper-cpp"
const WHISPER_CPP_MODEL_NAME = "ggml-base.en.bin"
const WHISPER_CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_CPP_MODEL_NAME}`
const WHISPER_CPP_TOOLS_DIR = path.join(getAgentToolsRoot(), "whisper-cpp")
const WHISPER_CPP_MODELS_DIR = path.join(WHISPER_CPP_TOOLS_DIR, "models")
const WHISPER_CPP_MODEL_PATH = path.join(WHISPER_CPP_MODELS_DIR, WHISPER_CPP_MODEL_NAME)

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
  try {
    await fs.access(WHISPER_CPP_MODEL_PATH)
    return WHISPER_CPP_MODEL_PATH
  } catch {
    await fs.mkdir(WHISPER_CPP_MODELS_DIR, { recursive: true })
    const response = await fetchImpl(WHISPER_CPP_MODEL_URL, {
      method: "GET",
      signal: AbortSignal.timeout(Math.max(timeoutMs, 300_000)),
    })
    if (!response.ok) {
      throw new Error(`failed to download whisper.cpp model: HTTP ${response.status}`)
    }
    await fs.writeFile(WHISPER_CPP_MODEL_PATH, Buffer.from(await response.arrayBuffer()))
    return WHISPER_CPP_MODEL_PATH
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
  const modelFetchImpl = deps.modelFetchImpl ?? fetch
  const transcribeAudio = deps.transcribeAudio ?? ((params: BlueBubblesAudioTranscriptionParams) =>
    transcribeAudioWithWhisperCpp(params, modelFetchImpl))
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
