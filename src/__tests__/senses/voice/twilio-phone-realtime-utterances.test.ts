import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript, closeTwilioPhoneBridgeServer } from "../../../senses/voice"
import * as mcp from "../../../repertoire/mcp-manager"
import * as tools from "../../../repertoire/tools"
import { PendingVoiceCalls } from "../../../senses/voice/call-auth"
import type { VoiceCallIdentity } from "../../../senses/voice/call-auth"
import {
  TwilioOpenAIRealtimeMediaStreamSession,
  computeOpenAIWebhookSignature,
  computeTwilioSignature,
  createTwilioPhoneBridge,
  startTwilioPhoneBridgeServer,
  type TwilioPhoneBridgeOptions,
  type VoiceSessionSocket,
} from "../../../senses/voice/twilio-phone"
import { recordVoiceUtterance, voiceUtterances } from "../../../senses/voice/utterances"

const AUTH_TOKEN = "twilio-auth-token-for-tests"
const BASE_URL = "https://voice.example.com"
const WEBHOOK_SECRET = `whsec_${Buffer.from("sip-outcome-secret").toString("base64")}`
const LINE = "+15557654321"
const CALLER = "+15551234567"
const AUDIO = Buffer.alloc(160, 0x7f).toString("base64")

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/** A fake OpenAI Realtime server: it records what the call sends and lets a test speak for OpenAI. */
async function fakeOpenAI() {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const sockets: WebSocket[] = []
  const received: Array<Record<string, unknown>> = []
  server.on("connection", (ws) => {
    sockets.push(ws)
    ws.on("message", (raw) => { received.push(JSON.parse(String(raw)) as Record<string, unknown>) })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const ws of sockets) ws.terminate()
    server.close(() => resolve())
  }))
  const address = server.address() as { port: number }
  return {
    url: `ws://127.0.0.1:${address.port}/v1/realtime`,
    sockets,
    received,
    send(event: Record<string, unknown>) { sockets[0]!.send(JSON.stringify(event)) },
    creates: () => received.filter((event) => event.type === "response.create") as Array<{ response?: { instructions?: string } }>,
  }
}

async function outputFolder(): Promise<{ outputDir: string; agentRoot: string }> {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-voice-realtime-outcomes-"))
  cleanups.push(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const agentRoot = path.join(outputDir, "slugger.ouro")
  fs.mkdirSync(path.join(agentRoot, "friends"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "friends", "ari.json"), JSON.stringify({
    id: "ari", name: "Ari", role: "primary", trustLevel: "family", connections: [],
    externalIds: [{ provider: "imessage-handle", externalId: CALLER, linkedAt: "2026-09-09T00:00:00Z" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", schemaVersion: 1, kind: "human",
  }))
  return { outputDir, agentRoot }
}

function baseOptions(outputDir: string, agentRoot: string, openaiUrl: string): TwilioPhoneBridgeOptions {
  return {
    agentName: "slugger",
    agentRoot,
    publicBaseUrl: BASE_URL,
    outputDir,
    transcriber: { transcribe: vi.fn(async (request: { utteranceId: string }) => buildVoiceTranscript({ utteranceId: request.utteranceId, text: "hi", source: "whisper.cpp" })) },
    tts: { synthesize: vi.fn() },
    runSenseTurn: vi.fn(async () => ({ response: "ok", ponderDeferred: false })),
    downloadRecording: vi.fn(),
    playbackMode: "buffered",
    transportMode: "media-stream",
    twilioAuthToken: AUTH_TOKEN,
    pendingVoiceCalls: new PendingVoiceCalls(),
    openaiRealtime: { apiKey: "openai-secret", websocketUrl: openaiUrl },
  } as unknown as TwilioPhoneBridgeOptions
}

function twilioSocket() {
  const state = { open: true }
  const sent: Array<Record<string, unknown>> = []
  const onSend: Array<(event: Record<string, unknown>) => void> = []
  const socket: VoiceSessionSocket = {
    send: (data: string) => {
      const event = JSON.parse(data) as Record<string, unknown>
      for (const listener of onSend) listener(event)
      sent.push(event)
    },
    close: () => { state.open = false },
    isOpen: () => state.open,
    on: (() => undefined) as VoiceSessionSocket["on"],
  }
  return { socket, sent, onSend, marks: () => sent.filter((event) => event.event === "mark").map((event) => (event.mark as { name: string }).name) }
}

/** A Realtime phone call over a Media Stream, past its greeting. */
async function realtimeCall() {
  const openai = await fakeOpenAI()
  const { outputDir, agentRoot } = await outputFolder()
  vi.spyOn(mcp, "getSharedMcpManager").mockResolvedValue(null)
  const options = { ...baseOptions(outputDir, agentRoot, openai.url), conversationEngine: "openai-realtime" } as TwilioPhoneBridgeOptions
  const twilio = twilioSocket()
  const identity: VoiceCallIdentity = { callSid: "CAone", agentName: "slugger", direction: "inbound", from: CALLER, to: LINE, engine: "openai-realtime" }
  const session = new TwilioOpenAIRealtimeMediaStreamSession(twilio.socket, identity, options)
  session.attach()
  cleanups.push(() => session.end())
  session.handleRawMessage(JSON.stringify({ event: "start", start: { streamSid: "MZone", callSid: "CAone", customParameters: {} } }))
  await vi.waitFor(() => expect(openai.creates()).toHaveLength(1), { timeout: 10_000 })
  // The greeting is a reply the call asked for itself.
  openai.send({ type: "response.created", response: { id: "greeting" } })
  openai.send({ type: "response.output_audio.delta", response_id: "greeting", item_id: "item-greeting", content_index: 0, delta: AUDIO })
  openai.send({ type: "response.done", response: { id: "greeting" } })
  await vi.waitFor(() => expect(twilio.marks()).toHaveLength(1))
  session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: twilio.marks()[0] } }))
  const journal = voiceUtterances(outputDir)
  return {
    openai, twilio, session, outputDir, journal,
    /** The caller says something, and the call asks OpenAI for a reply to it. */
    async callerSays(itemId: string) {
      const before = openai.creates().length
      openai.send({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: "what's the weather?" })
      await vi.waitFor(() => expect(journal.get(`realtime-CAone-${itemId}`)).not.toBeNull())
      await vi.waitFor(() => expect(openai.creates()).toHaveLength(before + 1), { timeout: 5_000 })
    },
    /** OpenAI starts a reply and sends some of its audio, which the call passes to Twilio with a mark. */
    async replies(responseId: string) {
      const marks = twilio.marks().length
      openai.send({ type: "response.created", response: { id: responseId } })
      openai.send({ type: "response.output_audio.delta", response_id: responseId, item_id: `item-${responseId}`, content_index: 0, delta: AUDIO })
      await vi.waitFor(() => expect(twilio.marks()).toHaveLength(marks + 1))
      return twilio.marks().at(-1)!
    },
  }
}

const loud = JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0x00).toString("base64") } })

describe("OpenAI Realtime utterance outcomes", () => {
  it("records what the caller said before asking for a reply, notes the reply before its audio goes, and answers it once Twilio played it", async () => {
    const call = await realtimeCall()
    const id = "realtime-CAone-item-1"
    expect(call.journal.pending()).toEqual([])
    const spokeWhenSent: boolean[] = []
    call.twilio.onSend.push((event) => { if (event.event === "media") spokeWhenSent.push(call.journal.get(id)?.spoke ?? false) })

    await call.callerSays("item-1")
    expect(call.journal.get(id)).toMatchObject({ attempts: 1, payload: { callSid: "CAone", friendId: "ari", transport: "openai-realtime" } })
    const mark = await call.replies("resp-1")
    expect(spokeWhenSent).toEqual([true])
    call.openai.send({ type: "response.done", response: { id: "resp-1" } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(call.journal.outcome(id)).toBeNull()

    call.session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: mark } }))
    expect(call.journal.outcome(id)).toMatchObject({ outcome: "answered", attempts: 1 })
  })

  it("records an utterance as failed when the caller hung up before its reply played", async () => {
    const call = await realtimeCall()
    await call.callerSays("item-1")
    await call.replies("resp-1")
    call.session.handleRawMessage(JSON.stringify({ event: "stop" }))
    expect(call.journal.outcome("realtime-CAone-item-1")).toMatchObject({ outcome: "failed", detail: "the call ended before the reply was played" })
  })

  it("records an utterance as failed when the caller talked over its reply before any played, and a later reply answers what they said next", async () => {
    const call = await realtimeCall()
    await call.callerSays("item-1")
    await call.replies("resp-1")
    for (let i = 0; i < 14; i += 1) call.session.handleRawMessage(loud)
    call.openai.send({ type: "input_audio_buffer.speech_started" })
    await vi.waitFor(() => expect(call.journal.outcome("realtime-CAone-item-1")).toMatchObject({
      outcome: "failed", detail: "the caller spoke again before the reply was played",
    }))
    // Twilio hands back the cleared marks, which do not count as played.
    for (const name of call.twilio.marks()) call.session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name } }))
    expect(call.journal.outcome("realtime-CAone-item-1")).toMatchObject({ outcome: "failed" })

    await call.callerSays("item-2")
    const mark = await call.replies("resp-2")
    call.session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: mark } }))
    expect(call.journal.outcome("realtime-CAone-item-2")).toMatchObject({ outcome: "answered" })
  })

  it("records a reply that audio a tool played took the place of as failed", async () => {
    const call = await realtimeCall()
    await call.callerSays("item-1")
    await call.replies("resp-1")
    call.openai.send({
      type: "response.function_call_arguments.done", response_id: "resp-1", call_id: "call-tone", name: "voice_play_audio",
      arguments: JSON.stringify({ source: "tone", durationMs: 80, label: "beep" }),
    })
    await vi.waitFor(() => expect(call.journal.outcome("realtime-CAone-item-1")).toMatchObject({
      outcome: "failed", detail: "audio a tool played took its place before the reply was played",
    }))
  })

  it("hands a reply that only called a tool on to the follow-up, noting a send before the tool runs", async () => {
    const call = await realtimeCall()
    const id = "realtime-CAone-item-1"
    const spokeWhenRun: string[][] = []
    vi.spyOn(tools, "rejectionWithoutApprover").mockResolvedValue(null)
    vi.spyOn(tools, "execTool").mockImplementation(async () => {
      spokeWhenRun.push((call.journal.get(id)?.spokeRecords ?? []).map((spoke) => spoke.kind))
      return "sent"
    })
    await call.callerSays("item-1")
    call.openai.send({ type: "response.created", response: { id: "resp-tool" } })
    call.openai.send({
      type: "response.function_call_arguments.done", response_id: "resp-tool", call_id: "call-send", name: "send_message",
      arguments: JSON.stringify({ friendId: "ari", channel: "bluebubbles", content: "on my way" }),
    })
    call.openai.send({ type: "response.done", response: { id: "resp-tool" } })
    await vi.waitFor(() => expect(call.openai.creates()).toHaveLength(3))
    expect(spokeWhenRun).toEqual([["tool:send_message"]])

    const mark = await call.replies("resp-follow-up")
    call.session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: mark } }))
    expect(call.journal.outcome(id)).toMatchObject({ outcome: "answered" })
  })

  it("cannot tie a reply OpenAI did not name to what the caller said, so it ends failed with the call", async () => {
    const call = await realtimeCall()
    await call.callerSays("item-1")
    call.openai.send({ type: "response.created", response: {} })
    call.openai.send({ type: "response.output_audio.delta", item_id: "item-unnamed", content_index: 0, delta: AUDIO })
    await vi.waitFor(() => expect(call.twilio.marks()).toHaveLength(2))
    call.session.handleRawMessage(JSON.stringify({ event: "mark", mark: { name: call.twilio.marks()[1] } }))
    call.session.handleRawMessage(JSON.stringify({ event: "stop" }))
    expect(call.journal.outcome("realtime-CAone-item-1")).toMatchObject({ outcome: "failed", detail: "the call ended before this was answered" })
  })

  it("does not note a tool the call refused to run", async () => {
    const call = await realtimeCall()
    vi.spyOn(tools, "rejectionWithoutApprover").mockResolvedValue("refused: nobody can approve this on a call")
    const exec = vi.spyOn(tools, "execTool")
    await call.callerSays("item-1")
    call.openai.send({ type: "response.created", response: { id: "resp-tool" } })
    call.openai.send({
      type: "response.function_call_arguments.done", response_id: "resp-tool", call_id: "call-send", name: "send_message",
      arguments: JSON.stringify({ friendId: "ari", channel: "bluebubbles", content: "on my way" }),
    })
    await vi.waitFor(() => expect(call.openai.received.some((event) => event.type === "conversation.item.create"
      && (event.item as { output?: string }).output === "refused: nobody can approve this on a call")).toBe(true))
    expect(exec).not.toHaveBeenCalled()
    expect(call.journal.get("realtime-CAone-item-1")).toMatchObject({ spoke: false })
  })
})

/** An OpenAI SIP phone call, accepted and past its greeting request. */
async function sipCall() {
  const openai = await fakeOpenAI()
  const { outputDir, agentRoot } = await outputFolder()
  vi.spyOn(mcp, "getSharedMcpManager").mockResolvedValue(null)
  const options = {
    ...baseOptions(outputDir, agentRoot, openai.url),
    conversationEngine: "openai-sip",
    openaiSip: {
      projectId: "proj_test", webhookPath: "/voice/sip", webhookSecret: WEBHOOK_SECRET,
      websocketBaseUrl: openai.url, apiBaseUrl: "https://api.openai.test/v1",
      fetch: vi.fn(async () => new Response("", { status: 200 })),
    },
  } as unknown as TwilioPhoneBridgeOptions
  const bridge = createTwilioPhoneBridge(options)
  const params = { CallSid: "CAsip", From: CALLER, To: LINE }
  const dial = await bridge.handle({
    method: "POST", path: "/voice/twilio/incoming", body: new URLSearchParams(params).toString(),
    headers: { "x-twilio-signature": computeTwilioSignature({ authToken: AUTH_TOKEN, url: new URL("/voice/twilio/incoming", BASE_URL).toString(), params }) },
  })
  const uri = String(dial.body).match(/<Sip>([^<]+)<\/Sip>/)![1]!.replace(/&amp;/g, "&")
  const headers = [...new URL(uri.replace(/^sip:/, "sip://")).searchParams].map(([name, value]) => ({ name, value }))
  const payload = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "call_one", sip_headers: headers } })
  const timestamp = String(Math.floor(Date.now() / 1_000))
  await bridge.handle({
    method: "POST", path: "/voice/sip", body: payload,
    headers: { "webhook-id": "wh_1", "webhook-timestamp": timestamp, "webhook-signature": `v1,${computeOpenAIWebhookSignature({ secret: WEBHOOK_SECRET, webhookId: "wh_1", timestamp, payload })}` },
  })
  await vi.waitFor(() => expect(openai.creates()).toHaveLength(1), { timeout: 10_000 })
  openai.send({ type: "response.created", response: { id: "greeting" } })
  openai.send({ type: "response.content_part.added", response_id: "greeting", part: { type: "audio" } })
  openai.send({ type: "output_audio_buffer.started", response_id: "greeting" })
  openai.send({ type: "response.done", response: { id: "greeting", output: [{ type: "message", content: [{ type: "output_audio" }] }] } })
  const journal = voiceUtterances(outputDir)
  return {
    openai, journal,
    async callerSays(itemId: string) {
      const before = openai.creates().length
      openai.send({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: "what's the weather?" })
      await vi.waitFor(() => expect(journal.get(`sip-call_one-${itemId}`)).not.toBeNull())
      await vi.waitFor(() => expect(openai.creates()).toHaveLength(before + 1), { timeout: 5_000 })
    },
  }
}

describe("OpenAI SIP utterance outcomes", () => {
  it("records what the caller said, notes the reply's audio as it starts, and answers it once OpenAI streams it to the caller", async () => {
    const call = await sipCall()
    const id = "sip-call_one-item-1"
    await call.callerSays("item-1")
    expect(call.journal.get(id)).toMatchObject({ attempts: 1, spoke: false, payload: { callSid: "call_one", friendId: "ari", transport: "openai-sip" } })
    call.openai.send({ type: "response.created", response: { id: "resp-1" } })
    call.openai.send({ type: "response.content_part.added", response_id: "resp-1", part: { type: "output_text" } })
    call.openai.send({ type: "response.content_part.added", response_id: "resp-1", part: { type: "output_audio" } })
    await vi.waitFor(() => expect(call.journal.get(id)).toMatchObject({ spoke: true, spokeRecords: [expect.objectContaining({ kind: "speech:audio" })] }))
    expect(call.journal.outcome(id)).toBeNull()
    call.openai.send({ type: "output_audio_buffer.started", response_id: "resp-1" })
    await vi.waitFor(() => expect(call.journal.outcome(id)).toMatchObject({ outcome: "answered", attempts: 1 }))
  })

  it("hands a reply that made no audio on to the next, and keeps one that did until its audio starts", async () => {
    const call = await sipCall()
    const id = "sip-call_one-item-1"
    await call.callerSays("item-1")
    call.openai.send({ type: "response.created", response: { id: "resp-tool" } })
    call.openai.send({ type: "response.done", response: { id: "resp-tool", output: [{ type: "function_call" }] } })
    await call.callerSays("item-2")
    call.openai.send({ type: "response.created", response: { id: "resp-2" } })
    call.openai.send({ type: "response.done", response: { id: "resp-2", output: [{ type: "message", content: [{ type: "output_audio" }] }] } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(call.journal.outcome(id)).toBeNull()
    call.openai.send({ type: "response.output_audio.delta", response_id: "resp-2", delta: AUDIO })
    await vi.waitFor(() => expect(call.journal.outcome(id)).toMatchObject({ outcome: "answered" }))
    expect(call.journal.outcome("sip-call_one-item-2")).toMatchObject({ outcome: "answered" })
  })

  it("cannot tie a reply OpenAI did not name to what the caller said, so it ends failed with the call", async () => {
    const call = await sipCall()
    await call.callerSays("item-1")
    call.openai.send({ type: "response.created", response: {} })
    call.openai.send({ type: "output_audio_buffer.started" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    call.openai.sockets[0]!.close()
    await vi.waitFor(() => expect(call.journal.outcome("sip-call_one-item-1")).toMatchObject({
      outcome: "failed", detail: "the call ended before this was answered",
    }))
  })

  it("records an utterance as failed when the call ended before its reply's audio started", async () => {
    const call = await sipCall()
    await call.callerSays("item-1")
    call.openai.send({ type: "response.created", response: { id: "resp-1" } })
    call.openai.send({ type: "response.content_part.added", response_id: "resp-1", part: { type: "audio" } })
    await vi.waitFor(() => expect(call.journal.get("sip-call_one-item-1")).toMatchObject({ spoke: true }))
    call.openai.sockets[0]!.close()
    await vi.waitFor(() => expect(call.journal.outcome("sip-call_one-item-1")).toMatchObject({
      outcome: "failed", detail: "the call ended before the reply was played",
    }))
  })
})

describe("Realtime and SIP utterances a stopped process left", () => {
  it("records them as failed once the bridge is listening, saying what the caller already heard", async () => {
    const { outputDir, agentRoot } = await outputFolder()
    const left = recordVoiceUtterance(outputDir, "sip-call_old-item-1", { callSid: "call_old", friendId: "ari", sessionKey: "phone", transport: "openai-sip" })!
    left.noteSpoke({ kind: "speech:audio", sentAt: "2026-11-23T10:00:00.000Z", outboundRecordId: null, textHash: null, textLength: null })
    recordVoiceUtterance(outputDir, "realtime-CAold-item-1", { callSid: "CAold", friendId: "ari", sessionKey: "phone", transport: "openai-realtime" })
    const server = await startTwilioPhoneBridgeServer({ ...baseOptions(outputDir, agentRoot, "ws://127.0.0.1:9"), port: 0, host: "127.0.0.1" })
    cleanups.push(() => closeTwilioPhoneBridgeServer(server))
    expect(voiceUtterances(outputDir).outcome("sip-call_old-item-1")).toMatchObject({
      outcome: "failed", detail: "the voice sense restarted after 1 send (speech:audio at 2026-11-23T10:00:00.000Z) went out; live audio is not replayed",
    })
    expect(voiceUtterances(outputDir).outcome("realtime-CAold-item-1")).toMatchObject({ outcome: "failed" })
  })
})
