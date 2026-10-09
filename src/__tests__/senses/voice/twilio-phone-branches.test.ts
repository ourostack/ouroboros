import * as fs from "fs/promises"
import * as path from "path"
import { WebSocket, WebSocketServer } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import * as nerves from "../../../nerves/runtime"
import type { VoiceCallIdentity } from "../../../senses/voice/call-auth"
import {
  TwilioAudioStreamJobStore,
  TwilioMediaStreamSession,
  TwilioOpenAIRealtimeMediaStreamSession,
  computeTwilioSignature,
  createTwilioPhoneBridge,
  wsAsVoiceSessionSocket,
  writeTwilioOutboundCallJob,
  type TwilioOutboundCallJob,
  type TwilioPhoneBridgeOptions,
  type VoiceSessionSocket,
} from "../../../senses/voice/twilio-phone"
import {
  AUTH_TOKEN, BASE_URL, CALLER, LINE, cleanupFixtures, closed, closers, fixture, mediaStarts, mint, record, settle, start, tokenFrom,
} from "./twilio-auth-fixture"

afterEach(cleanupFixtures)

function job(overrides: Partial<TwilioOutboundCallJob> = {}): TwilioOutboundCallJob {
  return {
    schemaVersion: 1, outboundId: "out-1", agentName: "slugger", friendId: "job-friend",
    from: LINE, to: CALLER, reason: "checking in", createdAt: "2026-10-09T00:00:00.000Z", status: "requested",
    ...overrides,
  }
}

const failingTurn = () => vi.fn(async () => {
  throw new Error("model offline")
})

describe("incoming webhook branches", () => {
  it("records the STIR/SHAKEN verdict the signed webhook carried", async () => {
    const f = await fixture()
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CAstir", From: CALLER, To: LINE, StirVerstat: "TN-Validation-Passed-A" })
    expect(String(response.body)).toContain("OuroToken")
    expect(f.pending.has("CAstir")).toBe(true)
  })

  it("connects the stream without a greeting job when the greeting could not be prepared", async () => {
    const f = await fixture({ runSenseTurn: failingTurn() as never, greetingPrebufferMs: 200 })
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CAfailgreet", From: CALLER, To: LINE })
    expect(String(response.body)).toContain("OuroToken")
    expect(f.pending.has("CAfailgreet")).toBe(true)
  })

  it("still connects the stream when the call directory cannot be created", async () => {
    const f = await fixture()
    f.options.outputDir = "/dev/null/not-a-dir"
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CAnodir", From: CALLER, To: LINE })
    expect(String(response.body)).toContain("OuroToken")
  })

  it("falls back to recording TwiML when a streamed greeting cannot be prepared", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "stream", runSenseTurn: failingTurn() as never, greetingPrebufferMs: 200, recordTimeoutSeconds: 4, recordMaxLengthSeconds: 25 })
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CArecfail", From: CALLER, To: LINE })
    expect(String(response.body)).toContain("<Record")
    expect(String(response.body)).toContain('timeout="4"')
    expect(String(response.body)).toContain('maxLength="25"')
  })

  it("uses the default record limits when the greeting turn fails outright", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "buffered" })
    f.options.outputDir = "/dev/null/not-a-dir"
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CArecerr", From: CALLER, To: LINE })
    expect(String(response.body)).toContain("<Record")
  })

  it("plays a streamed greeting in record-and-play mode", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "stream" })
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CAplay", From: CALLER, To: LINE })
    expect(String(response.body)).toContain("<Play>")
  })
})

describe("outgoing webhook branches", () => {
  it("answers 404 for an unknown outbound call", async () => {
    const f = await fixture()
    expect((await f.post("/voice/twilio/outgoing/nope", { CallSid: "CAx" })).statusCode).toBe(404)
  })

  it("answers 404 for an unknown suffix under an outgoing call", async () => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, job())
    expect((await f.post("/voice/twilio/outgoing/out-1/bogus", { CallSid: "CAx" })).statusCode).toBe(404)
  })

  it("hangs up on voicemail and records the verdict", async () => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, job())
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAvm", AnsweredBy: "machine_start" })
    expect(String(response.body)).toContain("<Hangup />")
    const stored = JSON.parse(await fs.readFile(path.join(f.outputDir, "outbound", "out-1.json"), "utf8").catch(() => "{}")) as { status?: string }
    expect(stored.status === undefined || stored.status === "voicemail").toBe(true)
  })

  it("does not treat a missing answered-by verdict as voicemail", async () => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, job())
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAhuman", AnsweredBy: "human", From: "not a phone", To: "also not" })
    expect(String(response.body)).toContain("OuroToken")
  })

  it.each([
    ["the job's transport CallSid", { transportCallSid: "CAfromjob" }],
    ["a generated CallSid", {}],
  ])("fails the stream closed when the webhook has no CallSid, using %s for logging only", async (_label, extra) => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, job(extra))
    const response = await f.post("/voice/twilio/outgoing/out-1", { To: CALLER, From: LINE })
    expect(String(response.body)).toContain("couldn&apos;t connect this call")
    expect(String(response.body)).not.toContain("OuroToken")
    expect(f.pending.size()).toBe(0)
  })

  it("falls back to the configured or caller-derived friend when the job names none", async () => {
    const withDefault = await fixture({ defaultFriendId: "configured-friend" })
    await writeTwilioOutboundCallJob(withDefault.outputDir, job({ friendId: undefined }))
    expect(String((await withDefault.post("/voice/twilio/outgoing/out-1", { CallSid: "CAdefault" })).body)).toContain("OuroToken")

    const withoutDefault = await fixture()
    await writeTwilioOutboundCallJob(withoutDefault.outputDir, job({ friendId: " " }))
    expect(String((await withoutDefault.post("/voice/twilio/outgoing/out-1", { CallSid: "CAderived" })).body)).toContain("OuroToken")
  })

  it("serves a prewarmed greeting and passes the initial audio through the record", async () => {
    const f = await fixture({ greetingPrebufferMs: 200 })
    const audioPath = path.join(f.outputDir, "prewarm.mp3")
    await fs.writeFile(audioPath, Buffer.from("prewarmed"))
    await writeTwilioOutboundCallJob(f.outputDir, job({
      prewarmedGreeting: { audioPath, mimeType: "audio/mpeg", byteLength: 9 },
      initialAudio: { source: "tone", label: "chime", toneHz: 440, durationMs: 100 },
    } as never))
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAprewarm", To: CALLER, From: LINE })
    expect(String(response.body)).toContain("OuroToken")
    expect(f.pending.has("CAprewarm")).toBe(true)
  })

  it("moves on when the prewarmed greeting file cannot be read", async () => {
    const f = await fixture({ greetingPrebufferMs: 200 })
    await writeTwilioOutboundCallJob(f.outputDir, job({ prewarmedGreeting: { audioPath: path.join(f.outputDir, "missing.mp3"), mimeType: "audio/mpeg", byteLength: 1 } } as never))
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAnoprewarm", To: CALLER, From: LINE })
    expect(String(response.body)).toContain("OuroToken")
  })

  it("connects without a greeting job when the outbound greeting cannot be prepared", async () => {
    const f = await fixture({ runSenseTurn: failingTurn() as never, greetingPrebufferMs: 200 })
    await writeTwilioOutboundCallJob(f.outputDir, job())
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAfailout", To: CALLER, From: LINE })
    expect(String(response.body)).toContain("OuroToken")
  })

  it("still connects when the outbound call directory cannot be created", async () => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, job())
    await fs.writeFile(path.join(f.outputDir, "CAmkdir"), "a file where the call directory should be")
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAmkdir", To: CALLER, From: LINE })
    expect(String(response.body)).toContain("OuroToken")
  })

  it("connects an outbound Realtime call through a token", async () => {
    const f = await fixture({ conversationEngine: "openai-realtime", outboundConversationEngine: "openai-realtime", openaiRealtime: { apiKey: "k", websocketUrl: "ws://127.0.0.1:9" } } as never)
    await writeTwilioOutboundCallJob(f.outputDir, job())
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CArt", To: CALLER, From: LINE })
    expect(String(response.body)).toContain("OuroToken")
  })

  it("greets in record-and-play mode, with recording TwiML when that fails", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "buffered" })
    await writeTwilioOutboundCallJob(f.outputDir, job())
    expect(String((await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CArp", To: CALLER, From: LINE })).body)).toContain("<Play>")

    const failing = await fixture({ transportMode: "record-play", playbackMode: "buffered", runSenseTurn: failingTurn() as never, recordTimeoutSeconds: 5, recordMaxLengthSeconds: 15 })
    await writeTwilioOutboundCallJob(failing.outputDir, job())
    const response = await failing.post("/voice/twilio/outgoing/out-1", { CallSid: "CArpfail", To: CALLER, From: LINE })
    expect(String(response.body)).toContain("<Record")
    expect(String(response.body)).toContain('timeout="5"')
  })

  it("uses default record limits when the outbound greeting fails", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "buffered", runSenseTurn: failingTurn() as never })
    await writeTwilioOutboundCallJob(f.outputDir, job())
    expect(String((await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CArpdefault", To: CALLER, From: LINE })).body)).toContain("<Record")
  })
})

describe("more webhook edges", () => {
  it("falls back to the job's own numbers when the webhook carries unusable ones", async () => {
    const f = await fixture()
    await writeTwilioOutboundCallJob(f.outputDir, job({ from: "line-one", to: "callee-one" }))
    const response = await f.post("/voice/twilio/outgoing/out-1", { CallSid: "CAjobnums", From: "junk", To: "junk" })
    expect(String(response.body)).toContain("OuroToken")
  })

  it("forwards the STIR/SHAKEN verdict to the SIP leg", async () => {
    const f = await fixture({ conversationEngine: "openai-sip", openaiSip: { projectId: "p", webhookPath: "/voice/sip", webhookSecret: "whsec_x" } } as never)
    const response = await f.post("/voice/twilio/incoming", { CallSid: "CAsipstir", From: CALLER, To: LINE, StirVerstat: "TN-Validation-Passed-A" })
    expect(String(response.body)).toContain("<Sip>")
  })

  it("settles a stream-ended callback that carries no CallSid", async () => {
    const f = await fixture()
    expect(String((await f.post("/voice/twilio/stream-ended", {})).body)).toContain("<Hangup />")
  })
})

describe("recording callback friend resolution", () => {
  it("keeps the configured friend for outbound recordings and the signed caller for inbound ones", async () => {
    const f = await fixture({ transportMode: "record-play", defaultFriendId: "configured-friend", twilioAuthToken: AUTH_TOKEN })
    await f.post("/voice/twilio/recording", { CallSid: "CAo", RecordingSid: "RE1", RecordingUrl: "https://api.twilio.com/Recordings/RE1", From: CALLER, To: LINE, Direction: "outbound-api" })
    expect((f.runSenseTurn.mock.calls[0]![0] as { friendId: string }).friendId).toBe("configured-friend")

    await f.post("/voice/twilio/recording", { CallSid: "CAi", RecordingSid: "RE2", RecordingUrl: "https://api.twilio.com/Recordings/RE2", From: CALLER, To: LINE, Direction: "inbound" })
    expect((f.runSenseTurn.mock.calls[1]![0] as { friendId: string }).friendId).not.toBe("configured-friend")
  })

  it("downloads recordings without credentials when the token and account are blank", async () => {
    const f = await fixture({ transportMode: "record-play", twilioAccountSid: "AC1" } as never)
    await f.post("/voice/twilio/recording", { CallSid: "CAdl", RecordingSid: "RE3", RecordingUrl: "https://api.twilio.com/Recordings/RE3", From: CALLER, To: LINE })
    expect(f.options.downloadRecording).toHaveBeenCalledWith(expect.objectContaining({ authToken: AUTH_TOKEN, accountSid: "AC1" }))
    f.options.twilioAuthToken = " "
  })
})

describe("bridge routing", () => {
  it("answers health and unknown routes", async () => {
    const f = await fixture({ openaiSip: { projectId: "p", webhookPath: "/voice/sip", webhookSecret: "whsec_x" } } as never)
    expect((await f.server.bridge.handle({ method: "GET", path: "/voice/sip/health", headers: {}, body: "" })).statusCode).toBe(200)
    expect((await f.server.bridge.handle({ method: "GET", path: "/voice/twilio/health", headers: {}, body: "" })).statusCode).toBe(200)
    expect((await f.server.bridge.handle({ method: "GET", path: "/nope", headers: {}, body: "" })).statusCode).toBe(404)
    expect((await f.server.bridge.handle({ method: "DELETE", path: "/voice/twilio/incoming", headers: {}, body: "" })).statusCode).toBe(405)
    expect((await f.post("/voice/twilio/outgoing/", { CallSid: "x" })).statusCode).toBe(404)
    expect((await f.post("/voice/twilio/outgoing/%2e%2e", { CallSid: "x" })).statusCode).toBe(404)
  })

  it("refuses WebSocket upgrades outside the media-stream route", async () => {
    const f = await fixture()
    const socket = new WebSocket(`${f.server.localUrl.replace("http:", "ws:")}/voice/twilio/other`)
    await expect(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })).rejects.toBeDefined()

    const recordPlay = await fixture({ transportMode: "record-play" })
    const other = new WebSocket(`${recordPlay.server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
    await expect(new Promise((resolve, reject) => { other.once("open", resolve); other.once("error", reject) })).rejects.toBeDefined()
  })

  it("handles upgrade requests that carry no URL", async () => {
    const bridge = createTwilioPhoneBridge({ ...(await fixture()).options })
    expect(bridge.handleUpgrade!({ url: undefined } as never, {} as never, Buffer.alloc(0))).toBe(false)
    await bridge.close()
  })

  it("reports an error when the bridge is closed twice", async () => {
    const bridge = createTwilioPhoneBridge({ ...(await fixture()).options })
    await bridge.close()
    await expect(bridge.close()).rejects.toBeDefined()
  })

  it("starts a bridge without an injected registry", async () => {
    const f = await fixture()
    const { pendingVoiceCalls: _unused, ...rest } = f.options as TwilioPhoneBridgeOptions & { pendingVoiceCalls?: unknown }
    const bridge = createTwilioPhoneBridge(rest as TwilioPhoneBridgeOptions)
    const params = { CallSid: "CAown", From: CALLER, To: LINE }
    const response = await bridge.handle({
      method: "POST", path: "/voice/twilio/incoming", body: new URLSearchParams(params).toString(),
      headers: { "x-twilio-signature": computeTwilioSignature({ authToken: AUTH_TOKEN, url: new URL("/voice/twilio/incoming", BASE_URL).toString(), params }) },
    })
    expect(String(response.body)).toContain("OuroToken")
    await bridge.close()
  })
})

describe("media stream admission edges", () => {
  it("refuses a start with no CallSid", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const socket = await f.connect()
    socket.send(JSON.stringify({ event: "start", start: { streamSid: "MZ", customParameters: {} } }))
    await closed(socket)
    expect(events.mock.calls.some(([event]) => (event as { meta?: { callSid?: string } }).meta?.callSid === "unknown")).toBe(true)
  })

  it("refuses every start when no auth token is configured", async () => {
    const f = await fixture({ twilioAuthToken: undefined })
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const socket = await f.connect()
    socket.send(start("CAnosecret", { OuroToken: mint({ callSid: "CAnosecret" }) }))
    await closed(socket)
    expect(events.mock.calls.some(([event]) => (event as { meta?: { reason?: string } }).meta?.reason === "no_secret")).toBe(true)
  })

  it("ignores a start that arrives after the start window closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const f = await fixture()
    const socket = await f.connect()
    for (let i = 0; i < 50 && vi.getTimerCount() === 0; i += 1) await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(10_001)
    vi.useRealTimers()
    await closed(socket)
    expect(f.pending.size()).toBe(0)
  })

  it("chooses a Realtime session for a record that names no engine when Realtime is configured", async () => {
    const f = await fixture({ conversationEngine: "openai-realtime", openaiRealtime: { apiKey: "k", websocketUrl: "ws://127.0.0.1:9" } } as never)
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonce = record(f.pending, "CAnoengine", { engine: undefined })
    const socket = await f.connect()
    socket.send(start("CAnoengine", { OuroToken: mint({ callSid: "CAnoengine", nonce }) }))
    await settle(300)
    expect(f.pending.has("CAnoengine")).toBe(false)
    expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_media_stream_rejected")).toBe(false)
    socket.terminate()
  })
})

describe("SIP webhook payload edges", () => {
  it("ignores other event types and rejects payloads without a call id", async () => {
    const f = await fixture({ conversationEngine: "openai-sip", openaiSip: { projectId: "p", webhookPath: "/voice/sip", webhookSecret: "whsec_c2VjcmV0" } } as never)
    const sign = async (payload: string) => {
      const { computeOpenAIWebhookSignature } = await import("../../../senses/voice/twilio-phone")
      const timestamp = String(Math.floor(Date.now() / 1_000))
      return f.server.bridge.handle({
        method: "POST", path: "/voice/sip", body: payload,
        headers: { "webhook-id": `wh-${payload.length}`, "webhook-timestamp": timestamp, "webhook-signature": `v1,${computeOpenAIWebhookSignature({ secret: "whsec_c2VjcmV0", webhookId: `wh-${payload.length}`, timestamp, payload })}` },
      })
    }
    expect((await sign(JSON.stringify({ type: "realtime.call.ended" }))).statusCode).toBe(200)
    expect((await sign(JSON.stringify({ type: "realtime.call.incoming" }))).statusCode).toBe(400)
    expect((await sign("[1")).statusCode).toBe(400)
  })

  it("rejects a bad call through the global fetch when no fetch hook is configured", async () => {
    const original = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const f = await fixture({
        conversationEngine: "openai-sip",
        openaiRealtime: { apiKey: "k", websocketUrl: "ws://127.0.0.1:9" },
        openaiSip: { projectId: "p", webhookPath: "/voice/sip", webhookSecret: "whsec_c2VjcmV0", apiBaseUrl: "https://api.openai.test/v1" },
      } as never)
      const { computeOpenAIWebhookSignature } = await import("../../../senses/voice/twilio-phone")
      const payload = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "call_x", sip_headers: [] } })
      const timestamp = String(Math.floor(Date.now() / 1_000))
      await f.server.bridge.handle({
        method: "POST", path: "/voice/sip", body: payload,
        headers: { "webhook-id": "wh-fetch", "webhook-timestamp": timestamp, "webhook-signature": `v1,${computeOpenAIWebhookSignature({ secret: "whsec_c2VjcmV0", webhookId: "wh-fetch", timestamp, payload })}` },
      })
      expect(fetchMock).toHaveBeenCalledWith("https://api.openai.test/v1/realtime/calls/call_x/reject", expect.anything())
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("socket adapter", () => {
  it("only closes a websocket that is still open or connecting", async () => {
    const f = await fixture()
    const ws = await f.connect()
    const adapted = wsAsVoiceSessionSocket(ws)
    expect(adapted.isOpen()).toBe(true)
    adapted.close()
    await closed(ws)
    expect(adapted.isOpen()).toBe(false)
    expect(() => adapted.close()).not.toThrow()
  })
})

function fakeSocket() {
  const handlers: { message?: (raw: never) => void; close?: () => void; error?: (error: Error) => void } = {}
  const sent: string[] = []
  const state = { open: true, sendsBeforeClosing: Infinity }
  const socket: VoiceSessionSocket = {
    send: (data) => {
      sent.push(data)
      if (sent.length >= state.sendsBeforeClosing) state.open = false
    },
    close: () => { state.open = false },
    isOpen: () => state.open,
    on: ((event: "message" | "close" | "error", callback: never) => { (handlers as Record<string, unknown>)[event] = callback }) as VoiceSessionSocket["on"],
  }
  return { socket, handlers, sent, state }
}

function media(byte: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, byte).toString("base64") }, ...extra })
}

describe("cascade media stream session edges", () => {
  const identity = (overrides: Partial<VoiceCallIdentity> = {}): VoiceCallIdentity => ({
    callSid: "CAedge", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "cascade", ...overrides,
  })

  it("ignores malformed media, short blips and stale marks, and finishes speech on stop", async () => {
    const f = await fixture({ mediaMinSpeechMs: 60, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage("123")
    session.handleRawMessage(start("CAedge", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())

    session.handleRawMessage(JSON.stringify({ event: "media", media: {} }))
    session.handleRawMessage(JSON.stringify({ event: "media", media: { payload: "=" } }))
    session.handleRawMessage(JSON.stringify({ event: "unknown" }))
    session.handleRawMessage(JSON.stringify({ event: "mark", mark: {} }))
    // One voiced frame then silence: below the minimum speech length, so no utterance.
    session.handleRawMessage(media(0x00))
    session.handleRawMessage(media(0xff))
    session.handleRawMessage(media(0xff))
    const turns = f.runSenseTurn.mock.calls.length
    // Speech cut off by the caller hanging up still becomes a turn.
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0x00))
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
    await settle(300)
    expect(f.runSenseTurn.mock.calls.length).toBeGreaterThanOrEqual(turns)
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
  })

  it("answers ordinary speech without treating it as a barge-in", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAedge", {}))
    await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"mark"'))).toBe(true))
    const mark = (JSON.parse(fake.sent.find((raw) => raw.includes('"mark"'))!) as { mark: { name: string } }).mark.name
    session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: mark } }))

    const turns = f.runSenseTurn.mock.calls.length
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0x00))
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0xff))
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBeGreaterThan(turns))
    expect(fake.sent.some((raw) => raw.includes('"clear"'))).toBe(false)
  })

  it("does not start a turn after the stream stopped, and drops audio the socket cannot take", async () => {
    const f = await fixture()
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAedge", {}))
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
    await settle(200)
    expect(f.runSenseTurn).not.toHaveBeenCalled()

    const internals = session as unknown as {
      sendAudioChunk(chunk: Uint8Array, generation: number): void
      sendMark(generation: number, utteranceId: string): void
      runTranscriptTurn(transcript: ReturnType<typeof buildVoiceTranscript>, wasBargeIn: boolean): Promise<void>
    }
    internals.sendAudioChunk(Buffer.from("x"), 1)
    internals.sendMark(1, "u")
    expect(fake.sent.filter((raw) => raw.includes('"media"') || raw.includes('"mark"'))).toHaveLength(0)
    await internals.runTranscriptTurn(buildVoiceTranscript({ utteranceId: "u", text: "hi", source: "loopback" }), false)
    expect(f.runSenseTurn).not.toHaveBeenCalled()
  })

  it("stops sending when the socket closes or the playback generation moves on", async () => {
    const f = await fixture()
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAedge", {}))
    await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"mark"'))).toBe(true))
    const internals = session as unknown as {
      sendAudioChunk(chunk: Uint8Array, generation: number): void
      sendMark(generation: number, utteranceId: string): void
      playbackGeneration: number
      streamSid: string
    }
    const before = fake.sent.length
    internals.sendAudioChunk(Buffer.from("x"), internals.playbackGeneration + 5)
    internals.sendMark(internals.playbackGeneration + 5, "u")
    const sid = internals.streamSid
    internals.streamSid = ""
    internals.sendAudioChunk(Buffer.from("x"), internals.playbackGeneration)
    internals.sendMark(internals.playbackGeneration, "u")
    internals.streamSid = sid
    fake.state.open = false
    internals.sendAudioChunk(Buffer.from("x"), internals.playbackGeneration)
    internals.sendMark(internals.playbackGeneration, "u")
    expect(fake.sent.length).toBe(before)
  })

  it("does not interrupt playback that is not active or has no open socket", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAedge", {}))
    await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"mark"'))).toBe(true))
    fake.state.open = false
    // Playback is active, but the socket is gone: voiced audio must not try to clear it.
    session.handleRawMessage(media(0x00))
    expect(fake.sent.some((raw) => raw.includes('"clear"'))).toBe(false)
  })

  it("starts outbound calls with an unsafe or missing friend id from the configured friend", async () => {
    const f = await fixture({ defaultFriendId: "configured-friend" })
    for (const friendId of [undefined, "../bad"]) {
      const fake = fakeSocket()
      const events = vi.spyOn(nerves, "emitNervesEvent")
      const session = new TwilioMediaStreamSession(fake.socket, identity({ direction: "outbound", outboundId: "out-1", friendId, callSid: `CAout${friendId ? "bad" : "none"}` }), f.options, new TwilioAudioStreamJobStore())
      session.attach()
      session.handleRawMessage(start(`CAout${friendId ? "bad" : "none"}`, {}))
      await vi.waitFor(() => expect(mediaStarts(events).some((started) => started.sessionKey.includes("configured-friend"))).toBe(true))
      events.mockRestore()
    }
  })

  it("reports a socket error without ending the session", async () => {
    const f = await fixture()
    const fake = fakeSocket()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    fake.handlers.error!(new Error("boom"))
    expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_twilio_media_socket_error")).toBe(true)
  })

  it("starts without a stream id and without a recorded engine", async () => {
    const f = await fixture()
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(JSON.stringify({ event: "start" }))
    await settle(200)
    // No stream id means there is nowhere to send audio, so no turn runs.
    expect(f.runSenseTurn).not.toHaveBeenCalled()
  })

  it("hangs up on a voicemail menu whether or not the call has an outbound id", async () => {
    for (const outboundId of ["out-vm", undefined]) {
      const f = await fixture({
        mediaMinSpeechMs: 20,
        mediaSilenceEndMs: 40,
        transcriber: { transcribe: vi.fn(async (request: { utteranceId: string }) => buildVoiceTranscript({ utteranceId: request.utteranceId, text: "If you're satisfied with the message, press one.", source: "whisper.cpp" })) },
      } as never)
      if (outboundId) await writeTwilioOutboundCallJob(f.outputDir, job({ outboundId }))
      const fake = fakeSocket()
      const session = new TwilioMediaStreamSession(fake.socket, identity({ direction: "outbound", outboundId, friendId: "job-friend" }), f.options, new TwilioAudioStreamJobStore())
      session.attach()
      session.handleRawMessage(start("CAedge", {}))
      await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"mark"'))).toBe(true))
      for (let i = 0; i < 3; i += 1) session.handleRawMessage(media(0x00))
      for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0xff))
      await vi.waitFor(() => expect(fake.state.open).toBe(false))
    }
  })

  it("passes a barge-in transcript through with the audio path and language it was heard with", async () => {
    const f = await fixture({
      mediaMinSpeechMs: 20,
      mediaSilenceEndMs: 40,
      transcriber: { transcribe: vi.fn(async (request: { utteranceId: string }) => buildVoiceTranscript({ utteranceId: request.utteranceId, text: "wait a second", source: "whisper.cpp", language: "en" })) },
    } as never)
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAedge", {}))
    await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"mark"'))).toBe(true))
    const turns = f.runSenseTurn.mock.calls.length
    for (let i = 0; i < 3; i += 1) session.handleRawMessage(media(0x00))
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0xff))
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBeGreaterThan(turns))
    expect((f.runSenseTurn.mock.calls.at(-1)![0] as { userMessage?: string }).userMessage).toContain("interruption")
  })
})

describe("OpenAI Realtime media stream session over a VoiceSessionSocket", () => {
  async function realtime(identityOverrides: Partial<VoiceCallIdentity> = {}) {
    const f = await fixture()
    const openaiSockets: WebSocket[] = []
    const server = new WebSocketServer({ port: 0 })
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")
    server.on("connection", (ws) => {
      openaiSockets.push(ws as WebSocket)
      ws.on("message", (raw) => {
        const event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
        if (event.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: event.session ?? {} }))
        if (event.type === "response.create") ws.send(JSON.stringify({ type: "response.done", response: { id: "r", status: "completed" } }))
      })
    })
    closers.push(async () => { for (const socket of openaiSockets) socket.terminate() })
    f.options.openaiRealtime = { apiKey: "k", websocketUrl: `ws://127.0.0.1:${address.port}`, model: "gpt-realtime-2" } as never
    f.options.conversationEngine = "openai-realtime"
    const fake = fakeSocket()
    const lifecycle = { onIdentityChange: vi.fn(), onClose: vi.fn() }
    const identity: VoiceCallIdentity = { callSid: "CArt", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "openai-realtime", ...identityOverrides }
    const session = new TwilioOpenAIRealtimeMediaStreamSession(fake.socket, identity, f.options, lifecycle)
    session.attach()
    return { f, fake, session, openaiSockets, lifecycle }
  }

  it("rejects junk, ignores a repeated start, and closes on stop", async () => {
    const { f, fake, session, openaiSockets, lifecycle } = await realtime()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    session.handleRawMessage("not json")
    fake.handlers.message!(start("CArt", {}) as never)
    await vi.waitFor(() => expect(openaiSockets).toHaveLength(1))
    session.handleRawMessage(start("CArt", {}))
    session.handleRawMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0xff).toString("base64") } }))
    session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: "unknown" } }))
    fake.handlers.error!(new Error("twilio side broke"))
    expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_twilio_realtime_socket_error")).toBe(true)
    expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_twilio_realtime_message_rejected")).toBe(true)
    session.handleRawMessage(JSON.stringify({ event: "connected" }))
    expect(lifecycle.onClose).not.toHaveBeenCalled()
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
    expect(lifecycle.onClose).toHaveBeenCalled()
    expect(openaiSockets).toHaveLength(1)
    expect(f.runSenseTurn).not.toHaveBeenCalled()
  })

  it("ignores empty transcripts and refuses to play tool audio before the stream is ready", async () => {
    const { fake, session, openaiSockets } = await realtime()
    const internals = session as unknown as {
      appendTranscript(role: "user" | "assistant", text: string): void
      playPreparedAudio(request: unknown, options?: unknown): Promise<unknown>
      sendTwilioMedia(payload: string): void
      sendTwilioMark(playback: unknown): void
      sendTwilioClear(): void
      streamSid: string
    }
    await expect(internals.playPreparedAudio({ source: "tone", label: "x", toneHz: 440, durationMs: 40 })).rejects.toThrow("not ready")
    fake.handlers.message!(start("CArt", {}) as never)
    await vi.waitFor(() => expect(openaiSockets).toHaveLength(1))
    await settle(100)
    internals.appendTranscript("user", "   ")

    // Stop sending once the Twilio socket closes mid-playback.
    fake.state.sendsBeforeClosing = fake.sent.length + 1
    await internals.playPreparedAudio({ source: "tone", label: "x", toneHz: 440, durationMs: 100 })
    const afterClose = fake.sent.length
    internals.sendTwilioMedia("AAAA")
    internals.sendTwilioMark({})
    internals.sendTwilioClear()
    expect(fake.sent.length).toBe(afterClose)
    fake.state.open = true
    const sid = internals.streamSid
    internals.streamSid = ""
    internals.sendTwilioMedia("AAAA")
    internals.sendTwilioMark({})
    internals.sendTwilioClear()
    internals.streamSid = sid
    expect(fake.sent.length).toBe(afterClose)
  })
})
