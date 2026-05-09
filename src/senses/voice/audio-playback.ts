import { execFile as execFileCb } from "node:child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { VoiceCallAudioRequest, VoiceCallAudioResult } from "../../repertoire/tools-base"
import { emitNervesEvent } from "../../nerves/runtime"

export interface PreparedVoiceCallAudio extends VoiceCallAudioResult {
  audio: Uint8Array
  mimeType: "audio/x-mulaw;rate=8000"
}

export interface PrepareVoiceCallAudioOptions {
  agentRoot?: string
  ffmpegPath?: string
  ffmpegCandidates?: string[]
  fetchImpl?: typeof fetch
}

const SAMPLE_RATE = 8_000
const DEFAULT_TONE_MS = 700
const DEFAULT_CLIP_MS = 5_000
const MAX_AUDIO_MS = 20_000
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

function clampDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MAX_AUDIO_MS, Math.max(80, Math.round(value)))
}

function clampToneHz(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 660
  return Math.min(3_000, Math.max(80, value))
}

function pcm16ToMulaw(sample: number): number {
  const BIAS = 0x84
  const CLIP = 32635
  let sign = 0
  let magnitude = Math.round(sample)
  if (magnitude < 0) {
    magnitude = -magnitude
    sign = 0x80
  }
  magnitude = Math.min(CLIP, magnitude) + BIAS

  let exponent = 7
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) {
    exponent -= 1
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f
  return (~(sign | (exponent << 4) | mantissa)) & 0xff
}

function generateToneMulaw(toneHz: number, durationMs: number): Uint8Array {
  const sampleCount = Math.max(1, Math.round((SAMPLE_RATE * durationMs) / 1000))
  const out = new Uint8Array(sampleCount)
  for (let i = 0; i < sampleCount; i += 1) {
    const envelope = Math.min(1, i / 160, (sampleCount - i) / 160)
    const sample = Math.sin((2 * Math.PI * toneHz * i) / SAMPLE_RATE) * 9000 * Math.max(0, envelope)
    out[i] = pcm16ToMulaw(sample)
  }
  return out
}

function execFileText(file: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args, { timeout }, (error, stdout = "", stderr = "") => {
      if (error) {
        const message = stderr.toString().trim() || error.message
        reject(new Error(message))
        return
      }
      resolve(stdout.toString())
    })
  })
}

async function convertWithFfmpeg(input: Uint8Array, durationMs: number, options: PrepareVoiceCallAudioOptions): Promise<Uint8Array> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-voice-audio-"))
  const inputPath = path.join(tmpDir, "input.audio")
  const outputPath = path.join(tmpDir, "output.ulaw")
  await fs.writeFile(inputPath, input)
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-t",
    (durationMs / 1000).toFixed(3),
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "mulaw",
    outputPath,
  ]
  const candidates = [
    ...(options.ffmpegCandidates ?? [
      options.ffmpegPath,
      "ffmpeg",
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
    ]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  let lastError: Error | null = null
  try {
    for (const candidate of candidates) {
      try {
        await execFileText(candidate, args)
        return await fs.readFile(outputPath)
      } catch (error) {
        /* v8 ignore next -- child_process errors are Error instances in supported Node runtimes @preserve */
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    /* v8 ignore next -- either a candidate error or an empty candidate list is covered; v8 counts the nullish join as a branch @preserve */
    throw lastError ?? new Error("ffmpeg unavailable")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function readUrlAudio(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("voice audio URL must be http(s)")
  }
  const response = await fetchImpl(parsed.toString())
  if (!response.ok) throw new Error(`voice audio URL fetch failed: ${response.status}`)
  const contentLength = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    throw new Error("voice audio URL is too large")
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  /* v8 ignore next -- oversized response bodies are covered; v8 under-reports the positive branch for arrayBuffer-backed Response @preserve */
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("voice audio URL is too large")
  return bytes
}

async function readFileAudio(inputPath: string, agentRoot?: string): Promise<Uint8Array> {
  const resolved = path.resolve(inputPath)
  const allowedRoots = [
    agentRoot ? path.resolve(agentRoot) : "",
    path.resolve(os.tmpdir()),
  ].filter(Boolean)
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error("voice audio files must live under the agent bundle or temp directory")
  }
  const stat = await fs.stat(resolved)
  if (!stat.isFile()) throw new Error("voice audio path is not a file")
  if (stat.size > MAX_AUDIO_BYTES) throw new Error("voice audio file is too large")
  return fs.readFile(resolved)
}

export async function prepareVoiceCallAudio(
  request: VoiceCallAudioRequest,
  options: PrepareVoiceCallAudioOptions = {},
): Promise<PreparedVoiceCallAudio> {
  const source = request.source ?? "tone"
  const label = request.label?.trim() || (source === "tone" ? "tone" : "audio clip")
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_audio_prepare_start",
    message: "preparing voice call audio clip",
    meta: { source, label },
  })
  try {
    if (source === "tone") {
      const durationMs = clampDuration(request.durationMs, DEFAULT_TONE_MS)
      const prepared = {
        label,
        durationMs,
        mimeType: "audio/x-mulaw;rate=8000" as const,
        audio: generateToneMulaw(clampToneHz(request.toneHz), durationMs),
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_audio_prepare_end",
        message: "prepared voice call audio clip",
        meta: { source, label, durationMs: String(prepared.durationMs), byteLength: String(prepared.audio.byteLength) },
      })
      return prepared
    }

    const durationMs = clampDuration(request.durationMs, DEFAULT_CLIP_MS)
    /* v8 ignore next 3 -- URL and file branches are both covered; optional missing-field fallbacks are defensive @preserve */
    const input = source === "url"
      ? await readUrlAudio(request.url?.trim() || "", options.fetchImpl ?? fetch)
      : await readFileAudio(request.path?.trim() || "", options.agentRoot)
    const audio = await convertWithFfmpeg(input, durationMs, options)
    const prepared = {
      label,
      durationMs: Math.min(durationMs, Math.round((audio.byteLength / SAMPLE_RATE) * 1000)),
      mimeType: "audio/x-mulaw;rate=8000" as const,
      audio,
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_audio_prepare_end",
      message: "prepared voice call audio clip",
      meta: { source, label, durationMs: String(prepared.durationMs), byteLength: String(prepared.audio.byteLength) },
    })
    return prepared
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_audio_prepare_error",
      message: "failed to prepare voice call audio clip",
      /* v8 ignore next -- catches in this module throw Error objects @preserve */
      meta: { source, label, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}
