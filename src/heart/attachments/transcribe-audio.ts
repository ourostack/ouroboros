import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentToolsRoot } from "../identity"

// One speech-to-text path for every sense: a voice note from iMessage, Telegram or Teams becomes text the same way.

const WHISPER_CPP_FORMULA = "whisper-cpp"
const WHISPER_CPP_MODEL_NAME = "ggml-base.en.bin"
const WHISPER_CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_CPP_MODEL_NAME}`

export const VOICE_NOTE_TRANSCRIPT_PREFIX = "voice note transcript: "

export interface TranscribeAudioOptions {
  timeoutMs: number
  fetchImpl?: typeof fetch
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

async function ensureWhisperCppModel(timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  // Resolved per call: the tools root needs the agent identity, which is not known at module load.
  const modelsDir = path.join(getAgentToolsRoot(), "whisper-cpp", "models")
  const modelPath = path.join(modelsDir, WHISPER_CPP_MODEL_NAME)
  if (await pathExists(modelPath)) return modelPath
  await fs.mkdir(modelsDir, { recursive: true })
  const response = await fetchImpl(WHISPER_CPP_MODEL_URL, {
    method: "GET",
    signal: AbortSignal.timeout(Math.max(timeoutMs, 300_000)),
  })
  if (!response.ok) throw new Error(`failed to download whisper.cpp model: HTTP ${response.status}`)
  await fs.writeFile(modelPath, Buffer.from(await response.arrayBuffer()))
  return modelPath
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
    const modelPath = await ensureWhisperCppModel(options.timeoutMs, options.fetchImpl ?? fetch)
    await convertToWhisperWav(audioPath, wavPath, options.timeoutMs)
    await execFileText(whisperCliPath, ["-m", modelPath, "-f", wavPath, "-oj", "-of", outputBase], Math.max(options.timeoutMs, 120_000))
    const transcript = whisperCppTranscriptText(await fs.readFile(`${outputBase}.json`, "utf8"))
    emitNervesEvent({ component: "senses", event: "senses.audio_transcribed", message: "audio transcribed with whisper.cpp", meta: { characters: transcript.length } })
    return transcript
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The line a sense adds to the turn for one voice note, or the notice when it held no speech. */
export async function voiceNoteLine(name: string, audioPath: string, options: TranscribeAudioOptions): Promise<{ line?: string; notice?: string }> {
  const transcript = (await transcribeAudioFile(audioPath, options)).trim()
  return transcript
    ? { line: `${VOICE_NOTE_TRANSCRIPT_PREFIX}${transcript}` }
    : { notice: `attachment hydration failed for ${name}: empty audio transcript` }
}
