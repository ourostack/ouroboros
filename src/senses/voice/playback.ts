import * as fs from "fs/promises"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { createNodeVoiceCommandRunner, type VoiceCommandResult, type VoiceCommandRunner } from "./audio-routing"
import type { VoiceTtsDelivery } from "./turn"

export type VoicePlaybackStatus = "written" | "played" | "failed"

export interface VoicePlaybackResult {
  status: VoicePlaybackStatus
  audioPath: string
  byteLength: number
  mimeType: string
  playbackAttempted: boolean
  error?: string
}

export interface VoicePlaybackRequest {
  utteranceId: string
  delivery: Extract<VoiceTtsDelivery, { status: "delivered" }>
  outputDir: string
  playAudio?: boolean
  playbackCommandPath?: string
  commandRunner?: VoiceCommandRunner
  timeoutMs?: number
  mkdir?: (dir: string, options: { recursive: true }) => Promise<unknown>
  writeFile?: (filePath: string, data: Uint8Array) => Promise<unknown>
}

function audioExtension(mimeType: string): string {
  if (mimeType === "audio/mpeg") return "mp3"
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return "wav"
  if (mimeType.startsWith("audio/pcm")) return "pcm"
  return "audio"
}

function safeFileStem(input: string): string {
  const stem = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return stem || "utterance"
}

function commandFailureMessage(exitCode: number, result: VoiceCommandResult): string {
  const stderr = result.stderr?.trim()
  if (stderr) return `exit ${exitCode}: ${stderr}`
  const stdout = result.stdout?.trim()
  if (stdout) return `exit ${exitCode}: ${stdout}`
  return `exit ${exitCode}`
}

export async function writeVoicePlaybackArtifact(request: VoicePlaybackRequest): Promise<VoicePlaybackResult> {
  const mkdir = request.mkdir ?? fs.mkdir
  const writeFile = request.writeFile ?? fs.writeFile
  const commandRunner = request.commandRunner ?? createNodeVoiceCommandRunner()
  const timeoutMs = request.timeoutMs ?? 30_000
  const playbackCommandPath = request.playbackCommandPath ?? "afplay"
  const audioPath = path.join(
    request.outputDir,
    `${safeFileStem(request.utteranceId)}.${audioExtension(request.delivery.mimeType)}`,
  )

  await mkdir(request.outputDir, { recursive: true })
  await writeFile(audioPath, request.delivery.audio)

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_playback_artifact_written",
    message: "voice playback artifact written",
    meta: {
      utteranceId: request.utteranceId,
      audioPath,
      byteLength: request.delivery.byteLength,
      mimeType: request.delivery.mimeType,
    },
  })

  if (request.playAudio !== true) {
    return {
      status: "written",
      audioPath,
      byteLength: request.delivery.byteLength,
      mimeType: request.delivery.mimeType,
      playbackAttempted: false,
    }
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_playback_start",
    message: "starting voice playback",
    meta: { utteranceId: request.utteranceId, audioPath, playbackCommandPath },
  })

  try {
    const result = await commandRunner(playbackCommandPath, [audioPath], { timeoutMs })
    if (typeof result.exitCode === "number" && result.exitCode !== 0) {
      throw new Error(commandFailureMessage(result.exitCode, result))
    }

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_playback_end",
      message: "finished voice playback",
      meta: { utteranceId: request.utteranceId, audioPath },
    })

    return {
      status: "played",
      audioPath,
      byteLength: request.delivery.byteLength,
      mimeType: request.delivery.mimeType,
      playbackAttempted: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_playback_error",
      message: "voice playback failed",
      meta: { utteranceId: request.utteranceId, audioPath, error: message },
    })

    return {
      status: "failed",
      audioPath,
      byteLength: request.delivery.byteLength,
      mimeType: request.delivery.mimeType,
      playbackAttempted: true,
      error: message,
    }
  }
}
