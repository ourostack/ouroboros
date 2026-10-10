import * as fs from "fs/promises"
import * as path from "path"
import { WebSocketServer, type WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { disclosureTimings } from "../../../senses/voice/local-audio-disclosure"
import type { VoiceCallIdentity } from "../../../senses/voice/call-auth"
import { TwilioOpenAIRealtimeMediaStreamSession, tonesOnly, type VoiceSessionSocket } from "../../../senses/voice/twilio-phone"
import { cleanupFixtures, closers, fixture, settle, start } from "./twilio-auth-fixture"

const realTimings = { ...disclosureTimings }
afterEach(async () => {
  Object.assign(disclosureTimings, realTimings)
  await cleanupFixtures()
})

function fakeSocket() {
  const handlers: Record<string, (arg?: never) => void> = {}
  const sent: string[] = []
  const state = { open: true }
  const socket: VoiceSessionSocket = {
    send: (data) => { sent.push(data) },
    close: () => { state.open = false; handlers.close?.() },
    isOpen: () => state.open,
    on: ((event: string, callback: (arg?: never) => void) => { handlers[event] = callback }) as VoiceSessionSocket["on"],
  }
  return { socket, handlers, sent, state }
}

type ResponseBehavior = (ws: WebSocket, attempt: number) => "complete" | "cancel" | "silent"

/** The fake Realtime service: by default every response is created, spoken (transcript) and completed. */
function respond(ws: WebSocket, behavior: ResponseBehavior, attempt: number): void {
  const mode = behavior(ws, attempt)
  if (mode === "silent") return
  const id = `resp-${attempt}`
  ws.send(JSON.stringify({ type: "response.created", response: { id } }))
  ws.send(JSON.stringify({ type: "response.output_audio.delta", response_id: id, item_id: `item-${attempt}`, content_index: 0, delta: Buffer.alloc(160, 0x20).toString("base64") }))
  ws.send(JSON.stringify({ type: "response.output_audio_transcript.done", response_id: id, item_id: `item-${attempt}`, transcript: "I'm slugger, an AI assistant; I'm transcribing." }))
  ws.send(JSON.stringify({ type: "response.done", response: { id, status: mode === "cancel" ? "cancelled" : "completed" } }))
}

async function localSession(local: Partial<NonNullable<VoiceCallIdentity["local"]>> = {}, friendId?: string, trust?: string, behavior: ResponseBehavior = () => "complete", lifecycle?: ConstructorParameters<typeof TwilioOpenAIRealtimeMediaStreamSession>[3]) {
  let responseCount = 0
  const f = await fixture()
  if (friendId && trust) {
    const { FileFriendStore } = await import("@ouro.bot/friends")
    await fs.mkdir(f.options.agentRoot!, { recursive: true })
    const now = new Date().toISOString()
    await new FileFriendStore(path.join(f.options.agentRoot!, "friends")).put(friendId, { id: friendId, name: "Ari", trustLevel: trust, externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 } as never)
  }
  const fromOpenAI: Array<Record<string, unknown>> = []
  const server = new WebSocketServer({ port: 0 })
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const sockets: WebSocket[] = []
  server.on("connection", (ws) => {
    sockets.push(ws as WebSocket)
    ws.on("message", (raw) => {
      const event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
      fromOpenAI.push(event)
      if (event.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: event.session ?? {} }))
      if (event.type === "response.create") respond(ws as WebSocket, behavior, ++responseCount)
    })
  })
  closers.push(async () => { for (const socket of sockets) socket.terminate() })
  f.options.openaiRealtime = { apiKey: "k", websocketUrl: `ws://127.0.0.1:${address.port}`, model: "gpt-realtime-2" } as never
  f.options.conversationEngine = "openai-realtime"
  const fake = fakeSocket()
  const identity: VoiceCallIdentity = {
    callSid: "local-test-1", agentName: "slugger", direction: "inbound", from: "local-audio-room", to: "local-audio:slugger",
    engine: "openai-realtime", ...(friendId ? { friendId } : {}),
    local: { mode: "conversation", ownerAlone: false, disclosure: "spoken", ownerName: "Ari", participants: "Ari, Sam", occasion: "podcast prep", ...local },
  }
  const session = new TwilioOpenAIRealtimeMediaStreamSession(fake.socket, identity, f.options, lifecycle)
  session.attach()
  fake.handlers.message!(start("local-test-1", {}) as never)
  await vi.waitFor(() => expect(fromOpenAI.some((e) => e.type === "session.update")).toBe(true))
  await settle(120)
  return { f, fake, session, fromOpenAI, sockets }
}

const sessionUpdate = (events: Array<Record<string, unknown>>) =>
  (events.filter((e) => e.type === "session.update").at(-1)!.session as { instructions: string })

const marksSent = (fake: { sent: string[] }): string[] =>
  fake.sent.map((raw) => JSON.parse(raw) as { event: string; mark?: { name: string } })
    .filter((m) => m.event === "mark" && m.mark?.name.startsWith("disclosure-")).map((m) => m.mark!.name)
const echoMark = (fake: ReturnType<typeof fakeSocket>, name: string): void => {
  fake.handlers.message!(JSON.stringify({ event: "mark", streamSid: "MZ", mark: { name } }) as never)
}
const systemNotes = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.type === "conversation.item.create" && (e.item as { role?: string }).role === "system")

describe("local audio disclosure is guaranteed", () => {
  it("counts the notice as spoken only once its audio has played out, then tells the model it announced itself", async () => {
    const spoken: number[] = []
    const { fake, fromOpenAI } = await localSession({}, undefined, undefined, undefined, { onDisclosureSpoken: (at) => { spoken.push(at) } })
    await vi.waitFor(() => expect(marksSent(fake)).toHaveLength(1))
    expect(spoken).toEqual([])
    expect(systemNotes(fromOpenAI)).toHaveLength(0)
    echoMark(fake, marksSent(fake)[0]!)
    expect(spoken).toHaveLength(1)
    await vi.waitFor(() => expect(systemNotes(fromOpenAI)).toHaveLength(1))
    expect(JSON.stringify(systemNotes(fromOpenAI)[0])).toContain("You have announced yourself")
    // The instructions did not claim it beforehand.
    expect(sessionUpdate(fromOpenAI).instructions).not.toMatch(/You have announced yourself/)
    expect(sessionUpdate(fromOpenAI).instructions).toMatch(/Your first spoken turn announces you/)
    // Ignoring a mark that is not the notice's, and the unrelated tool path, changes nothing.
    echoMark(fake, "rt-1")
    expect(spoken).toHaveLength(1)
  })

  it("sends no playout mark once the socket has gone away", async () => {
    const spoken: number[] = []
    const { fake, fromOpenAI, sockets } = await localSession({}, undefined, undefined, () => "silent", { onDisclosureSpoken: (at) => { spoken.push(at) } })
    await vi.waitFor(() => expect(fromOpenAI.some((e) => e.type === "response.create")).toBe(true))
    fake.state.open = false
    respond(sockets[0]!, () => "complete", 9)
    await settle()
    expect(marksSent(fake)).toEqual([])
    expect(spoken).toEqual([])
  })

  it("asks again after a cancelled response, with the same notice", async () => {
    disclosureTimings.retryDelayMs = 20
    const spoken: number[] = []
    const { fake, fromOpenAI } = await localSession({}, undefined, undefined, (_ws, attempt) => (attempt === 1 ? "cancel" : "complete"), { onDisclosureSpoken: (at) => { spoken.push(at) } })
    await vi.waitFor(() => expect(marksSent(fake)).toHaveLength(1))
    const creates = fromOpenAI.filter((e) => e.type === "response.create").map((e) => (e.response as { instructions: string }).instructions)
    expect(creates).toHaveLength(2)
    expect(creates[0]).toBe(creates[1])
    expect(creates[0]).toContain("I'm slugger, Ari's AI assistant; I'm transcribing.")
    echoMark(fake, marksSent(fake)[0]!)
    expect(spoken).toHaveLength(1)
  })

  it("asks again when the caller's speech clears the audio before it played out", async () => {
    disclosureTimings.retryDelayMs = 20
    const spoken: number[] = []
    const { fake, fromOpenAI, sockets } = await localSession({}, undefined, undefined, undefined, { onDisclosureSpoken: (at) => { spoken.push(at) } })
    await vi.waitFor(() => expect(marksSent(fake)).toHaveLength(1))
    // Reliable caller speech (loud frames), then the server's speech_started: the session clears playback.
    const loud = Buffer.alloc(160, 0x10).toString("base64")
    for (let i = 0; i < 20; i++) fake.handlers.message!(JSON.stringify({ event: "media", media: { payload: loud } }) as never)
    sockets[0]!.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }))
    await vi.waitFor(() => expect(fake.sent.some((raw) => JSON.parse(raw).event === "clear")).toBe(true))
    echoMark(fake, marksSent(fake)[0]!)
    expect(spoken).toEqual([])
    // The caller stops talking, which releases the floor so the repeated notice can go out.
    sockets[0]!.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }))
    await vi.waitFor(() => expect(fromOpenAI.filter((e) => e.type === "response.create").length).toBeGreaterThanOrEqual(2))
    await vi.waitFor(() => expect(marksSent(fake)).toHaveLength(2))
    echoMark(fake, marksSent(fake)[1]!)
    expect(spoken).toHaveLength(1)
  })

  it("reports a failure when the notice cannot be spoken before the deadline, and keeps no timers after the session ends", async () => {
    disclosureTimings.deadlineMs = 150
    disclosureTimings.createWaitMs = 40
    let failed = 0
    const { session } = await localSession({}, undefined, undefined, () => "silent", { onDisclosureFailed: () => { failed++ } })
    await vi.waitFor(() => expect(failed).toBe(1))
    session.end()
  })

  it("does not send the notice twice while its request is still on the wire, then gives up at the deadline", async () => {
    disclosureTimings.createWaitMs = 30
    disclosureTimings.deadlineMs = 250
    let failed = 0
    const { fromOpenAI } = await localSession({}, undefined, undefined, () => "silent", { onDisclosureFailed: () => { failed++ } })
    await vi.waitFor(() => expect(failed).toBe(1))
    expect(fromOpenAI.filter((e) => e.type === "response.create")).toHaveLength(1)
  })

  it("a silent join has no disclosure tracking and no opening turn", async () => {
    const { fromOpenAI, fake } = await localSession({ disclosure: "silent", consentStatement: "everyone agreed" })
    expect(fromOpenAI.filter((e) => e.type === "response.create")).toHaveLength(0)
    expect(marksSent(fake)).toHaveLength(0)
  })
})

const advertisedToolNames = (events: Array<Record<string, unknown>>): string[] =>
  ((events.filter((e) => e.type === "session.update").at(-1)!.session as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort()

describe("local audio tools in the Realtime session", () => {
  it("advertises only voice_end_call and voice_play_audio to a room at acquaintance trust", async () => {
    const { fromOpenAI } = await localSession({}, "ari", "family")
    expect(advertisedToolNames(fromOpenAI)).toEqual(["voice_end_call", "voice_play_audio"])
  })

  it("advertises the same two tools when the owner is alone and trust rises to family", async () => {
    const { fromOpenAI } = await localSession({ ownerAlone: true }, "ari", "family")
    expect(advertisedToolNames(fromOpenAI)).toEqual(["voice_end_call", "voice_play_audio"])
  })

  it("refuses a tool call for anything that was not advertised, even for family", async () => {
    const { fromOpenAI, sockets } = await localSession({ ownerAlone: true }, "ari", "family")
    sockets[0]!.send(JSON.stringify({ type: "response.function_call_arguments.done", name: "read_file", arguments: JSON.stringify({ path: "/etc/hosts" }), call_id: "c1", response_id: "r1" }))
    await vi.waitFor(() => expect(fromOpenAI.some((e) => e.type === "conversation.item.create")).toBe(true))
    const output = (fromOpenAI.find((e) => e.type === "conversation.item.create") as { item: { output: string } }).item.output
    expect(output).toContain("not advertised in this voice session")
  })
})

describe("local audio identity in the Realtime session", () => {
  it("sends transport-aware instructions with the room, participants and acquaintance trust", async () => {
    const { fromOpenAI } = await localSession()
    const { instructions } = sessionUpdate(fromOpenAI)
    expect(instructions).toContain("# LOCAL AUDIO ROOM")
    expect(instructions).toContain("Participants (stated by the person who started this session): Ari, Sam")
    expect(instructions).toContain("several people may share this audio")
    expect(instructions).toContain("you cannot tell voices apart")
    expect(instructions).not.toMatch(/caller|phone call|phone voice/i)
    expect(instructions).toContain("trust=acquaintance")
  })

  it("speaks the disclosure notice first on a spoken join", async () => {
    const { fromOpenAI } = await localSession()
    const created = fromOpenAI.filter((e) => e.type === "response.create")
    expect(created).toHaveLength(1)
    const prompt = (created[0]!.response as { instructions: string }).instructions
    expect(prompt).toContain("I'm slugger, Ari's AI assistant; I'm transcribing.")
    expect(prompt).not.toMatch(/phone|caller|Twilio/i)
  })

  it("joins silently, with no model turn, when the owner's consent is recorded", async () => {
    const { fromOpenAI } = await localSession({ disclosure: "silent", consentStatement: "Ari said everyone agreed" })
    expect(fromOpenAI.filter((e) => e.type === "response.create")).toHaveLength(0)
    expect(sessionUpdate(fromOpenAI).instructions).toContain("Ari said everyone agreed")
  })

  it("runs a family friend at acquaintance unless the join says the owner is alone", async () => {
    const f = await fixture()
    const { FileFriendStore } = await import("@ouro.bot/friends")
    const store = new FileFriendStore(path.join(f.options.agentRoot!, "friends"))
    await fs.mkdir(f.options.agentRoot!, { recursive: true })
    const now = new Date().toISOString()
    await store.put("ari", { id: "ari", name: "Ari", trustLevel: "family", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 } as never)
    const alone = await localSessionIn(f, { ownerAlone: true }, "ari")
    expect(sessionUpdate(alone).instructions).toContain("trust=family")
    expect(sessionUpdate(alone).instructions).toContain("owner alone")
    const room = await localSessionIn(f, { ownerAlone: false }, "ari")
    expect(sessionUpdate(room).instructions).toContain("trust=acquaintance")
  })
})

async function localSessionIn(f: Awaited<ReturnType<typeof fixture>>, local: Partial<NonNullable<VoiceCallIdentity["local"]>>, friendId: string) {
  const fromOpenAI: Array<Record<string, unknown>> = []
  const server = new WebSocketServer({ port: 0 })
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const sockets: WebSocket[] = []
  server.on("connection", (ws) => {
    sockets.push(ws as WebSocket)
    ws.on("message", (raw) => {
      const event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
      fromOpenAI.push(event)
      if (event.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: event.session ?? {} }))
      if (event.type === "response.create") respond(ws as WebSocket, () => "complete", 1)
    })
  })
  closers.push(async () => { for (const socket of sockets) socket.terminate() })
  f.options.openaiRealtime = { apiKey: "k", websocketUrl: `ws://127.0.0.1:${address.port}`, model: "gpt-realtime-2" } as never
  const fake = fakeSocket()
  const callSid = `local-${Math.random().toString(36).slice(2, 8)}`
  const session = new TwilioOpenAIRealtimeMediaStreamSession(fake.socket, {
    callSid, agentName: "slugger", direction: "inbound", from: "local-audio-room", to: "local-audio:slugger", engine: "openai-realtime", friendId,
    local: { mode: "conversation", ownerAlone: false, disclosure: "spoken", ...local },
  }, f.options, undefined)
  session.attach()
  fake.handlers.message!(start(callSid, {}) as never)
  await vi.waitFor(() => expect(fromOpenAI.some((e) => e.type === "session.update")).toBe(true))
  await settle(120)
  return fromOpenAI
}

describe("tonesOnly", () => {
  it("plays tones (the default source) and refuses URL and file clips in a local room", async () => {
    const play = vi.fn(async () => ({ label: "tone", durationMs: 500 }))
    const guarded = tonesOnly(play)
    await expect(guarded({})).resolves.toEqual({ label: "tone", durationMs: 500 })
    await expect(guarded({ source: "tone", toneHz: 440 })).resolves.toMatchObject({ label: "tone" })
    await expect(guarded({ source: "url", url: "http://192.168.1.1/reboot" })).rejects.toThrow(/only tones/)
    await expect(guarded({ source: "file", path: "/etc/hosts" })).rejects.toThrow(/only tones/)
    expect(play).toHaveBeenCalledTimes(2)
  })
})
