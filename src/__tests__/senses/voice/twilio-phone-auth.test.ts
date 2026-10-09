import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript, closeTwilioPhoneBridgeServer } from "../../../senses/voice"
import * as nerves from "../../../nerves/runtime"
import {
  PendingVoiceCalls,
  mintVoiceCallToken,
  newVoiceCallNonce,
  type VoiceCallIdentity,
} from "../../../senses/voice/call-auth"
import {
  TwilioAudioStreamJobStore,
  TwilioMediaStreamSession,
  computeTwilioSignature,
  startTwilioPhoneBridgeServer,
  writeTwilioOutboundCallJob,
  type TwilioPhoneBridgeOptions,
  type VoiceSessionSocket,
} from "../../../senses/voice/twilio-phone"

const AUTH_TOKEN = "twilio-auth-token-for-tests"
const BASE_URL = "https://voice.example.com"
const LINE = "+15557654321"
const CALLER = "+15551234567"

const dirs: string[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  while (closers.length) await closers.pop()!()
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function fixture(overrides: Partial<TwilioPhoneBridgeOptions> = {}) {
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

function tokenFrom(twiml: unknown): string {
  const match = String(twiml).match(/<Parameter name="OuroToken" value="([^"]+)"/)
  if (!match) throw new Error(`no OuroToken in ${String(twiml)}`)
  return match[1]!
}

function start(callSid: string, customParameters: Record<string, string>, streamSid = `MZ${callSid}`): string {
  return JSON.stringify({ event: "start", start: { streamSid, callSid, customParameters } })
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    socket.once("close", () => resolve())
  })
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function mint(opts: { callSid: string; direction?: "inbound" | "outbound"; nowMs?: number; nonce?: string; outboundId?: string; agentName?: string }): string {
  return mintVoiceCallToken({
    secret: AUTH_TOKEN, purpose: "stream", agentName: opts.agentName ?? "slugger", callSid: opts.callSid,
    direction: opts.direction ?? "inbound", outboundId: opts.outboundId, nowMs: opts.nowMs ?? Date.now(), nonce: opts.nonce ?? newVoiceCallNonce(),
  })
}

function record(pending: PendingVoiceCalls, callSid: string, extra: Partial<VoiceCallIdentity> = {}): string {
  const nonce = newVoiceCallNonce()
  pending.record({ callSid, agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "cascade", ...extra }, nonce)
  return nonce
}

function rejections(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map(([event]) => event as { event: string; meta?: { reason?: string } })
    .filter((event) => event.event === "senses.voice_media_stream_rejected")
    .map((event) => event.meta?.reason ?? "")
}

function mediaStarts(spy: ReturnType<typeof vi.spyOn>): Array<{ callSid: string; sessionKey: string }> {
  return spy.mock.calls
    .map(([event]) => event as { event: string; meta?: { callSid?: string; sessionKey?: string } })
    .filter((event) => event.event === "senses.voice_twilio_media_start")
    .map((event) => ({ callSid: event.meta?.callSid ?? "", sessionKey: event.meta?.sessionKey ?? "" }))
}

const HANGUP = "<Response><Hangup /></Response>"

describe("authenticated Media Stream starts", () => {
  it("mints a token into the TwiML and leaves identity parameters out", async () => {
    const f = await fixture()
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CAtwiml", From: CALLER, To: LINE, FriendId: "evil" })
    const body = String(response.body)

    expect(body).toContain('<Connect action="https://voice.example.com/voice/twilio/stream-ended" method="POST">')
    expect(body).toContain('<Parameter name="OuroToken"')
    expect(body).not.toMatch(/name="(FriendId|From|To|Direction|Remote|Line|InitialAudio|GreetingJobId)"/)
    expect(body.endsWith("</Connect></Response>")).toBe(true)
    expect(f.pending.has("CAtwiml")).toBe(true)
  })

  it("does not mint a token when the CallSid is missing", async () => {
    const f = await fixture()
    const response = await f.post("/voice/twilio/incoming", { From: CALLER, To: LINE })

    expect(String(response.body)).toContain("Sorry, I couldn&apos;t connect this call. Please try again.")
    expect(String(response.body)).not.toContain("OuroToken")
    expect(f.pending.size()).toBe(0)
  })

  it("closes a stream that starts without a token and never runs a turn", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const socket = await f.connect()
    socket.send(start("CAnotoken", { From: CALLER, FriendId: "evil" }))
    await closed(socket)

    expect(rejections(events)).toContain("missing")
    expect(f.runSenseTurn).not.toHaveBeenCalled()
  })

  it("takes identity from the registry, not from stream parameters", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const twiml = (await f.post("/voice/twilio/incoming", { CallSid: "CAreal", From: CALLER, To: LINE })).body
    const socket = await f.connect()
    socket.send(start("CAreal", {
      OuroToken: tokenFrom(twiml), From: "+15559990000", To: "+15558880000", FriendId: "evil",
      Direction: "outbound", Remote: "+15557770000", Line: "+15556660000", InitialAudio: "AAAA", GreetingJobId: "forged",
    }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))

    const { sessionKey } = mediaStarts(events)[0]!
    expect(sessionKey).toMatch(/^twilio-phone-[0-9a-f-]{36}-via-15557654321$/)
    expect(sessionKey).not.toContain("evil")
    const turn = f.runSenseTurn.mock.calls.map(([request]) => request as { userMessage?: string })
    expect(turn.every((request) => !request.userMessage?.includes("9990000"))).toBe(true)
    socket.close()
  })

  it("rejects a reused token and keeps the first session registered", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const twiml = (await f.post("/voice/twilio/incoming", { CallSid: "CAreuse", From: CALLER, To: LINE })).body
    const token = tokenFrom(twiml)
    const first = await f.connect()
    first.send(start("CAreuse", { OuroToken: token }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))

    const second = await f.connect()
    second.send(start("CAreuse", { OuroToken: token }))
    await closed(second)

    expect(rejections(events)).toContain("no_record")
    expect(mediaStarts(events)).toHaveLength(1)
    expect(first.readyState).toBe(WebSocket.OPEN)
    // The refused replay must not turn the connected call into a failure.
    const ended = await f.post("/voice/twilio/stream-ended", { CallSid: "CAreuse" })
    expect(ended.body).toContain(HANGUP)
    first.close()
  })

  it("rejects an expired token", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonce = record(f.pending, "CAold")
    const socket = await f.connect()
    socket.send(start("CAold", { OuroToken: mint({ callSid: "CAold", nonce, nowMs: Date.now() - 10 * 60_000 }) }))
    await closed(socket)

    expect(rejections(events)).toContain("expired")
    expect(f.runSenseTurn).not.toHaveBeenCalled()
  })

  it("rejects a token minted for a different CallSid", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonce = record(f.pending, "CAone")
    const socket = await f.connect()
    socket.send(start("CAtwo", { OuroToken: mint({ callSid: "CAone", nonce }) }))
    await closed(socket)

    expect(rejections(events)).toContain("wrong_call")
    expect(f.pending.has("CAone")).toBe(true)
  })

  it("rejects a token that does not match the recorded direction", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonce = record(f.pending, "CAdir", { direction: "inbound" })
    const socket = await f.connect()
    socket.send(start("CAdir", { OuroToken: mint({ callSid: "CAdir", nonce, direction: "outbound", outboundId: "out-1" }) }))
    await closed(socket)

    expect(rejections(events)).toContain("record_mismatch")
    expect(f.runSenseTurn).not.toHaveBeenCalled()
  })

  it("ignores ?engine= and chooses the session from the record", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonce = record(f.pending, "CAengine", { engine: "cascade" })
    const socket = await f.connect("?engine=openai-realtime")
    socket.send(start("CAengine", { OuroToken: mint({ callSid: "CAengine", nonce }) }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))
    // The cascade session greets through the turn pipeline; a Realtime session would have dialed OpenAI.
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    socket.close()
  })

  it("ignores a second start on the same socket", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonceA = record(f.pending, "CAfirst")
    const nonceB = record(f.pending, "CAsecond")
    const socket = await f.connect()
    socket.send(start("CAfirst", { OuroToken: mint({ callSid: "CAfirst", nonce: nonceA }) }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))
    socket.send(start("CAsecond", { OuroToken: mint({ callSid: "CAsecond", nonce: nonceB }) }))
    await settle()

    expect(mediaStarts(events)).toHaveLength(1)
    expect(f.pending.has("CAsecond")).toBe(true)
    expect(rejections(events)).toEqual([])
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it("refuses a second live stream for the same CallSid without ending the first", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonceA = record(f.pending, "CAdup")
    const first = await f.connect()
    first.send(start("CAdup", { OuroToken: mint({ callSid: "CAdup", nonce: nonceA }) }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))

    const nonceB = record(f.pending, "CAdup")
    const second = await f.connect()
    second.send(start("CAdup", { OuroToken: mint({ callSid: "CAdup", nonce: nonceB }) }))
    await closed(second)

    expect(rejections(events)).toContain("duplicate_call")
    expect(mediaStarts(events)).toHaveLength(1)
    expect(first.readyState).toBe(WebSocket.OPEN)
    first.close()
  })

  it("plays the failure line after a refused stream, and a plain hangup after a normal call", async () => {
    const f = await fixture()
    const restarted = await f.post("/voice/twilio/stream-ended", { CallSid: "CAnever" })
    expect(restarted.body).toContain(HANGUP)

    const socket = await f.connect()
    socket.send(start("CArestart", { OuroToken: mint({ callSid: "CArestart" }) }))
    await closed(socket)
    const refused = await f.post("/voice/twilio/stream-ended", { CallSid: "CArestart" })
    expect(String(refused.body)).toContain("Sorry, I couldn&apos;t connect this call. Please try again.")
    expect(String(refused.body)).toContain("<Hangup />")

    const twiml = (await f.post("/voice/twilio/incoming", { CallSid: "CAnotconnected", From: CALLER, To: LINE })).body
    expect(twiml).toBeDefined()
    const stillPending = await f.post("/voice/twilio/stream-ended", { CallSid: "CAnotconnected" })
    expect(String(stillPending.body)).toContain("Sorry, I couldn&apos;t connect")
  })

  it("lets two overlapping incoming requests each mint a token and accepts only the first use", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const [a, b] = await Promise.all([
      f.post("/voice/twilio/incoming", { CallSid: "CAdouble", From: CALLER, To: LINE }),
      f.post("/voice/twilio/incoming", { CallSid: "CAdouble", From: CALLER, To: LINE }),
    ])
    const [tokenA, tokenB] = [tokenFrom(a.body), tokenFrom(b.body)]
    expect(tokenA).not.toBe(tokenB)

    const first = await f.connect()
    first.send(start("CAdouble", { OuroToken: tokenB }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))
    const second = await f.connect()
    second.send(start("CAdouble", { OuroToken: tokenA }))
    await closed(second)
    expect(mediaStarts(events)).toHaveLength(1)
    first.close()
  })

  it("closes a stream that never sends start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const f = await fixture()
    const socket = await f.connect()
    for (let i = 0; i < 50 && vi.getTimerCount() === 0; i += 1) await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(10_001)
    vi.useRealTimers()
    await closed(socket)

    expect(rejections(events)).toContain("start_timeout")
  })

  it("ignores media and junk that arrive before a verified start", async () => {
    const f = await fixture()
    const socket = await f.connect()
    socket.send("not json")
    socket.send(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0x7f).toString("base64") } }))
    await settle()
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.terminate()
  })

  it("keeps outbound friend and outbound id from the signed job record", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    await writeTwilioOutboundCallJob(f.outputDir, {
      schemaVersion: 1, outboundId: "out-1", agentName: "slugger", friendId: "job-friend",
      from: LINE, to: CALLER, reason: "checking in", createdAt: "2026-10-09T00:00:00.000Z", status: "requested",
    })
    const twiml = (await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAout", To: CALLER, From: LINE })).body
    const socket = await f.connect()
    socket.send(start("CAout", { OuroToken: tokenFrom(twiml), FriendId: "evil", OutboundId: "other" }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))

    expect(mediaStarts(events)[0]!.sessionKey).toContain("job-friend")
    expect(mediaStarts(events)[0]!.sessionKey).not.toContain("evil")
    socket.close()
  })

  it("does not use defaultFriendId for inbound callers on any transport", async () => {
    const media = await fixture({ defaultFriendId: "ari" })
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const twiml = (await media.post("/voice/twilio/incoming", { CallSid: "CAdefault", From: "+15550001111", To: LINE })).body
    const socket = await media.connect()
    socket.send(start("CAdefault", { OuroToken: tokenFrom(twiml) }))
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))
    expect(mediaStarts(events)[0]!.sessionKey).not.toContain("-ari-")
    expect((media.runSenseTurn.mock.calls[0]![0] as { friendId: string }).friendId).not.toBe("ari")
    socket.close()

    const legacy = await fixture({ defaultFriendId: "ari", transportMode: "record-play" })
    await legacy.post("/voice/twilio/incoming", { CallSid: "CAlegacy", From: "+15550002222", To: LINE })
    await vi.waitFor(() => expect(legacy.runSenseTurn).toHaveBeenCalled())
    expect((legacy.runSenseTurn.mock.calls[0]![0] as { friendId: string }).friendId).not.toBe("ari")

    const recording = await fixture({ defaultFriendId: "ari", transportMode: "record-play" })
    await recording.post("/voice/twilio/recording", {
      CallSid: "CArec", RecordingSid: "RE1", RecordingUrl: "https://api.twilio.com/Recordings/RE1", From: "+15550003333", To: LINE,
    })
    expect((recording.runSenseTurn.mock.calls[0]![0] as { friendId: string }).friendId).not.toBe("ari")
  })

  it("fails closed for unsigned webhooks when no Twilio auth token is configured", async () => {
    const f = await fixture({ twilioAuthToken: undefined })
    const response = await f.server.bridge.handle({
      method: "POST", path: "/voice/twilio/incoming", headers: {}, body: "CallSid=CAx&From=%2B15551234567",
    })
    expect(response.statusCode).toBe(403)
    expect(f.pending.size()).toBe(0)
  })
})

describe("media stream session over a VoiceSessionSocket", () => {
  function fakeSocket() {
    const handlers: { message?: (raw: never) => void; close?: () => void; error?: (error: Error) => void } = {}
    const sent: string[] = []
    let open = true
    const socket: VoiceSessionSocket = {
      send: (data) => { sent.push(data) },
      close: () => { open = false },
      isOpen: () => open,
      on: ((event: "message" | "close" | "error", callback: never) => { (handlers as Record<string, unknown>)[event] = callback }) as VoiceSessionSocket["on"],
    }
    return { socket, handlers, sent, isOpen: () => open }
  }

  it("runs a session from an in-process socket and accepts every raw message shape", async () => {
    const f = await fixture()
    const fake = fakeSocket()
    const identity: VoiceCallIdentity = { callSid: "CAlocal", agentName: "slugger", direction: "inbound", from: "", to: "", engine: "cascade" }
    const session = new TwilioMediaStreamSession(fake.socket, identity, f.options, new TwilioAudioStreamJobStore())
    session.attach()

    const startJson = start("CAlocal", {})
    fake.handlers.message!(startJson as never)
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalledTimes(1))
    // A repeat start is ignored whatever shape it arrives in.
    session.handleRawMessage(Buffer.from(startJson))
    session.handleRawMessage([Buffer.from(startJson.slice(0, 10)), Buffer.from(startJson.slice(10))])
    session.handleRawMessage(new TextEncoder().encode(startJson).buffer as ArrayBuffer)
    await settle()
    expect(f.runSenseTurn).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(fake.sent.length).toBeGreaterThan(0))
    expect(fake.isOpen()).toBe(true)
    fake.handlers.error!(new Error("socket broke"))
    fake.handlers.close!()
    session.end()
    expect(fake.isOpen()).toBe(false)
  })
})
