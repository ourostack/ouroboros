import { emitNervesEvent } from "../../nerves/runtime"
import {
  type VoiceTtsRequest,
  type VoiceTtsResult,
  type VoiceTtsService,
} from "./types"

export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5"
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "pcm_16000"
export const DEFAULT_ELEVENLABS_MIME_TYPE = "audio/pcm;rate=16000"

export interface ElevenLabsSocketLike {
  on(event: "open" | "message" | "error" | "close", handler: (payload?: unknown) => void): void
  send(payload: string): void
  close(): void
}

export interface ElevenLabsTtsClientOptions {
  apiKey: string
  voiceId: string
  modelId?: string
  outputFormat?: string
  socketFactory: (url: string) => ElevenLabsSocketLike
}

function cleanTtsText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function elevenLabsStreamUrl(voiceId: string, modelId: string, outputFormat: string): string {
  const params = new URLSearchParams({ model_id: modelId, output_format: outputFormat })
  return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${params.toString()}`
}

function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload
  if (Buffer.isBuffer(payload)) return payload.toString("utf8")
  return String(payload ?? "")
}

export function createElevenLabsTtsClient(options: ElevenLabsTtsClientOptions): VoiceTtsService {
  const modelId = options.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID
  const outputFormat = options.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT
  const mimeType = outputFormat === DEFAULT_ELEVENLABS_OUTPUT_FORMAT
    ? DEFAULT_ELEVENLABS_MIME_TYPE
    : "audio/mpeg"

  return {
    async synthesize(request: VoiceTtsRequest): Promise<VoiceTtsResult> {
      const text = cleanTtsText(request.text)
      if (!text) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_tts_error",
          message: "voice TTS text is empty",
          meta: { utteranceId: request.utteranceId },
        })
        throw new Error("voice TTS text is empty")
      }

      const url = elevenLabsStreamUrl(options.voiceId, modelId, outputFormat)
      const socket = options.socketFactory(url)
      const chunks: Buffer[] = []

      emitNervesEvent({
        component: "senses",
        event: "senses.voice_tts_start",
        message: "starting ElevenLabs TTS",
        meta: { utteranceId: request.utteranceId, modelId, voiceId: options.voiceId },
      })

      return new Promise<VoiceTtsResult>((resolve, reject) => {
        let settled = false

        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          const message = error instanceof Error ? error.message : String(error)
          emitNervesEvent({
            level: "error",
            component: "senses",
            event: "senses.voice_tts_error",
            message: "ElevenLabs TTS failed",
            meta: { utteranceId: request.utteranceId, error: message },
          })
          reject(new Error(`ElevenLabs TTS failed: ${message}`))
        }

        const finish = (): void => {
          if (settled) return
          settled = true
          const audio = Buffer.concat(chunks)
          emitNervesEvent({
            component: "senses",
            event: "senses.voice_tts_end",
            message: "finished ElevenLabs TTS",
            meta: { utteranceId: request.utteranceId, chunkCount: chunks.length, byteLength: audio.byteLength },
          })
          socket.close()
          resolve({
            utteranceId: request.utteranceId,
            audio,
            byteLength: audio.byteLength,
            chunkCount: chunks.length,
            modelId,
            voiceId: options.voiceId,
            mimeType,
          })
        }

        socket.on("open", () => {
          socket.send(JSON.stringify({
            text: " ",
            xi_api_key: options.apiKey,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              use_speaker_boost: true,
            },
          }))
          socket.send(JSON.stringify({ text, try_trigger_generation: true }))
          socket.send(JSON.stringify({ text: "" }))
        })

        socket.on("message", (payload) => {
          try {
            const parsed = JSON.parse(payloadText(payload)) as { audio?: unknown; isFinal?: unknown }
            if (typeof parsed.audio === "string" && parsed.audio.length > 0) {
              chunks.push(Buffer.from(parsed.audio, "base64"))
            }
            if (parsed.isFinal === true) {
              finish()
            }
          } catch (error) {
            fail(error)
          }
        })

        socket.on("error", fail)
        socket.on("close", () => {
          if (!settled) {
            fail(new Error("socket closed before final audio"))
          }
        })
      })
    },
  }
}
