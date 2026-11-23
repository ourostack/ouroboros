import { execFile } from "node:child_process"
import { createWriteStream } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentToolsRoot } from "../identity"

// One speech-to-text path for every sense: a voice note from iMessage, Telegram or Teams becomes text the same way.

const WHISPER_CPP_FORMULA = "whisper-cpp"
// large-v3-turbo hears far better than base.en, and it is multilingual. q5_0 keeps it near 575 MB.
const WHISPER_CPP_MODEL_NAME = "ggml-large-v3-turbo-q5_0.bin"
const WHISPER_CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_CPP_MODEL_NAME}`
// The model earlier versions downloaded. While the stronger one downloads, a machine that has it keeps transcribing with it.
const WHISPER_CPP_EARLIER_MODEL_NAME = "ggml-base.en.bin"
const WHISPER_CPP_MODEL_DOWNLOAD_TIMEOUT_MS = 900_000
// Beam search over five candidates, keeping the best of five: slower than greedy decoding, and fewer misheard words.
const WHISPER_CPP_DECODING_ARGS = ["-bs", "5", "-bo", "5"]

/** How every sense labels a voice note's text, so the agent reads it as a machine transcript that can mishear. */
export const VOICE_NOTE_TRANSCRIPT_PREFIX = "voice note (machine transcript; may mishear words): "

export interface TranscribeAudioOptions {
  timeoutMs: number
  fetchImpl?: typeof fetch
  /** Words whisper should expect (names, topics, the conversation so far); passed as whisper's initial prompt. */
  prompt?: string
}

interface WhisperCppModel {
  path: string
  multilingual: boolean
}

/** The text of a whisper.cpp `-oj` transcript, or "" when it holds no speech. */
export function whisperCppTranscriptText(raw: string): string {
  const parsed = JSON.parse(raw) as { text?: unknown; transcription?: Array<{ text?: unknown }> }
  if (typeof parsed.text === "string") return parsed.text.trim()
  if (!Array.isArray(parsed.transcription)) return ""
  return parsed.transcription
    .map((entry) => (typeof entry?.text === "string" ? entry.text.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim()
}

async function execFileText(file: string, args: string[], timeout: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout }, (error, stdout = "", stderr = "") => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
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
    if (existing) return existing
  } catch {
    // not on PATH; try Homebrew
  }

  let prefix = ""
  try {
    prefix = (await execFileText("brew", ["--prefix", WHISPER_CPP_FORMULA], timeoutMs)).trim()
    if (prefix) {
      const candidate = path.join(prefix, "bin", "whisper-cli")
      if (await pathExists(candidate)) return candidate
    }
  } catch {
    // not installed through Homebrew yet
  }

  try {
    await execFileText("brew", ["install", WHISPER_CPP_FORMULA], Math.max(timeoutMs, 300_000))
  } catch (error) {
    throw new Error(`whisper-cli is not on PATH and installing it with Homebrew failed (${(error as Error).message}); install whisper.cpp so whisper-cli is on PATH`)
  }
  prefix = (await execFileText("brew", ["--prefix", WHISPER_CPP_FORMULA], timeoutMs)).trim()
  if (!prefix) throw new Error("whisper.cpp installed but brew did not return a usable prefix")
  const candidate = path.join(prefix, "bin", "whisper-cli")
  if (!await pathExists(candidate)) throw new Error("whisper.cpp installed but whisper-cli binary is missing")
  return candidate
}

async function downloadWhisperCppModel(modelPath: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  // Written beside the model and renamed into place, so a cut-off download never looks like a model.
  const partialPath = `${modelPath}.partial`
  try {
    const response = await fetchImpl(WHISPER_CPP_MODEL_URL, {
      method: "GET",
      signal: AbortSignal.timeout(Math.max(timeoutMs, WHISPER_CPP_MODEL_DOWNLOAD_TIMEOUT_MS)),
    })
    if (!response.ok) throw new Error(`failed to download whisper.cpp model: HTTP ${response.status}`)
    if (!response.body) throw new Error("failed to download whisper.cpp model: the response had no body")
    await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(partialPath))
    await fs.rename(partialPath, modelPath)
    emitNervesEvent({ component: "senses", event: "senses.whisper_model_downloaded", message: "whisper.cpp model downloaded", meta: { model: WHISPER_CPP_MODEL_NAME } })
    return modelPath
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined)
    throw error
  }
}

let pendingModelDownload: Promise<string> | undefined

function downloadWhisperCppModelOnce(modelPath: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  pendingModelDownload ??= downloadWhisperCppModel(modelPath, timeoutMs, fetchImpl).finally(() => {
    pendingModelDownload = undefined
  })
  return pendingModelDownload
}

async function ensureWhisperCppModel(timeoutMs: number, fetchImpl: typeof fetch): Promise<WhisperCppModel> {
  // Resolved per call: the tools root needs the agent identity, which is not known at module load.
  const modelsDir = path.join(getAgentToolsRoot(), "whisper-cpp", "models")
  const modelPath = path.join(modelsDir, WHISPER_CPP_MODEL_NAME)
  if (await pathExists(modelPath)) return { path: modelPath, multilingual: true }
  await fs.mkdir(modelsDir, { recursive: true })
  const earlierModelPath = path.join(modelsDir, WHISPER_CPP_EARLIER_MODEL_NAME)
  if (await pathExists(earlierModelPath)) {
    downloadWhisperCppModelOnce(modelPath, timeoutMs, fetchImpl).catch((error: unknown) => {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.whisper_model_download_failed",
        message: "whisper.cpp model download failed; voice notes keep using the earlier model",
        meta: { model: WHISPER_CPP_MODEL_NAME, error: error instanceof Error ? error.message : String(error) },
      })
    })
    return { path: earlierModelPath, multilingual: false }
  }
  return { path: await downloadWhisperCppModelOnce(modelPath, timeoutMs, fetchImpl), multilingual: true }
}

async function convertToWhisperWav(sourcePath: string, outputPath: string, timeoutMs: number): Promise<void> {
  try {
    await execFileText(
      "ffmpeg",
      ["-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath],
      Math.max(timeoutMs, 120_000),
    )
  } catch (ffmpegError) {
    try {
      await execFileText(
        "afconvert",
        ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", sourcePath, outputPath],
        Math.max(timeoutMs, 120_000),
      )
    } catch (afconvertError) {
      throw new Error(`failed to prepare audio for whisper.cpp (ffmpeg: ${(ffmpegError as Error).message}; afconvert: ${(afconvertError as Error).message})`)
    }
  }
}

/** Transcribe one audio file of any format ffmpeg reads. Returns "" when the audio holds no speech. */
export async function transcribeAudioFile(audioPath: string, options: TranscribeAudioOptions): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-audio-"))
  const wavPath = path.join(workDir, "audio.wav")
  const outputBase = path.join(workDir, "audio")
  try {
    const whisperCliPath = await resolveWhisperCppBinary(options.timeoutMs)
    const model = await ensureWhisperCppModel(options.timeoutMs, options.fetchImpl ?? fetch)
    await convertToWhisperWav(audioPath, wavPath, options.timeoutMs)
    const prompt = options.prompt?.trim()
    await execFileText(whisperCliPath, [
      "-m", model.path,
      "-f", wavPath,
      "-oj", "-of", outputBase,
      ...WHISPER_CPP_DECODING_ARGS,
      // whisper-cli assumes English unless told; a multilingual model detects the spoken language.
      "-l", model.multilingual ? "auto" : "en",
      ...(prompt ? ["--prompt", prompt] : []),
    ], Math.max(options.timeoutMs, 120_000))
    const transcript = whisperCppTranscriptText(await fs.readFile(`${outputBase}.json`, "utf8"))
    emitNervesEvent({ component: "senses", event: "senses.audio_transcribed", message: "audio transcribed with whisper.cpp", meta: { characters: transcript.length } })
    return transcript
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The line a sense adds to the turn for one voice note's transcript, or the notice when it held no speech. */
export function voiceNoteWords(name: string, transcript: string): { line?: string; notice?: string } {
  const text = transcript.trim()
  return text
    ? { line: `${VOICE_NOTE_TRANSCRIPT_PREFIX}${text}` }
    : { notice: `attachment hydration failed for ${name}: empty audio transcript` }
}

/** Transcribe one voice note and word it for the turn. */
export async function voiceNoteLine(name: string, audioPath: string, options: TranscribeAudioOptions): Promise<{ line?: string; notice?: string }> {
  return voiceNoteWords(name, await transcribeAudioFile(audioPath, options))
}
