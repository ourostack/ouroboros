import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { buildVoiceTranscript } from "./transcript"
import type { VoiceTranscriber, VoiceTranscriptionRequest, VoiceTranscript } from "./types"

export type WhisperCppProcessRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>

export interface WhisperCppTranscriberOptions {
  whisperCliPath: string
  modelPath: string
  timeoutMs?: number
  processRunner: WhisperCppProcessRunner
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>
  makeTempDir?: () => Promise<string>
  removeDir?: (dir: string) => Promise<void>
}

interface WhisperCppJson {
  text?: unknown
  transcription?: Array<{ text?: unknown }>
}

export function parseWhisperCppTranscriptJson(raw: string): string {
  let parsed: WhisperCppJson
  try {
    parsed = JSON.parse(raw) as WhisperCppJson
  } catch (error) {
    throw new Error(`invalid whisper.cpp JSON: ${String(error)}`)
  }

  const text = typeof parsed.text === "string"
    ? parsed.text.trim()
    : Array.isArray(parsed.transcription)
      ? parsed.transcription
          .map((entry) => typeof entry.text === "string" ? entry.text.trim() : "")
          .filter(Boolean)
          .join(" ")
          .trim()
      : ""

  if (!text) {
    throw new Error("empty whisper.cpp transcript")
  }
  return text
}

async function defaultMakeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ouro-voice-whisper-"))
}

async function defaultRemoveDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

export function createWhisperCppTranscriber(options: WhisperCppTranscriberOptions): VoiceTranscriber {
  const timeoutMs = options.timeoutMs ?? 120_000
  const readFile = options.readFile ?? fs.readFile
  const makeTempDir = options.makeTempDir ?? defaultMakeTempDir
  const removeDir = options.removeDir ?? defaultRemoveDir

  return {
    async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscript> {
      const workDir = await makeTempDir()
      const outputBase = path.join(workDir, "transcript")
      const args = [
        "-m",
        options.modelPath,
        "-f",
        request.audioPath,
        "-oj",
        "-of",
        outputBase,
        ...(request.language ? ["-l", request.language] : []),
      ]

      emitNervesEvent({
        component: "senses",
        event: "senses.voice_stt_start",
        message: "starting Whisper.cpp transcription",
        meta: { utteranceId: request.utteranceId, audioPath: request.audioPath },
      })

      try {
        const result = await options.processRunner(options.whisperCliPath, args, { timeoutMs })
        if (typeof result.exitCode === "number" && result.exitCode !== 0) {
          throw new Error(`exit ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`)
        }
        const raw = await readFile(`${outputBase}.json`, "utf8")
        const text = parseWhisperCppTranscriptJson(raw)
        const transcript = buildVoiceTranscript({
          utteranceId: request.utteranceId,
          text,
          audioPath: request.audioPath,
          language: request.language,
          source: "whisper.cpp",
        })
        emitNervesEvent({
          component: "senses",
          event: "senses.voice_stt_end",
          message: "finished Whisper.cpp transcription",
          meta: { utteranceId: request.utteranceId, length: transcript.text.length },
        })
        return transcript
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_stt_error",
          message: "Whisper.cpp transcription failed",
          meta: { utteranceId: request.utteranceId, error: error instanceof Error ? error.message : String(error) },
        })
        throw new Error(`whisper.cpp transcription failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await removeDir(workDir)
      }
    },
  }
}
