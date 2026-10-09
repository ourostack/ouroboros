import type * as net from "node:net"
import { FriendResolver } from "@ouro.bot/friends"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import * as nerves from "../../../nerves/runtime"
import { type VoiceCallIdentity } from "../../../senses/voice/call-auth"
import {
  TwilioAudioStreamJobStore,
  TwilioMediaStreamSession,
  writeTwilioOutboundCallJob,
  type VoiceSessionSocket,
} from "../../../senses/voice/twilio-phone"
import {
  CALLER, HANGUP, LINE, cleanupFixtures, closed, fixture, mediaStarts, mint, record, rejections, settle, start, tokenFrom,
} from "./twilio-auth-fixture"

afterEach(cleanupFixtures)

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

  it("refuses a second stream for the same CallSid that arrives while the first is still resolving its friend", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const realResolve = FriendResolver.prototype.resolve
    vi.spyOn(FriendResolver.prototype, "resolve").mockImplementation(async function (this: FriendResolver) {
      await gate
      return realResolve.call(this)
    })
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const nonceA = record(f.pending, "CArace")
    const first = await f.connect()
    first.send(start("CArace", { OuroToken: mint({ callSid: "CArace", nonce: nonceA }) }))
    await settle()

    const nonceB = record(f.pending, "CArace")
    const second = await f.connect()
    second.send(start("CArace", { OuroToken: mint({ callSid: "CArace", nonce: nonceB }) }))
    await closed(second)

    expect(rejections(events)).toContain("duplicate_call")
    release()
    await vi.waitFor(() => expect(mediaStarts(events)).toHaveLength(1))
    await settle(300)
    first.close()
    await closed(first)
  })

  it("survives a malformed frame from an unauthenticated client", async () => {
    const f = await fixture()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const uncaught = vi.fn()
    process.on("uncaughtException", uncaught)
    try {
      const socket = await f.connect()
      // An unmasked client frame is a protocol violation; ws emits `error` for it.
      const raw = (socket as unknown as { _socket: net.Socket })._socket
      raw.write(Buffer.from([0x81, 0x02, 0x68, 0x69]))
      await closed(socket)
      await settle()
      expect(uncaught).not.toHaveBeenCalled()
      expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_media_stream_socket_error")).toBe(true)
    } finally {
      process.off("uncaughtException", uncaught)
    }
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

  function frame(byte: number): string {
    return JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, byte).toString("base64") } })
  }

  it("plays a turn, lets the caller barge in, answers the utterance and closes on stop", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const lifecycle = { onIdentityChange: vi.fn(), onClose: vi.fn() }
    const identity: VoiceCallIdentity = { callSid: "CAflow", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "cascade" }
    const session = new TwilioMediaStreamSession(fake.socket, identity, f.options, new TwilioAudioStreamJobStore(), lifecycle)
    session.attach()
    session.handleRawMessage("not json")
    fake.handlers.message!(start("CAflow", {}) as never)

    const sentEvents = () => fake.sent.map((raw) => JSON.parse(raw) as { event: string; mark?: { name: string } })
    await vi.waitFor(() => expect(sentEvents().some((event) => event.event === "mark")).toBe(true))
    expect(lifecycle.onIdentityChange).toHaveBeenCalledWith(session, { callSid: "CAflow", outboundId: "" })

    // The caller talks over the greeting: playback is cleared and the speech becomes a turn.
    const turnsBefore = f.runSenseTurn.mock.calls.length
    for (let i = 0; i < 3; i += 1) session.handleRawMessage(frame(0x00))
    expect(sentEvents().some((event) => event.event === "clear")).toBe(true)
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(frame(0xff))
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBeGreaterThan(turnsBefore))
    await vi.waitFor(() => expect(sentEvents().filter((event) => event.event === "mark").length).toBeGreaterThan(1))

    const mark = sentEvents().filter((event) => event.event === "mark").at(-1)!.mark!.name
    session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: mark } }))
    session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: "voice-0-stale" } }))
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
    expect(lifecycle.onClose).toHaveBeenCalledWith(session, { callSid: "CAflow", outboundId: "" })
    fake.handlers.close!()
    session.end()
  })

  it("hangs up on a voicemail menu heard on an outbound call", async () => {
    const f = await fixture({
      mediaMinSpeechMs: 20,
      mediaSilenceEndMs: 40,
      transcriber: { transcribe: vi.fn(async (request: { utteranceId: string; audioPath: string }) => buildVoiceTranscript({ utteranceId: request.utteranceId, text: "If you're satisfied with the message, press one.", audioPath: request.audioPath, source: "whisper.cpp" })) },
    } as never)
    const fake = fakeSocket()
    const identity: VoiceCallIdentity = { callSid: "CAvm", agentName: "slugger", direction: "outbound", outboundId: "out-vm", from: CALLER, to: LINE, friendId: "job-friend", engine: "cascade" }
    const session = new TwilioMediaStreamSession(fake.socket, identity, f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAvm", {}))
    await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"mark"'))).toBe(true))

    for (let i = 0; i < 3; i += 1) session.handleRawMessage(frame(0x00))
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(frame(0xff))
    await vi.waitFor(() => expect(fake.isOpen()).toBe(false))
  })

  it("ends the session when the call directory cannot be created", async () => {
    const f = await fixture()
    f.options.outputDir = "/dev/null/not-a-dir"
    const fake = fakeSocket()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const identity: VoiceCallIdentity = { callSid: "CAbroken", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "cascade" }
    const session = new TwilioMediaStreamSession(fake.socket, identity, f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAbroken", {}))
    await vi.waitFor(() => expect(events.mock.calls.some(([event]) => (event as { event: string }).event === "senses.voice_twilio_media_start_error")).toBe(true))
    expect(fake.isOpen()).toBe(false)
  })
})
