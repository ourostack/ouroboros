import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript, closeTwilioPhoneBridgeServer } from "../../../senses/voice"
import * as nerves from "../../../nerves/runtime"
import type { VoiceCallIdentity } from "../../../senses/voice/call-auth"
import { TwilioAudioStreamJobStore, TwilioMediaStreamSession, startTwilioPhoneBridgeServer, type VoiceSessionSocket } from "../../../senses/voice/twilio-phone"
import { recordVoiceUtterance, voiceUtterances } from "../../../senses/voice/utterances"
import { CALLER, LINE, cleanupFixtures, fixture, start } from "./twilio-auth-fixture"

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupFixtures()
})

const recording = (recordingSid: string) => ({
  CallSid: "CAone", RecordingSid: recordingSid, RecordingUrl: `https://api.twilio.com/Recordings/${recordingSid}`, From: CALLER, To: LINE,
})

function fakeSocket() {
  const state = { open: true }
  const sent: string[] = []
  const socket: VoiceSessionSocket = {
    send: (data: string) => { sent.push(data) },
    close: () => { state.open = false },
    isOpen: () => state.open,
    on: (() => undefined) as VoiceSessionSocket["on"],
  }
  return { socket, sent }
}

function media(byte: number): string {
  return JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, byte).toString("base64") } })
}

const identity = (overrides: Partial<VoiceCallIdentity> = {}): VoiceCallIdentity => ({
  callSid: "CAone", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "cascade", ...overrides,
})

/** Speak one utterance into a session: a few voiced frames, then silence. */
function speak(session: TwilioMediaStreamSession): void {
  for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0x00))
  for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0xff))
}

function emitted(name: string): unknown[] {
  return vi.mocked(nerves.emitNervesEvent).mock.calls.map(([event]) => event).filter((event) => event.event === name)
}

describe("Twilio recording outcomes", () => {
  it("records a recording's turn as answered, and runs a repeated callback for it only once", async () => {
    const f = await fixture({ transportMode: "record-play" })
    vi.spyOn(nerves, "emitNervesEvent")
    await f.post("/voice/twilio/recording", recording("REone"))
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REone")).toMatchObject({ outcome: "answered", attempts: 1 })
    const turns = f.runSenseTurn.mock.calls.length

    const again = await f.post("/voice/twilio/recording", recording("REone"))
    expect(f.runSenseTurn).toHaveBeenCalledTimes(turns)
    expect(String(again.body)).toContain("<Redirect")
    expect(String(again.body)).not.toContain("<Play>")
    expect(emitted("senses.voice_twilio_recording_duplicate")).toEqual([expect.objectContaining({ meta: expect.objectContaining({ inFlight: false }) })])
  })

  it("answers a callback Twilio repeats while the first is still running with the first one's reply, running the turn once", async () => {
    const f = await fixture({ transportMode: "record-play" })
    vi.spyOn(nerves, "emitNervesEvent")
    const release = Promise.withResolvers<void>()
    const turn = f.runSenseTurn.getMockImplementation()!
    f.runSenseTurn.mockImplementationOnce(async (request) => {
      await release.promise
      return turn(request)
    })
    const first = f.post("/voice/twilio/recording", recording("REslow"))
    const retry = f.post("/voice/twilio/recording", recording("REslow"))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalledTimes(1))
    release.resolve()
    const [firstReply, retryReply] = await Promise.all([first, retry])
    expect(f.runSenseTurn).toHaveBeenCalledTimes(1)
    expect(String(firstReply.body)).toContain("<Play>")
    expect(retryReply.body).toEqual(firstReply.body)
    expect(emitted("senses.voice_twilio_recording_duplicate")).toEqual([expect.objectContaining({ meta: expect.objectContaining({ inFlight: true }) })])
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REslow")).toMatchObject({ outcome: "answered", attempts: 1 })
  })

  it("gives a streamed recording's retry the same play link while its stream is still there", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "stream" })
    const release = Promise.withResolvers<void>()
    const turn = f.runSenseTurn.getMockImplementation()!
    f.runSenseTurn.mockImplementationOnce(async (request) => {
      await release.promise
      return turn(request)
    })
    const first = await f.post("/voice/twilio/recording", recording("REstreamed"))
    expect(String(first.body)).toContain("<Play>")
    const duringTurn = await f.post("/voice/twilio/recording", recording("REstreamed"))
    expect(duringTurn.body).toEqual(first.body)
    release.resolve()
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REstreamed")).toMatchObject({ outcome: "answered" }))
    const afterTurn = await f.post("/voice/twilio/recording", recording("REstreamed"))
    expect(afterTurn.body).toEqual(first.body)
    expect(f.runSenseTurn).toHaveBeenCalledTimes(1)
  })

  it("records a buffered reply whose playback file could not be written as failed", async () => {
    const f = await fixture({ transportMode: "record-play" })
    fs.mkdirSync(path.join(f.outputDir, "CAone", "twilio-caone-reunwritable.mp3"), { recursive: true })
    const reply = await f.post("/voice/twilio/recording", recording("REunwritable"))
    expect(String(reply.body)).toContain("I could not process that audio")
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REunwritable")).toMatchObject({ outcome: "failed", detail: expect.stringMatching(/^the turn failed: .*EISDIR/) })

    fs.mkdirSync(path.join(f.outputDir, "CAone", "twilio-caone-renothing-nospeech.mp3"), { recursive: true })
    vi.mocked(f.options.transcriber.transcribe).mockResolvedValueOnce(buildVoiceTranscript({ utteranceId: "x", text: "[BLANK_AUDIO]", source: "whisper.cpp" }))
    await f.post("/voice/twilio/recording", recording("REnothing"))
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REnothing")).toMatchObject({ outcome: "failed", detail: expect.stringMatching(/EISDIR/) })
  })

  it("records a buffered reply that could not be spoken as failed", async () => {
    const f = await fixture({ transportMode: "record-play" })
    vi.mocked(f.options.tts.synthesize).mockRejectedValueOnce(new Error("tts down"))
    const reply = await f.post("/voice/twilio/recording", recording("REmute"))
    expect(String(reply.body)).toContain("voice output failed")
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REmute")).toMatchObject({ outcome: "failed", detail: "the reply could not be spoken: tts down" })
  })

  it("records a streamed recording's turn, and one that could not be downloaded as failed", async () => {
    const f = await fixture({ transportMode: "record-play", playbackMode: "stream" })
    await f.post("/voice/twilio/recording", recording("REstream"))
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REstream")).toMatchObject({ outcome: "answered" }))

    vi.mocked(f.options.downloadRecording!).mockRejectedValueOnce(new Error("twilio 404"))
    await f.post("/voice/twilio/recording", recording("REgone"))
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REgone")).toMatchObject({
      outcome: "failed", detail: "the turn failed: twilio 404",
    }))
  })

  it("records a buffered recording that could not be downloaded as failed, and one with no speech as answered by the prompt", async () => {
    const f = await fixture({ transportMode: "record-play" })
    vi.mocked(f.options.downloadRecording!).mockRejectedValueOnce(new Error("twilio 500"))
    await f.post("/voice/twilio/recording", recording("REfail"))
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REfail")).toMatchObject({ outcome: "failed", detail: "the turn failed: twilio 500" })

    vi.mocked(f.options.transcriber.transcribe).mockResolvedValueOnce(buildVoiceTranscript({ utteranceId: "x", text: "[BLANK_AUDIO]", source: "whisper.cpp" }))
    await f.post("/voice/twilio/recording", recording("REquiet"))
    expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-REquiet")).toMatchObject({ outcome: "answered" })
  })
})

describe("Twilio Media Stream utterance outcomes", () => {
  it("records what the caller said as answered once the reply is spoken", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    speak(session)
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({ outcome: "answered", attempts: 1 }))
    expect(voiceUtterances(f.outputDir).pending()).toEqual([])
  })

  it("records an utterance as failed when the call ends before its turn, or its transcription fails", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const release = Promise.withResolvers<void>()
    const transcribe = vi.mocked(f.options.transcriber.transcribe)
    transcribe.mockImplementationOnce(async (request) => {
      await release.promise
      return buildVoiceTranscript({ utteranceId: request.utteranceId, text: "hello?", source: "whisper.cpp" })
    })
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    speak(session)
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
    release.resolve()
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({
      outcome: "failed", detail: "the call ended before this was answered",
    }))

    const second = new TwilioMediaStreamSession(fakeSocket().socket, identity({ callSid: "CAtwo" }), f.options, new TwilioAudioStreamJobStore())
    second.attach()
    second.handleRawMessage(start("CAtwo", {}))
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBeGreaterThanOrEqual(2))
    transcribe.mockRejectedValueOnce(new Error("whisper crashed"))
    speak(second)
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAtwo-1")).toMatchObject({
      outcome: "failed", detail: "the turn failed: whisper crashed",
    }))
  })

  it("records an utterance as failed when the caller hung up before its reply played", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    const release = Promise.withResolvers<void>()
    const turn = f.runSenseTurn.getMockImplementation()!
    f.runSenseTurn.mockImplementationOnce(async (request) => {
      await release.promise
      return turn(request)
    })
    const greetingTurns = f.runSenseTurn.mock.calls.length
    speak(session)
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBe(greetingTurns + 1))
    session.handleRawMessage(JSON.stringify({ event: "stop" }))
    release.resolve()
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({
      outcome: "failed", detail: "the call ended before the reply was played",
    }))
  })

  it("records an utterance as failed when the caller talked over it before its reply played, or its turn threw", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const session = new TwilioMediaStreamSession(fakeSocket().socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    const release = Promise.withResolvers<void>()
    const turn = f.runSenseTurn.getMockImplementation()!
    f.runSenseTurn.mockImplementationOnce(async (request) => {
      await release.promise
      return turn(request)
    })
    const greetingTurns = f.runSenseTurn.mock.calls.length
    speak(session)
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBe(greetingTurns + 1))
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0x00))
    release.resolve()
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({
      outcome: "failed", detail: "the caller spoke again before the reply was played",
    }))

    const before = f.runSenseTurn.mock.calls.length
    const second = new TwilioMediaStreamSession(fakeSocket().socket, identity({ callSid: "CAtwo" }), f.options, new TwilioAudioStreamJobStore())
    second.attach()
    second.handleRawMessage(start("CAtwo", {}))
    await vi.waitFor(() => expect(f.runSenseTurn.mock.calls.length).toBe(before + 1))
    f.runSenseTurn.mockRejectedValueOnce(new Error("provider down"))
    speak(second)
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAtwo-1")).toMatchObject({
      outcome: "failed", detail: "the turn failed: provider down",
    }))
  })

  it("records a reply the caller heard part of as answered, even when they talked over the rest or hung up", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const session = new TwilioMediaStreamSession(fakeSocket().socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    const firstChunk = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const synthesize = f.options.tts.synthesize
    vi.mocked(synthesize).mockImplementationOnce(async (request) => {
      request.onAudioChunk?.(Buffer.alloc(160, 0x7f))
      firstChunk.resolve()
      await release.promise
      return { utteranceId: request.utteranceId, audio: Buffer.alloc(160, 0x7f), byteLength: 160, chunkCount: 1, modelId: "m", voiceId: "v", mimeType: "audio/x-mulaw" }
    })
    speak(session)
    await firstChunk.promise
    for (let i = 0; i < 4; i += 1) session.handleRawMessage(media(0x00))
    release.resolve()
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({ outcome: "answered" }))
  })

  it("records a reply a tool's audio took the place of as failed, naming the tool audio", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const session = new TwilioMediaStreamSession(fakeSocket().socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    f.runSenseTurn.mockImplementationOnce(async (request: { toolContext?: { voiceCall?: { playAudio?: (r: unknown) => Promise<unknown> } } }) => {
      await request.toolContext!.voiceCall!.playAudio!({ source: "tone", durationMs: 40 })
      return { response: "That was the tone.", ponderDeferred: false }
    })
    speak(session)
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({
      outcome: "failed", detail: "audio a tool played took its place before the reply was played",
    }))
  })

  it("records a reply that made no audio as failed, saying it could not be sent down the call", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const session = new TwilioMediaStreamSession(fakeSocket().socket, identity(), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    vi.mocked(f.options.tts.synthesize).mockImplementation(async (request) => ({
      utteranceId: request.utteranceId, audio: Buffer.alloc(0), byteLength: 0, chunkCount: 0, modelId: "m", voiceId: "v", mimeType: "audio/x-mulaw",
    }))
    speak(session)
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({
      outcome: "failed", detail: "the reply could not be sent down the call",
    }))
  })

  it("records an outbound call's utterance as silent when a voicemail menu answered", async () => {
    const f = await fixture({ mediaMinSpeechMs: 20, mediaSilenceEndMs: 40 })
    const fake = fakeSocket()
    const session = new TwilioMediaStreamSession(fake.socket, identity({ direction: "outbound" }), f.options, new TwilioAudioStreamJobStore())
    session.attach()
    session.handleRawMessage(start("CAone", {}))
    await vi.waitFor(() => expect(f.runSenseTurn).toHaveBeenCalled())
    vi.mocked(f.options.transcriber.transcribe).mockResolvedValueOnce(buildVoiceTranscript({
      utteranceId: "twilio-CAone-1", text: "If you are satisfied with the message, press 1.", source: "whisper.cpp",
    }))
    speak(session)
    await vi.waitFor(() => expect(voiceUtterances(f.outputDir).outcome("twilio-CAone-1")).toMatchObject({
      outcome: "silent", detail: "a voicemail menu answered the call, so it was ended",
    }))
  })
})

describe("voice utterances a stopped process left", () => {
  it("records them as failed once the bridge is listening, and when it shuts down", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-voice-leftover-"))
    try {
      const payload = { callSid: "CAold", friendId: "ari", sessionKey: "phone", transport: "recording" as const }
      recordVoiceUtterance(outputDir, "twilio-CAold-REold", payload)
      const { options } = await fixture()
      const owner = await startTwilioPhoneBridgeServer({ ...options, outputDir })
      expect(voiceUtterances(outputDir).outcome("twilio-CAold-REold")).toMatchObject({
        outcome: "failed", detail: "the voice sense restarted before this was answered; live audio is not replayed",
      })
      const second = await startTwilioPhoneBridgeServer({ ...options, outputDir })
      recordVoiceUtterance(outputDir, "twilio-CAold-RElate", payload)
      // A bridge that never held the folder leaves its utterances to the one that does.
      await closeTwilioPhoneBridgeServer(second)
      expect(voiceUtterances(outputDir).get("twilio-CAold-RElate")).not.toBeNull()
      await closeTwilioPhoneBridgeServer(owner)
      expect(voiceUtterances(outputDir).outcome("twilio-CAold-RElate")).toMatchObject({
        outcome: "failed", detail: "the voice sense shut down before this was answered; live audio is not replayed",
      })
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it("leaves a running bridge's utterances alone when a second bridge starts with the same folder on another port", async () => {
    const f = await fixture()
    vi.spyOn(nerves, "emitNervesEvent")
    recordVoiceUtterance(f.outputDir, "twilio-CAlive-RElive", { callSid: "CAlive", friendId: "ari", sessionKey: "phone", transport: "recording" })
    const second = await startTwilioPhoneBridgeServer({ ...f.options, port: 0, host: "127.0.0.1" })
    expect(voiceUtterances(f.outputDir).get("twilio-CAlive-RElive")).not.toBeNull()
    expect(emitted("senses.voice_output_folder_held")).toEqual([expect.objectContaining({ level: "warn" })])
    await closeTwilioPhoneBridgeServer(second)
    expect(voiceUtterances(f.outputDir).get("twilio-CAlive-RElive")).not.toBeNull()
  })

  it("leaves another process's utterances alone when this bridge cannot take the port", async () => {
    const f = await fixture()
    const live = recordVoiceUtterance(f.outputDir, "twilio-CAlive-RElive", { callSid: "CAlive", friendId: "ari", sessionKey: "phone", transport: "recording" })
    const port = Number(new URL(f.server.localUrl).port)
    await expect(startTwilioPhoneBridgeServer({ ...f.options, port, host: "127.0.0.1" })).rejects.toThrow(/EADDRINUSE/)
    expect(live).not.toBeNull()
    expect(voiceUtterances(f.outputDir).get("twilio-CAlive-RElive")).toMatchObject({ attempts: 0 })
  })
})
