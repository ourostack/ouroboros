import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { WebSocket } from "ws"
import { vi } from "vitest"
import { buildVoiceTranscript, closeTwilioPhoneBridgeServer } from "../../../senses/voice"
import {
  PendingVoiceCalls,
  mintVoiceCallToken,
  newVoiceCallNonce,
  type VoiceCallIdentity,
} from "../../../senses/voice/call-auth"
import {
  computeTwilioSignature,
  startTwilioPhoneBridgeServer,
  type TwilioPhoneBridgeOptions,
} from "../../../senses/voice/twilio-phone"

export const AUTH_TOKEN = "twilio-auth-token-for-tests"
export const BASE_URL = "https://voice.example.com"
export const LINE = "+15557654321"
export const CALLER = "+15551234567"

export const dirs: string[] = []
export const closers: Array<() => Promise<void>> = []

export async function cleanupFixtures(): Promise<void> {
  vi.restoreAllMocks()
  vi.useRealTimers()
  while (closers.length) await closers.pop()!()
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
}

export async function fixture(overrides: Partial<TwilioPhoneBridgeOptions> = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-voice-auth-"))
  dirs.push(outputDir)
  const pending = new PendingVoiceCalls()
  const runSenseTurn = vi.fn(async (request: { userMessage?: string }) => ({
    response: `heard: ${request.userMessage ?? ""}`,
    ponderDeferred: false,
  }))
  const options = {
    agentName: "slugger",
    agentRoot: path.join(outputDir, "slugger.ouro"),
    publicBaseUrl: BASE_URL,
    outputDir,
    transcriber: { transcribe: vi.fn(async (request: { utteranceId: string; audioPath: string }) => buildVoiceTranscript({ utteranceId: request.utteranceId, text: "hi", audioPath: request.audioPath, source: "whisper.cpp" })) },
    tts: {
      synthesize: vi.fn(async (request: { utteranceId: string }) => ({
        utteranceId: request.utteranceId, audio: Buffer.from("mp3"), byteLength: 3, chunkCount: 1,
        modelId: "m", voiceId: "v", mimeType: "audio/mpeg",
      })),
    },
    runSenseTurn,
    downloadRecording: vi.fn(async () => Buffer.from("wav")),
    playbackMode: "buffered" as const,
    transportMode: "media-stream" as const,
    twilioAuthToken: AUTH_TOKEN,
    pendingVoiceCalls: pending,
    port: 0,
    host: "127.0.0.1",
    ...overrides,
  } as unknown as TwilioPhoneBridgeOptions & { port: number }
  const server = await startTwilioPhoneBridgeServer(options)
  closers.push(() => closeTwilioPhoneBridgeServer(server))
  const sockets: WebSocket[] = []
  closers.push(async () => { for (const socket of sockets) socket.terminate() })
  return {
    options, pending, runSenseTurn, outputDir, server,
    async post(route: string, params: Record<string, string>) {
      const body = new URLSearchParams(params).toString()
      return server.bridge.handle({
        method: "POST", path: route, body,
        headers: { "x-twilio-signature": computeTwilioSignature({ authToken: AUTH_TOKEN, url: new URL(route, BASE_URL).toString(), params }) },
      })
    },
    async connect(query = ""): Promise<WebSocket> {
      const socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream${query}`)
      sockets.push(socket)
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
      return socket
    },
  }
}

export function tokenFrom(twiml: unknown): string {
  const match = String(twiml).match(/<Parameter name="OuroToken" value="([^"]+)"/)
  if (!match) throw new Error(`no OuroToken in ${String(twiml)}`)
  return match[1]!
}

export function start(callSid: string, customParameters: Record<string, string>, streamSid = `MZ${callSid}`): string {
  return JSON.stringify({ event: "start", start: { streamSid, callSid, customParameters } })
}

export function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    socket.once("close", () => resolve())
  })
}

export async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function mint(opts: { callSid: string; direction?: "inbound" | "outbound"; nowMs?: number; nonce?: string; outboundId?: string; agentName?: string }): string {
  return mintVoiceCallToken({
    secret: AUTH_TOKEN, purpose: "stream", agentName: opts.agentName ?? "slugger", callSid: opts.callSid,
    direction: opts.direction ?? "inbound", outboundId: opts.outboundId, nowMs: opts.nowMs ?? Date.now(), nonce: opts.nonce ?? newVoiceCallNonce(),
  })
}

export function record(pending: PendingVoiceCalls, callSid: string, extra: Partial<VoiceCallIdentity> = {}): string {
  const nonce = newVoiceCallNonce()
  pending.record({ callSid, agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "cascade", ...extra }, nonce)
  return nonce
}

export function rejections(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map(([event]) => event as { event: string; meta?: { reason?: string } })
    .filter((event) => event.event === "senses.voice_media_stream_rejected")
    .map((event) => event.meta?.reason ?? "")
}

export function mediaStarts(spy: ReturnType<typeof vi.spyOn>): Array<{ callSid: string; sessionKey: string }> {
  return spy.mock.calls
    .map(([event]) => event as { event: string; meta?: { callSid?: string; sessionKey?: string } })
    .filter((event) => event.event === "senses.voice_twilio_media_start")
    .map((event) => ({ callSid: event.meta?.callSid ?? "", sessionKey: event.meta?.sessionKey ?? "" }))
}

export const HANGUP = "<Response><Hangup /></Response>"

