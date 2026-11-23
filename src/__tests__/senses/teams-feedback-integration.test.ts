import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import type { RunAgentOptions, ChannelCallbacks, ProviderRuntime } from "../../heart/core"
import { feedbackStorePath, openFeedbackStore } from "../../senses/shepherd/feedback-store"
import { loadSession } from "../../mind/context"
import { createOwnerNotifier } from "../../senses/shepherd/owner-notice"
import { readNoticeOutbox } from "../../senses/shepherd/notice-outbox"
import { appendReturn, type ReturnRecord } from "../../senses/shepherd/returns"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { checkErrorContext, type PerTestEvent } from "../../nerves/coverage/audit-rules"
import { readInboundOutcome, type InboundJournal } from "../../senses/inbound-journal"
import { openTeamsInboundJournal, type TeamsInboundPayload } from "../../senses/teams-inbound"
import { turnSpoke } from "../../senses/turn-attempts"

const state = vi.hoisted(() => ({
  root: "", handlers: new Map<string, (ctx: any) => Promise<void>>(), run: vi.fn(), handlerLogFailures: 0,
  refusalLogFailures: 0,
  requestEvents: [] as PerTestEvent[],
  processActivity: undefined as ((body: unknown) => Promise<unknown>) | undefined,
  sdkAcceptances: [] as Array<{ activityId: string; conversationId: string; outgoingId: string }>,
  sdkLostAck: false,
  /** How long a fixture SDK send takes, so sends nothing waits on are still in flight when the turn returns. */
  sdkSendDelayMs: 0,
  sdkRealTransport: false,
  sdkTransportLostAckOnce: false,
  sdkTypingRejectAt: 0,
  sdkTypingAttempts: 0,
  sdkTypingError: undefined as unknown,
  sdkHttpBodies: [] as Array<Record<string, unknown>>,
}))
vi.mock("@microsoft/teams.apps", async original => {
  const actual = await original<typeof import("@microsoft/teams.apps")>()
  const client = {
    clone() { return this }, get: async () => ({ data: {} }), request: async () => ({ data: {} }),
    post: async (_url: string, value: { type?: string; text?: string; replyToId?: string; channelData?: { streamType?: string } }) => {
      if (state.sdkRealTransport) state.sdkHttpBodies.push(structuredClone(value))
      if (value.type === "typing" && ++state.sdkTypingAttempts === state.sdkTypingRejectAt) {
        throw state.sdkTypingError
      }
      if (state.sdkRealTransport && value.text && value.channelData?.streamType !== "informative") {
        const outgoingId = `http-accepted-${state.sdkAcceptances.length + 1}`
        state.sdkAcceptances.push({ activityId: value.replyToId ?? "sdk-stream", conversationId: "private-chat", outgoingId })
        if (state.sdkTransportLostAckOnce) {
          state.sdkTransportLostAckOnce = false
          throw new Error("fixture HTTP accepted but lost acknowledgement")
        }
        return { data: { id: outgoingId } }
      }
      return { data: {} }
    },
  }
  return { ...actual, App: class extends actual.App {
    constructor(options: ConstructorParameters<typeof actual.App>[0]) {
      super({ ...options, client: client as never })
      const on = this.on.bind(this)
      this.on = (event: any, handler: any) => { state.handlers.set(event, handler); return on(event, handler) }
      this.getUserToken = async () => undefined
      if (!state.sdkRealTransport) this.activitySender = {
        createStream: () => ({
          events: new EventEmitter(),
          emit() { throw new Error("fixture rejected before transport") },
          update() {}, close: async () => undefined,
        }),
        send: async (value: unknown, ref: { activityId: string; conversation: { id: string } }) => {
          if ((value as { type?: string }).type === "typing") return { id: "fixture-typing" }
          if (state.sdkSendDelayMs) await new Promise(resolve => setTimeout(resolve, state.sdkSendDelayMs))
          const outgoingId = `sdk-accepted-${state.sdkAcceptances.length + 1}`
          state.sdkAcceptances.push({ activityId: ref.activityId, conversationId: ref.conversation.id, outgoingId })
          if (state.sdkLostAck) throw new Error("fixture lost acknowledgement after acceptance")
          return { ...(value as object), id: outgoingId }
        },
      } as never
      state.processActivity = body => this.process({ body, token: { serviceUrl: "https://fixture.invalid" } } as never)
    }
    event() {}
    start() {}
  } }
})
vi.mock("../../heart/identity", async (original) => ({
  ...await original<typeof import("../../heart/identity")>(),
  getAgentName: () => "orchid",
  getAgentRoot: () => state.root,
  getAgentStateRoot: () => path.join(state.root, "state"),
  loadAgentConfig: () => ({ name: "orchid", provider: "minimax", context: { maxTokens: 80000, contextMargin: 20 },
    phrases: { thinking: ["thinking"], tool: ["tool"], followup: ["followup"] } }),
}))
vi.mock("../../heart/config", async (original) => ({
  ...await original<typeof import("../../heart/config")>(),
  sessionPath: (friend: string, _channel: string, conversation: string) => path.join(state.root, "sessions", friend, `${conversation}.json`),
  getTeamsConfig: () => ({ clientId: "fake-app", clientSecret: "fake", tenantId: "tenant" }),
  getTeamsSecondaryConfig: () => ({}),
  getOAuthConfig: () => ({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
  resolveOAuthForTenant: () => ({ graphConnectionName: "graph", adoConnectionName: "ado", githubConnectionName: "github" }),
  getTeamsChannelConfig: () => ({ flushIntervalMs: 1000, port: 3978 }),
}))
vi.mock("../../heart/core", async (original) => ({
  ...await original<typeof import("../../heart/core")>(),
  runAgent: (...args: unknown[]) => state.run(...args),
}))
vi.mock("../../mind/prompt", async (original) => ({
  ...await original<typeof import("../../mind/prompt")>(),
  buildSystem: async () => ({ stable: "Test system", volatile: "" }),
}))
vi.mock("../../repertoire/mcp-manager", () => ({ getSharedMcpManager: async () => null }))
vi.mock("../../nerves/runtime", async (original) => {
  const actual = await original<typeof import("../../nerves/runtime")>()
  return { ...actual, emitNervesEvent: (event: Parameters<typeof actual.emitNervesEvent>[0]) => {
    if (event.event === "channel.message_received" || event.event === "channel.teams_request_stage") state.requestEvents.push(event)
    if (event.event === "senses.shepherd_feedback_reply_refused" && state.refusalLogFailures > 0) {
      state.refusalLogFailures--
      throw new Error("fixture refusal-reporting sink unavailable")
    }
    if (event.event === "channel.handler_error" || event.event === "channel.feedback_handler_error") {
      // External error reporting can itself fail. Preserve the actual provider,
      // binding, lease and persistence path; inject only the failing sink.
      if (state.handlerLogFailures > 0) {
        state.handlerLogFailures--
        throw new Error("fixture error-reporting sink unavailable")
      }
      console.error(event)
    }
    if (event.level === "error" || event.level === "warn") state.requestEvents.push(event)
    actual.emitNervesEvent(event)
  } }
})
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/feedback-teams-fake.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

const idA = "feedback:11111111-1111-4111-8111-111111111111"
const idB = "feedback:22222222-2222-4222-8222-222222222222"
const sourceA = "33333333-3333-4333-8333-333333333333"
const sourceB = "44444444-4444-4444-8444-444444444444"

async function setup() {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-teams-pipeline-"))
  console.info(`created private test root: ${state.root}`)
  fs.writeFileSync(path.join(state.root, "agent.json"), JSON.stringify({ name: "orchid", provider: "minimax" }))
  const friend: FriendRecord = {
    id: "owner", name: "Owner", role: "friend", trustLevel: "family", connections: [],
    externalIds: [{ provider: "aad", externalId: "aad-owner", tenantId: "tenant", linkedAt: "2026-10-15" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-10-15", updatedAt: "2026-10-15", schemaVersion: 1,
  }
  await new FileFriendStore(path.join(state.root, "friends")).put("owner", friend)
  const store = openFeedbackStore(feedbackStorePath(state.root))
  for (const [id, source, message] of [[idA, sourceA, "sent-a"], [idB, sourceB, "sent-b"]]) {
    store.submit({ id, actorId: "owner", agent: "orchid", bodyHash: "a".repeat(64), createdAt: "2026-10-15T19:00:00Z",
      source: { id: source, host: "cmux", label: `Historic ${message}`, tty: "/dev/ttys001", cwd: "/historical", task: null },
      packet: { feedback: `Feedback for ${message}`, context: "Untrusted background", screen: "Historical screen", previousReturn: null },
      recipient: { friendId: "owner", aadObjectId: "aad-owner", tenantId: "tenant" }, receipt: "Received." })
    store.claimReview(id, "owner", "worker")
    store.completeReview(id, "owner", "worker", `Question about ${message}?`)
    store.claimDelivery(id, "owner", "worker")
    store.completeDelivery(id, "owner", "worker", { state: "sent", conversationId: "private-chat", messageId: message })
  }
  store.close()
  const { startTeamsApp } = await import("../../senses/teams")
  startTeamsApp()
}

let incomingSequence = 0
function activity(text: string, replyToId?: string, aad = "aad-owner", conversation = "private-chat") {
  return {
    stream: { emit: vi.fn(), update: vi.fn(), close: vi.fn() },
    activity: { id: `incoming-${++incomingSequence}`, text, replyToId, conversation: { id: conversation, tenantId: "tenant" },
      from: { id: aad, aadObjectId: aad, name: aad }, channelId: "msteams" },
    api: { users: { token: { get: vi.fn().mockResolvedValue(undefined) } } },
    signin: vi.fn(), send: vi.fn().mockResolvedValue({ id: "outgoing" }),
  }
}

function sdkActivity(text: string, replyToId?: string) {
  return { ...activity(text, replyToId).activity, type: "message", serviceUrl: "https://fixture.invalid", recipient: { id: "fake-app", role: "bot" } }
}

beforeEach(async () => {
  vi.resetModules()
  state.handlers.clear()
  state.handlerLogFailures = 0
  state.refusalLogFailures = 0
  state.requestEvents = []
  state.sdkAcceptances = []
  state.sdkLostAck = false
  state.sdkSendDelayMs = 0
  state.sdkRealTransport = false
  state.sdkTransportLostAckOnce = false
  state.sdkTypingRejectAt = 0
  state.sdkTypingAttempts = 0
  state.sdkTypingError = new Error("fixture typing status rejected: 403")
  state.sdkHttpBodies = []
  incomingSequence = 0
  state.run.mockReset().mockImplementation(async (messages, callbacks: ChannelCallbacks) => {
    messages.push({ role: "assistant", content: "Clarification recorded." })
    callbacks.onTextChunk("Clarification recorded.")
    return { outcome: "settled" }
  })
  await setup()
}, 60_000)

afterEach(() => {
  expect(checkErrorContext({ "actual Teams SDK integration": state.requestEvents })).toEqual({ status: "pass", violations: [] })
})

describe("actual Teams feedback adapter and leased pipeline", () => {
  it.each([1, 2])("delivers the real core's settled answer when the SDK rejects advisory typing attempt %s", async (rejectAt) => {
    state.sdkRealTransport = true
    state.sdkTypingRejectAt = rejectAt
    if (rejectAt === 1) state.sdkTypingError = "fixture typing status rejected: 403"
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    let providerAttempts = 0
    const signals: AbortSignal[] = []
    const runtime: ProviderRuntime = {
      id: "minimax", model: "local-teams-delivery-fixture", client: {}, capabilities: new Set(),
      resetTurnState() {}, appendToolOutput() {}, async ping() {}, classifyError: () => "unknown",
      async streamTurn(request) {
        providerAttempts++
        signals.push(request.signal!)
        await new Promise(resolve => setImmediate(resolve))
        return { content: "", outputItems: [], toolCalls: [{
          id: "settled-reply", name: "settle",
          arguments: JSON.stringify({ answer: "Your request has a useful answer.", intent: "complete" }),
        }] }
      },
    }
    state.run.mockImplementation(async (messages, callbacks, channel, signal, options) => {
      const actual = await vi.importActual<typeof import("../../heart/core")>("../../heart/core")
      return actual.runAgent(messages, callbacks, channel, signal, {
        ...options, providerRuntimeOverride: runtime, skipKeptNotes: true,
      })
    })
    const body = sdkActivity("Please answer my request.")
    await state.processActivity!(structuredClone(body))
    await state.processActivity!(structuredClone(body))
    expect(providerAttempts).toBe(1)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    expect(state.sdkHttpBodies.filter(value => value.type === "message")).toEqual([
      expect.objectContaining({ text: "Your request has a useful answer.", replyToId: body.id }),
    ])
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.requestEvents).toContainEqual(expect.objectContaining({
      level: "warn", event: "channel.teams_typing_failed",
      meta: expect.objectContaining({ inboundActivityId: body.id, conversationId: "private-chat" }),
    }))
  })

  it("uses actual SDK single-attempt messages with correlation and AI labels, without stream finalization", async () => {
    state.sdkRealTransport = true
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    const body = sdkActivity("One ordinary acknowledged reply.")
    await state.processActivity!(body)
    expect(state.sdkHttpBodies.filter(value => value.type === "message")).toEqual([
      expect.objectContaining({ text: "Clarification recorded.", replyToId: body.id,
        entities: expect.arrayContaining([expect.objectContaining({ additionalType: ["AIGeneratedContent"] })]),
        channelData: { feedbackLoopEnabled: true } }),
    ])
    expect(state.sdkHttpBodies.filter(value => value.type === "typing")).toEqual([{ type: "typing",
      from: expect.any(Object), conversation: expect.any(Object) }])
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({
      stage: "replied", outboundActivityId: "http-accepted-1", delivery: "accepted", inboundActivityId: body.id,
    }) }))
  })

  it("delivers long SDK output as bounded single-attempt messages without an SDK stream resend", async () => {
    state.sdkRealTransport = true
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    const text = "x".repeat(5000)
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      messages.push({ role: "assistant", content: text })
      callbacks.onTextChunk(text)
      callbacks.onToolStart("read_file", {})
      return { outcome: "settled" }
    })
    const body = sdkActivity("A long bounded answer.")
    await state.processActivity!(body)
    const sent = state.sdkHttpBodies.filter(value => value.type === "message")
    expect(sent.map(value => value.text)).toEqual(["x".repeat(4000), "x".repeat(1000)])
    expect(sent.every(value => value.replyToId === body.id)).toBe(true)
    expect(state.sdkAcceptances).toHaveLength(2)
  })

  it("awaits an uncertain slash-command reply without replaying it on SDK redelivery", async () => {
    state.sdkRealTransport = true
    state.sdkTransportLostAckOnce = true
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    const body = sdkActivity("/new")
    await expect(state.processActivity!(structuredClone(body))).resolves.toMatchObject({ status: 500 })
    await expect(state.processActivity!(structuredClone(body))).resolves.toMatchObject({ status: 200 })
    expect(state.run).not.toHaveBeenCalled()
    expect(state.sdkAcceptances).toHaveLength(1)
  })

  it("does not let the real SDK stream retry an accepted HTTP reply with a lost acknowledgement", async () => {
    state.sdkRealTransport = true
    state.sdkTransportLostAckOnce = true
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    const body = sdkActivity("One reply at the actual SDK transport boundary.")
    await state.processActivity!(structuredClone(body))
    await state.processActivity!(structuredClone(body))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.requestEvents.some(event => event.meta?.stage === "replied")).toBe(false)
  })

  it("runs an ordinary follow-up admitted after the previous provider exits instead of stranding steering", async () => {
    const entered = Promise.withResolvers<void>()
    const releaseProvider = Promise.withResolvers<void>()
    const admissionEntered = Promise.withResolvers<void>()
    const releaseAdmission = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await releaseProvider.promise
      expect(options.drainSteeringFollowUps!()).toEqual([])
      messages.push({ role: "assistant", content: "First answer." })
      callbacks.onTextChunk("First answer.")
      return { outcome: "settled" }
    })
    const first = state.processActivity!(sdkActivity("First request."))
    await entered.promise
    const original = FileFriendStore.prototype.findByExternalId
    const lookup = vi.spyOn(FileFriendStore.prototype, "findByExternalId").mockImplementationOnce(async function (...args) {
      admissionEntered.resolve()
      await releaseAdmission.promise
      return original.apply(this, args)
    })
    const second = sdkActivity("A follow-up arriving at the exit boundary.")
    const following = state.processActivity!(structuredClone(second))
    await admissionEntered.promise
    releaseProvider.resolve()
    try {
      const { currentSessionTurnLease } = await import("../../mind/session-transaction")
      await vi.waitFor(() => expect(currentSessionTurnLease(path.join(state.root, "sessions", "owner", "private-chat.json"))).toBeNull())
    } finally { releaseAdmission.resolve(); lookup.mockRestore() }
    await Promise.all([first, following])
    expect(state.run).toHaveBeenCalledTimes(2)
    expect(state.run.mock.calls[1][4].toolContext.currentUserMessage).toBe(second.text)
    expect(state.sdkAcceptances).toHaveLength(2)
    await state.processActivity!(structuredClone(second))
    expect(state.run).toHaveBeenCalledTimes(2)
  })

  it("runs admitted steering in its own context if the active provider exits without consuming it", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      entered.resolve()
      await release.promise
      messages.push({ role: "assistant", content: "First answer." })
      callbacks.onTextChunk("First answer.")
      return { outcome: "settled" }
    })
    const first = state.processActivity!(sdkActivity("First request."))
    await entered.promise
    const body = sdkActivity("A follow-up the active model does not consume.")
    await state.processActivity!(structuredClone(body))
    const tail = sdkActivity("Another follow-up preserving its original SDK context.")
    await state.processActivity!(structuredClone(tail))
    release.resolve()
    await first
    expect(state.run).toHaveBeenCalledTimes(3)
    expect(state.run.mock.calls[1][4].toolContext.currentUserMessage).toBe(body.text)
    expect(state.run.mock.calls[2][4].toolContext.currentUserMessage).toBe(tail.text)
    expect(state.sdkAcceptances).toHaveLength(3)
    expect(state.sdkAcceptances[1].activityId).toBe(body.id)
    expect(state.sdkAcceptances[2].activityId).toBe(tail.id)
  })

  it("does not strand later turns when an unconsumed steering fallback and its error sink fail", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      entered.resolve()
      await release.promise
      messages.push({ role: "assistant", content: "First answer." })
      callbacks.onTextChunk("First answer.")
      return { outcome: "settled" }
    })
    state.run.mockRejectedValueOnce(new Error("fixture queued steering provider failure"))
    state.handlerLogFailures = 1
    const first = state.processActivity!(sdkActivity("First request."))
    await entered.promise
    const failed = sdkActivity("The unconsumed request whose provider fails.")
    await state.processActivity!(failed)
    release.resolve()
    await first
    expect(state.run).toHaveBeenCalledTimes(2)
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({
      stage: "failed", inboundActivityId: failed.id, reason: "handler_failed",
    }) }))
    await state.processActivity!(sdkActivity("An independent request after the failure."))
    expect(state.run).toHaveBeenCalledTimes(3)
    expect(state.sdkAcceptances).toHaveLength(2)
  })

  it.each(["conversation", "tenant", "actor", "channel"])("refuses incomplete production %s identity before admission", async missing => {
    vi.stubEnv("OURO_TEAMS_DEVTOOLS", "0")
    try {
      const body = sdkActivity("Incomplete identity must not authorize execution.")
      if (missing === "conversation") body.conversation.id = ""
      if (missing === "tenant") body.conversation.tenantId = ""
      if (missing === "actor") body.from.id = body.from.aadObjectId = ""
      if (missing === "channel") body.channelId = ""
      await expect(state.processActivity!(body)).resolves.toMatchObject({ status: 500 })
      expect(state.run).not.toHaveBeenCalled()
      expect(state.sdkAcceptances).toEqual([])
      expect(fs.existsSync(path.join(state.root, "sessions", "owner", "private-chat.json.turn.lock"))).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })

  it("keeps distinct fallback actors separate when their optional AAD identity is empty", async () => {
    const store = new FileFriendStore(path.join(state.root, "friends"))
    const friend = (await store.get("owner"))!
    friend.externalIds.push({ provider: "teams-conversation", externalId: "private-chat", tenantId: "tenant", linkedAt: "2026-10-16" })
    await store.put("owner", friend)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let drained: unknown[] = []
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      drained = options.drainSteeringFollowUps!()
      messages.push({ role: "assistant", content: "First answer." })
      callbacks.onTextChunk("First answer.")
      return { outcome: "settled" }
    })
    const firstBody = sdkActivity("Request from the first fallback actor.")
    firstBody.from = { ...firstBody.from, id: "sender-one", aadObjectId: "" }
    const first = state.processActivity!(firstBody)
    await entered.promise
    const nextBody = sdkActivity("Request from the second fallback actor.")
    nextBody.from = { ...nextBody.from, id: "sender-two", aadObjectId: "" }
    const next = state.processActivity!(nextBody)
    try {
      await vi.waitFor(() => expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({
        stage: "admitted", inboundActivityId: nextBody.id,
      }) })))
    } finally { release.resolve() }
    await Promise.all([first, next])
    expect(drained).toEqual([])
    expect(state.run).toHaveBeenCalledTimes(2)
    expect(state.sdkAcceptances).toHaveLength(2)
  })

  // A message admitted before Teams kept a journal has no record of what went out, so it is held, never guessed at.
  // One admitted since is answered or recorded as failed by the next start (see "Teams messages whose turn never finished").
  it("holds an admission with no journal entry without claiming that it answered", async () => {
    const body = sdkActivity("The previous process stopped before executing this.")
    const { admitSessionActivity } = await import("../../mind/session-transaction")
    admitSessionActivity(path.join(state.root, "sessions", "owner", "private-chat.json"), {
      namespace: JSON.stringify(["teams.message", "msteams", "fake-app", "tenant", "aad-owner", "private-chat"]),
      activityId: body.id,
      payloadDigest: createHash("sha256").update(JSON.stringify([body.text, null])).digest("hex"),
    })
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    await expect(state.processActivity!(body)).resolves.toMatchObject({ status: 200 })
    expect(state.run).not.toHaveBeenCalled()
    expect(state.sdkAcceptances).toEqual([])
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ stage: "duplicate_held", outcome: "not_replayed" }) }))
    expect(state.requestEvents.some(event => event.meta?.stage === "replied")).toBe(false)
    expect(fs.existsSync(path.join(state.root, "sessions", "owner", "private-chat.json"))).toBe(false)
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
  })

  it.each([undefined, "sent-b"])("holds duplicate SDK activity before busy steering or quoted queue (%s)", async quote => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let drained: unknown[] = []
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      drained = options.drainSteeringFollowUps!()
      messages.push({ role: "assistant", content: "First answer." })
      callbacks.onTextChunk("First answer.")
      return { outcome: "settled" }
    })
    const body = sdkActivity("First request.")
    const running = state.processActivity!(structuredClone(body))
    await entered.promise
    const queuedBody = quote ? sdkActivity("Quoted clarification.", quote) : body
    const queued = quote ? state.processActivity!(structuredClone(queuedBody)) : undefined
    try {
      await expect(state.processActivity!(structuredClone(queuedBody))).resolves.toMatchObject({ status: 200 })
    } finally { release.resolve() }
    await Promise.all([running, queued])
    expect(drained).toEqual([])
    expect(state.run).toHaveBeenCalledTimes(quote ? 2 : 1)
    expect(state.sdkAcceptances).toHaveLength(quote ? 2 : 1)
    const persisted = loadSession(path.join(state.root, "sessions", "owner", "private-chat.json"))
    const text = quote ? "Quoted clarification." : "First request."
    expect(persisted?.messages.filter(message => message.role === "user" && message.content === text)).toHaveLength(1)
  })

  it("never resends after an uncertain SDK send acceptance, including after restart", async () => {
    state.sdkLostAck = true
    const body = sdkActivity("Do this once even if the acknowledgement is lost.")
    await state.processActivity!(structuredClone(body))
    expect(state.sdkAcceptances).toHaveLength(1)
    // The send was noted before it went out, so the message is recorded as failed rather than left to replay.
    const [outcome] = fs.readdirSync(path.join(state.root, "state", "senses", "teams", "inbound-outcomes"))
      .map(file => JSON.parse(fs.readFileSync(path.join(state.root, "state", "senses", "teams", "inbound-outcomes", file), "utf8")))
    expect(outcome).toMatchObject({ outcome: "failed", detail: expect.stringContaining("fixture lost acknowledgement after acceptance") })
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    state.sdkLostAck = false
    await state.processActivity!(structuredClone(body))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ stage: "duplicate_held", outcome: "not_replayed" }) }))
    expect(state.requestEvents).not.toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ stage: "replied", delivery: "accepted" }) }))
  })

  it("fails closed on corrupt admission storage without poisoning the next admission", async () => {
    const lock = path.join(state.root, "sessions", "owner", "private-chat.json.turn.lock")
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, "not a SQLite database")
    const body = sdkActivity("Do not run without durable evidence.")
    await expect(state.processActivity!(structuredClone(body))).resolves.toMatchObject({ status: 500 })
    expect(state.run).not.toHaveBeenCalled()
    expect(state.sdkAcceptances).toEqual([])
    fs.renameSync(lock, `${lock}.fixture-corrupt`)
    await expect(state.processActivity!(structuredClone(body))).resolves.toMatchObject({ status: 200 })
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.sdkAcceptances).toHaveLength(1)
  })

  it("rejects a production SDK message without an activity ID before execution", async () => {
    vi.stubEnv("OURO_TEAMS_DEVTOOLS", "0")
    try {
      const body = { ...sdkActivity("No identity must mean no execution."), id: undefined }
      await expect(state.processActivity!(body)).resolves.toMatchObject({ status: 500 })
      expect(state.run).not.toHaveBeenCalled()
      expect(state.sdkAcceptances).toEqual([])
    } finally { vi.unstubAllEnvs() }
  })

  it("admits identical text with a distinct SDK ID but rejects changed payload under an existing ID", async () => {
    const body = sdkActivity("Same words, independent requests.")
    await state.processActivity!(structuredClone(body))
    await state.processActivity!({ ...body, id: "different-id" })
    await expect(state.processActivity!({ ...body, text: "Changed payload." })).resolves.toMatchObject({ status: 500 })
    expect(state.run).toHaveBeenCalledTimes(2)
    expect(state.sdkAcceptances).toHaveLength(2)
    const persisted = loadSession(path.join(state.root, "sessions", "owner", "private-chat.json"))
    expect(persisted?.messages.filter(message => message.role === "user" && message.content === body.text)).toHaveLength(2)
    expect(JSON.stringify(persisted?.messages)).not.toContain("Changed payload.")
  })

  it.each(["sequential", "restart", "reset"] as const)("admits a repeated real SDK activity once across %s", async boundary => {
    state.run.mockImplementation(async (messages, callbacks: ChannelCallbacks) => {
      messages.push({ role: "assistant", content: "One synthetic answer." })
      callbacks.onTextChunk("One synthetic answer.")
      await callbacks.flushNow?.()
      return { outcome: "settled" }
    })
    const body = { ...activity("One synthetic request.").activity, type: "message", serviceUrl: "https://fixture.invalid", recipient: { id: "fake-app", role: "bot" } }
    await state.processActivity!(structuredClone(body))
    if (boundary === "restart") {
      vi.resetModules()
      const { startTeamsApp } = await import("../../senses/teams")
      startTeamsApp()
    }
    if (boundary === "reset") await state.handlers.get("message")!(activity("/new"))
    await state.processActivity!(structuredClone(body))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.sdkAcceptances[0]).toMatchObject({ activityId: body.id, conversationId: "private-chat" })
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ stage: "duplicate_held", inboundActivityId: body.id }) }))
  })

  it("waits for the SDK send acknowledgement instead of claiming early completion", async () => {
    const emitted = Promise.withResolvers<{ id: string }>()
    const ctx = activity("Give me the short version.")
    ctx.send.mockImplementation(value => value.type === "typing" ? Promise.resolve({ id: "typing" }) : emitted.promise)
    let complete = false
    const request = state.handlers.get("message")!(ctx).then(() => { complete = true })
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: "message" })))
    await new Promise(resolve => setImmediate(resolve))
    expect(complete).toBe(false)
    emitted.resolve({ id: "acknowledged" })
    await request
    expect(complete).toBe(true)
  })

  it.each(["every", "off"] as const)("human_request_is_not_satisfied_by_proactive_notice with %s notice policy", async policy => {
    const backlog: ReturnRecord[] = Array.from({ length: 207 }, (_, index) => ({
      at: "2026-10-15T10:00:00.000Z", host: "fixture-host", session: `session-${index % 7}`,
      transition: `observation-${index}`, agent: "Fixture coding agent", cwd: "/fixture/project", task: null,
      kind: "waiting", action: "let_through", reason: "Historical backlog waiting for review.", reply: null,
      latencyMs: 2, inputTokens: 10, noticeEligible: true,
    }))
    for (const record of backlog) appendReturn(state.root, record)
    const proactive = vi.fn(async () => ({ delivered: true, delivery: { state: "accepted" as const, messageId: "historical-digest" } }))
    const makeNotifier = (noticePolicy: "every" | "off") => createOwnerNotifier({
      agent: "orchid", agentRoot: state.root, policy: noticePolicy, schedule: () => () => {},
      listSessions: async () => [],
      resolveTargets: async () => [{ friendId: "owner", name: "Owner", key: "private-chat" }],
      send: proactive,
    })
    const before = makeNotifier("every")
    await before.flush()
    expect(proactive).not.toHaveBeenCalled()
    for (const record of backlog) await before.notify(record)
    before.stop()
    const recovered = makeNotifier(policy)
    try {
      await recovered.flush()
      expect(proactive).toHaveBeenCalledTimes(policy === "every" ? 1 : 0)
      if (policy === "every") expect(proactive.mock.calls[0]).toEqual([
        expect.objectContaining({ friendId: "owner" }), expect.stringContaining("Catching up on things I saw earlier"), expect.any(Array),
      ])
      const request = "Give me a short, funny summary of current coding work that fits on my phone."
      const answer = "Seven sessions: progress, tests, and one heroic argument with a semicolon."
      state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
        messages.push({ role: "assistant", content: answer })
        callbacks.onTextChunk(answer)
        await callbacks.flushNow?.()
        return { outcome: "settled" }
      })
      const ctx = activity(request)
      ctx.activity.id = "phone-summary"
      await state.handlers.get("message")!(ctx)
      expect(state.run).toHaveBeenCalledTimes(1)
      const options = state.run.mock.calls[0][4] as RunAgentOptions
      expect(options.toolContext?.currentUserMessage).toBe(request)
      expect(options.toolContext?.currentShepherdSurface).toBeUndefined()
      expect(ctx.send.mock.calls.filter(([value]) => value.type === "message")).toHaveLength(1)
      expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ text: answer, replyToId: "phone-summary" }))
      expect(answer.length).toBeLessThan(160)
      expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({
        stage: "replied", inboundActivityId: "phone-summary", conversationId: "private-chat", outboundActivityId: "outgoing", delivery: "accepted",
      }) }))
      const persisted = loadSession(path.join(state.root, "sessions", "owner", "private-chat.json"))
      expect(JSON.stringify(persisted?.messages)).toContain(request)
      expect(JSON.stringify(persisted?.messages)).toContain(answer)
      const intents = readNoticeOutbox(state.root)
      expect(intents).toHaveLength(207)
      expect(intents.every(entry => policy === "every"
        ? entry.deliveries.owner?.messageId === "historical-digest"
        : Object.keys(entry.deliveries).length === 0)).toBe(true)
      expect(proactive).toHaveBeenCalledTimes(policy === "every" ? 1 : 0)
    } finally { recovered.stop() }
  })

  it("personal_request_preserves_activity_identity_and_reply_target", async () => {
    const request = "Give me a short, funny summary of these coding sessions that fits on a phone."
    const answer = "Three coding sessions: one shipping, one testing, one negotiating with a semicolon."
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      messages.push({ role: "assistant", content: answer })
      callbacks.onTextChunk(answer)
      return { outcome: "settled" }
    })
    const ctx = activity(request)
    ctx.activity.id = "summary-request"
    await state.handlers.get("message")!(ctx)
    expect(state.run).toHaveBeenCalledTimes(1)
    const options = state.run.mock.calls[0][4] as RunAgentOptions
    expect(options.toolContext?.currentUserMessage).toBe(request)
    expect(options.toolContext?.context?.friend.id).toBe("owner")
    expect(ctx.send.mock.calls.some(([value]) => JSON.stringify(value).includes(answer))).toBe(true)
    const stages = state.requestEvents.map(event => event.meta?.stage)
    expect(stages).toContain("received")
    expect(stages).toContain("admitted")
    expect(stages).toContain("running")
    expect(stages).toContain("reply_emitted")
    expect(state.requestEvents.every(event => event.meta?.inboundActivityId === "summary-request")).toBe(true)
    expect(state.requestEvents.every(event => event.meta?.conversationId === "private-chat")).toBe(true)
    expect(state.requestEvents.some(event => event.meta?.botId === "fake-app")).toBe(true)
    expect(JSON.stringify(state.requestEvents)).not.toContain(request)
    expect(JSON.stringify(state.requestEvents)).not.toContain(answer)
  })

  // Dropping incoming replyToId would remove this source and archived question.
  it("threads SDK incoming quote into the real leased pipeline without rewriting the utterance", async () => {
    const ctx = activity("Only this session, please.", "sent-a")
    await state.handlers.get("message")!(ctx)
    expect(state.run).toHaveBeenCalledTimes(1)
    const options = state.run.mock.calls[0][4] as RunAgentOptions
    expect(options.toolContext?.context?.friend.id).toBe("owner")
    expect(options.toolContext?.currentUserMessage).toBe("Only this session, please.")
    expect(options.toolContext?.currentShepherdSurface?.id).toBe(sourceA)
    expect(Object.isFrozen(options.toolContext?.currentShepherdSurface)).toBe(true)
    expect(options.orientationFrame?.source).toMatchObject({ authority: "presentation_only", threadId: idA })
    expect(options.orientationFrame?.source?.replyingToText).toContain("Question about sent-a?")
    expect(options.orientationFrame?.source?.replyingToText).not.toContain("Question about sent-b?")
    const persisted = loadSession(path.join(state.root, "sessions", "owner", "private-chat.json"))
    expect(JSON.stringify(persisted?.messages)).toContain("Only this session, please.")
    expect(JSON.stringify(persisted?.messages)).toContain("Clarification recorded.")
    expect(ctx.send.mock.calls.some(([value]) => JSON.stringify(value).includes("Clarification recorded."))).toBe(true)
  })

  it.each([
    [idA, undefined, "other-actor", "private-chat"],
    [idA, undefined, "aad-owner", "other-chat"],
    [idB, "sent-a", "aad-owner", "private-chat"],
    ["feedback:missing", undefined, "aad-owner", "private-chat"],
  ])("refuses before model/tools but actually emits a short clarification (%s)", async (text, quote, actor, chat) => {
    const ctx = activity(text!, quote, actor, chat)
    await state.handlers.get("message")!(ctx)
    expect(state.run).not.toHaveBeenCalled()
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: "message" }))
    expect(JSON.stringify(ctx.send.mock.calls)).not.toMatch(/Historical|Feedback for|Question about|33333333|44444444|\/historical/)
  })

  it.each([
    ["other-actor", "private-chat"],
    ["aad-owner", "other-chat"],
  ])("refuses a known archived bare quote before model/tools for actor %s in chat %s", async (actor, chat) => {
    const ctx = activity("Only this one, please.", "sent-a", actor, chat)
    await state.handlers.get("message")!(ctx)
    expect(state.run).not.toHaveBeenCalled()
    expect(ctx.send.mock.calls.filter(([value]) => value.type === "message")).toHaveLength(1)
    expect(JSON.stringify(ctx.send.mock.calls)).toContain("feedback")
    expect(JSON.stringify(ctx.send.mock.calls)).not.toMatch(/Historical|Feedback for|Question about|33333333|44444444|\/historical|sent-a|owner|other-chat/)
  })

  it("keeps an ordinary unknown quote on the normal path", async () => {
    await state.handlers.get("message")!(activity("hello", "ordinary-message"))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0][4].toolContext.currentShepherdSurface).toBeUndefined()
  })

  it("preserves the pipeline correction policy instead of resetting it when attaching feedback", async () => {
    await state.handlers.get("message")!(activity("No, that's wrong.", "sent-a"))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0][4].orientationFrame.actionPolicy.mode).toBe("correction_hold")
    expect(state.run.mock.calls[0][4].orientationFrame.source.replyingToText).toContain("Question about sent-a?")
  })

  it("preserves reaction reply correlation through the same handler", async () => {
    const ctx = activity("", "sent-b")
    Object.assign(ctx.activity, { value: { actionName: "feedback", actionValue: { reaction: "like", feedback: "yes" } } })
    await state.handlers.get("message.submit.feedback")!(ctx)
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0][4].toolContext.currentShepherdSurface?.id).toBe(sourceB)
  })

  it("does not grant a reaction with missing actor metadata the archived owner's context", async () => {
    const ctx = activity("", "sent-a")
    const anonymous = { ...ctx, activity: { ...ctx.activity, from: undefined,
      value: { actionName: "feedback", actionValue: { reaction: "like" } } } }
    await state.handlers.get("message.submit.feedback")!(anonymous)
    expect(state.run).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.stream.emit.mock.calls)).toContain("feedback")
    expect(JSON.stringify(ctx.stream.emit.mock.calls)).not.toMatch(/Historical|Question about|33333333|\/historical/)
  })

  it("propagates unexpected selection infrastructure failure and releases its actual lease", async () => {
    const { handleTeamsMessage } = await import("../../senses/teams")
    const { currentSessionTurnLease } = await import("../../mind/session-transaction")
    const ctx = activity("feedback:invalid")
    state.refusalLogFailures = 1
    await expect(handleTeamsMessage(ctx.activity.text, ctx.stream, "private-chat",
      { signin: async () => undefined, aadObjectId: "aad-owner", tenantId: "tenant" }))
      .rejects.toThrow("fixture refusal-reporting sink unavailable")
    expect(state.run).not.toHaveBeenCalled()
    expect(ctx.stream.emit).not.toHaveBeenCalled()
    expect(currentSessionTurnLease(path.join(state.root, "sessions", "owner", "private-chat.json"))).toBeNull()
    await state.handlers.get("message")!(activity("a subsequent safe clarification", "sent-b"))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0][4].toolContext.currentShepherdSurface?.id).toBe(sourceB)
  })

  // A baretext busy queue would steer source B into source A's ongoing tool calls.
  it("starts a quoted busy followup at the next leased boundary with its own source/transport", async () => {
    const { currentSessionTurnLease } = await import("../../mind/session-transaction")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const drained: unknown[] = []
    const leases: string[] = []
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      const lease = currentSessionTurnLease(path.join(state.root, "sessions", "owner", "private-chat.json"))
      expect(lease).not.toBeNull()
      leases.push(lease!.ownerToken)
      entered.resolve()
      await release.promise
      drained.push(...options.drainSteeringFollowUps!())
      messages.push({ role: "assistant", content: "First answer." })
      callbacks.onTextChunk("First answer.")
      return { outcome: "settled" }
    })
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      const lease = currentSessionTurnLease(path.join(state.root, "sessions", "owner", "private-chat.json"))
      expect(lease).not.toBeNull()
      leases.push(lease!.ownerToken)
      messages.push({ role: "assistant", content: "Clarification recorded." })
      callbacks.onTextChunk("Clarification recorded.")
      return { outcome: "settled" }
    })
    const first = activity("Answer A", "sent-a")
    const running = state.handlers.get("message")!(first)
    await entered.promise
    const second = activity("Answer B", "sent-b")
    const queued = state.handlers.get("message")!(second)
    await new Promise(resolve => setImmediate(resolve))
    expect(state.run).toHaveBeenCalledTimes(1)
    release.resolve()
    await Promise.all([running, queued])
    expect(drained).toEqual([])
    expect(new Set(leases).size).toBe(2)
    expect(state.run).toHaveBeenCalledTimes(2)
    expect(state.run.mock.calls.map(call => call[4].toolContext.currentShepherdSurface?.id)).toEqual([sourceA, sourceB])
    expect(state.run.mock.calls[1][4].toolContext.currentUserMessage).toBe("Answer B")
    expect(JSON.stringify(second.send.mock.calls)).toContain("Clarification recorded.")
    expect(JSON.stringify(first.send.mock.calls)).not.toContain("Clarification recorded.")
  })

  it("leaves ordinary same-actor unquoted busy steering in the active turn", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let drained: unknown[] = []
    state.run.mockImplementationOnce(async (_messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      drained = options.drainSteeringFollowUps!()
      callbacks.onTextChunk("Ordinary answer.")
      return { outcome: "settled" }
    })
    const running = state.handlers.get("message")!(activity("hello"))
    await entered.promise
    await state.handlers.get("message")!(activity("one more thing"))
    release.resolve()
    await running
    expect(drained).toEqual([{ text: "one more thing", effect: "none" }])
    expect(state.run).toHaveBeenCalledTimes(1)
  })

  // Losing the coordinator catch/reject/finally path would strand later SDK
  // requests or leave the conversation permanently active after an adapter fault.
  it("rejects failed initial and deferred turns without stranding the next leased request", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.handlerLogFailures = 2
    state.run.mockImplementationOnce(async (_messages, _callbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      expect(options.drainSteeringFollowUps!()).toEqual([])
      throw new Error("fixture first provider failure")
    })
    state.run.mockRejectedValueOnce(new Error("fixture deferred provider failure"))
    const initial = state.handlers.get("message")!(activity("first", "sent-a"))
    const initialResult = Promise.allSettled([initial])
    await entered.promise
    const deferred = state.handlers.get("message")!(activity("second", "sent-b"))
    const deferredResult = Promise.allSettled([deferred])
    // Even an ordinary followup behind the context-changing boundary must not
    // leapfrog it and steer the still-running first source.
    const tail = activity("after the queued clarification")
    const tailResult = state.handlers.get("message")!(tail)
    release.resolve()
    const [first, second] = await Promise.all([initialResult, deferredResult])
    await tailResult
    expect(first[0]).toMatchObject({ status: "rejected", reason: { message: "fixture error-reporting sink unavailable" } })
    expect(second[0]).toMatchObject({ status: "rejected", reason: { message: "fixture error-reporting sink unavailable" } })
    expect(state.run).toHaveBeenCalledTimes(3)
    expect(state.run.mock.calls[2][4].toolContext.currentUserMessage).toBe("after the queued clarification")
    expect(state.run.mock.calls[2][4].toolContext.currentShepherdSurface).toBeUndefined()
    expect(JSON.stringify(tail.send.mock.calls)).toContain("Clarification recorded.")
    const later = activity("new independent clarification", "sent-a")
    await state.handlers.get("message")!(later)
    expect(state.run).toHaveBeenCalledTimes(4)
    expect(state.run.mock.calls[3][4].toolContext.currentShepherdSurface?.id).toBe(sourceA)
    expect(JSON.stringify(later.send.mock.calls)).toContain("Clarification recorded.")
  })
})

// A message a dead process admitted but never answered is answered by the next process, or recorded as failed when
// part of its reply already went out or its tries are used up. A reply that went out is never sent again.
describe("Teams messages whose turn never finished", () => {
  const sessionFile = () => path.join(state.root, "sessions", "owner", "private-chat.json")

  /** The state a process leaves when it dies mid-turn: the admission, and a journal entry with one attempt counted. */
  async function leaveUnfinishedTurn(
    body: ReturnType<typeof sdkActivity>,
    options: { label?: string; after?: (journal: InboundJournal<TeamsInboundPayload>, id: string) => void } = {},
  ): Promise<string> {
    const { admitSessionActivity } = await import("../../mind/session-transaction")
    const { receiptId } = admitSessionActivity(sessionFile(), {
      namespace: JSON.stringify(["teams.message", "msteams", "fake-app", "tenant", "aad-owner", "private-chat"]),
      activityId: body.id,
      payloadDigest: createHash("sha256").update(JSON.stringify([body.text, null])).digest("hex"),
    })
    const journal = openTeamsInboundJournal(state.root)
    journal.record(receiptId, {
      label: options.label ?? "primary", activityId: body.id, conversationId: "private-chat", text: body.text,
      userId: "aad-owner", aadObjectId: "aad-owner", tenantId: "tenant", displayName: "aad-owner", channelId: "msteams",
    })
    journal.beginAttempt(receiptId)
    options.after?.(journal, receiptId)
    return receiptId
  }

  async function restart(): Promise<void> {
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
  }

  const outcomeFiles = () => fs.readdirSync(path.join(state.root, "state", "senses", "teams", "inbound-outcomes"))
    .map(file => JSON.parse(fs.readFileSync(path.join(state.root, "state", "senses", "teams", "inbound-outcomes", file), "utf8")))

  it("writes an admitted message to the journal, with its attempt counted, before its turn runs", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      entered.resolve()
      await release.promise
      messages.push({ role: "assistant", content: "Done." })
      callbacks.onTextChunk("Done.")
      return { outcome: "settled" }
    })
    const body = sdkActivity("Remember this if you crash.")
    const running = state.processActivity!(structuredClone(body))
    await entered.promise
    const [pending] = openTeamsInboundJournal(state.root).pending()
    expect(pending).toMatchObject({ attempts: 1, spoke: false, payload: {
      label: "primary", activityId: body.id, conversationId: "private-chat", text: body.text,
      userId: "aad-owner", aadObjectId: "aad-owner", tenantId: "tenant", channelId: "msteams",
    } })
    release.resolve()
    await running
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
    expect(readInboundOutcome(state.root, "teams", pending!.id)).toMatchObject({ outcome: "answered", attempts: 1 })
  })

  it("answers a message a dead process admitted but never answered, once, with a proactive send", async () => {
    const body = sdkActivity("The previous process stopped before answering this.")
    const id = await leaveUnfinishedTurn(body)
    // The person is not there to sign in, so a replayed turn that needs a sign-in sends no card for it.
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      messages.push({ role: "assistant", content: "AUTH_REQUIRED:graph" })
      callbacks.onTextChunk("Clarification recorded.")
      return { outcome: "settled" }
    })
    await restart()
    await vi.waitFor(() => expect(readInboundOutcome(state.root, "teams", id)).toMatchObject({ outcome: "answered", attempts: 2 }))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0][4].toolContext.currentUserMessage).toBe(body.text)
    expect(state.sdkAcceptances).toEqual([expect.objectContaining({ conversationId: "private-chat" })])
    // Teams' own redelivery of it is held, not run a second time.
    await expect(state.processActivity!(structuredClone(body))).resolves.toMatchObject({ status: 200 })
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ meta: expect.objectContaining({ stage: "duplicate_held", outcome: "not_replayed" }) }))
  })

  it("records a message whose turn died after part of its reply went out as failed, and never runs it again", async () => {
    const body = sdkActivity("Part of this answer already reached me.")
    const id = await leaveUnfinishedTurn(body, { after: (journal, inbound) => {
      journal.markSpoke(inbound, turnSpoke("speak", "Working on it.", null, Date.parse("2026-11-22T10:00:00.000Z")))
    } })
    await restart()
    await vi.waitFor(() => expect(readInboundOutcome(state.root, "teams", id)).toMatchObject({
      outcome: "failed", detail: "the turn stopped after 1 send (speak at 2026-11-22T10:00:00.000Z) went out, so it is not run again",
    }))
    expect(state.run).not.toHaveBeenCalled()
    expect(state.sdkAcceptances).toEqual([])
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ event: "senses.teams_inbound_not_replayed" }))
  })

  it("records a message whose turns keep dying as failed once its tries are used up, and leaves the other bot's messages to it", async () => {
    const secondary = sdkActivity("The secondary bot received this one.")
    const secondaryId = await leaveUnfinishedTurn(secondary, { label: "secondary" })
    const body = sdkActivity("Every turn for this one died.")
    const id = await leaveUnfinishedTurn(body, { after: (journal, inbound) => {
      journal.beginAttempt(inbound)
      journal.beginAttempt(inbound)
    } })
    await restart()
    await vi.waitFor(() => expect(readInboundOutcome(state.root, "teams", id)).toMatchObject({
      outcome: "failed", attempts: 3, detail: "the turn did not finish in 3 attempts",
    }))
    expect(state.run).not.toHaveBeenCalled()
    expect(openTeamsInboundJournal(state.root).get(secondaryId)).toMatchObject({ attempts: 1 })
  })

  const asRoot = process.getuid?.() === 0

  it.skipIf(asRoot)("keeps the message for the next start when its failure cannot be recorded", async () => {
    const body = sdkActivity("Recording this outcome will fail.")
    const id = await leaveUnfinishedTurn(body, { after: (journal, inbound) => journal.markSpoke(inbound, turnSpoke("speak", "Partial.")) })
    const outcomes = path.join(state.root, "state", "senses", "teams", "inbound-outcomes")
    fs.chmodSync(outcomes, 0o500)
    try {
      await restart()
      await vi.waitFor(() => expect(state.requestEvents).toContainEqual(expect.objectContaining({
        level: "error", event: "senses.teams_inbound_replay_failed", meta: expect.objectContaining({ label: "primary" }),
      })))
    } finally { fs.chmodSync(outcomes, 0o700) }
    expect(openTeamsInboundJournal(state.root).get(id)).toMatchObject({ spoke: true })
    expect(state.run).not.toHaveBeenCalled()
  })

  it("records a turn that threw as failed, and one with nothing to say as answered by Teams' fallback reply", async () => {
    state.run.mockImplementationOnce(async () => ({ outcome: "settled" }))
    state.run.mockRejectedValueOnce(new Error("fixture provider failure"))
    await state.processActivity!(sdkActivity("Say nothing."))
    // The fallback reply reached Teams.
    expect(state.sdkAcceptances).toHaveLength(1)
    await state.processActivity!(sdkActivity("This turn throws."))
    expect(outcomeFiles().map(({ outcome, detail }) => ({ outcome, detail })).sort((a, b) => a.outcome.localeCompare(b.outcome))).toEqual([
      { outcome: "answered", detail: undefined },
      { outcome: "failed", detail: "the turn failed: fixture provider failure" },
    ])
  })

  it.skipIf(asRoot)("keeps a thrown turn for the next start when its failure cannot be recorded", async () => {
    const outcomes = path.join(state.root, "state", "senses", "teams", "inbound-outcomes")
    state.run.mockImplementationOnce(async () => {
      fs.chmodSync(outcomes, 0o500)
      throw new Error("fixture provider failure")
    })
    try {
      await state.processActivity!(sdkActivity("Nothing records this."))
    } finally { fs.chmodSync(outcomes, 0o700) }
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ level: "error", event: "senses.teams_inbound_settle_failed" }))
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([expect.objectContaining({ attempts: 1, spoke: false })])
  })

  it("records a message the busy conversation could not take as failed", async () => {
    const { acquireSessionTurnLease } = await import("../../mind/session-transaction")
    const held = await acquireSessionTurnLease(sessionFile())
    try {
      await state.processActivity!(sdkActivity("The conversation is busy."))
    } finally { await held.release() }
    expect(state.run).not.toHaveBeenCalled()
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "failed", detail: "the conversation was busy finishing another turn" })])
  }, 20_000)

  it("notes a tool that messages a person before it runs, so a crash after it is never replayed", async () => {
    let during: unknown
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      callbacks.onToolStart("send_message", { friendId: "owner", channel: "teams", content: "the build is out" })
      callbacks.onToolDispatch?.("send_message")
      during = openTeamsInboundJournal(state.root).pending()
      messages.push({ role: "assistant", content: "Sent." })
      callbacks.onTextChunk("Sent.")
      return { outcome: "settled" }
    })
    await state.processActivity!(sdkActivity("Tell them the build is out."))
    expect(during).toEqual([expect.objectContaining({ spoke: true, spokeRecords: [expect.objectContaining({ kind: "tool:send_message" })] })])
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "answered" })])
  })

  it("records a slash command's reply as its answer", async () => {
    await state.processActivity!(sdkActivity("/commands"))
    expect(state.run).not.toHaveBeenCalled()
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "answered" })])
  })

  it("settles a message the running turn took in as steering with that turn", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let drained: unknown[] = []
    state.run.mockImplementationOnce(async (_messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      drained = options.drainSteeringFollowUps!()
      callbacks.onTextChunk("One answer for both.")
      return { outcome: "settled" }
    })
    const running = state.handlers.get("message")!(activity("hello"))
    await entered.promise
    await state.handlers.get("message")!(activity("one more thing"))
    release.resolve()
    await running
    expect(drained).toEqual([{ text: "one more thing", effect: "none" }])
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "answered" }), expect.objectContaining({ outcome: "answered" })])
  })

  it("settles a message a reaction turn took in as steering, so it is never replayed", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (_messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      options.drainSteeringFollowUps!()
      callbacks.onTextChunk("Noted.")
      return { outcome: "settled" }
    })
    const reaction = activity("")
    const running = state.handlers.get("messageReaction")!({ ...reaction, activity: { ...reaction.activity, reactionsAdded: [{ type: "like" }] } })
    await entered.promise
    await state.handlers.get("message")!(activity("and another thing"))
    release.resolve()
    await running
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "answered", attempts: 1 })])
  })

  it("records a message a reaction turn took in and answered with nothing as silent", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (_messages, _callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      entered.resolve()
      await release.promise
      options.drainSteeringFollowUps!()
      return { outcome: "settled" }
    })
    const reaction = activity("")
    const running = state.handlers.get("messageReaction")!({ ...reaction, activity: { ...reaction.activity, reactionsAdded: [{ type: "like" }] } })
    await entered.promise
    await state.handlers.get("message")!(activity("never mind"))
    release.resolve()
    await running
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "silent" })])
  })

  it("waits for a reply still in flight before recording the outcome", async () => {
    state.sdkSendDelayMs = 50
    state.run.mockImplementationOnce(async () => ({ outcome: "settled" }))
    await state.processActivity!(sdkActivity("Say nothing; the fallback reply is slow."))
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "answered" })])
  })

  it("answers a replayed message that only starts with a slash", async () => {
    const body = sdkActivity("/Users/ari/report.pdf what is in this?")
    const id = await leaveUnfinishedTurn(body)
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      messages.push({ role: "assistant", content: "A report." })
      callbacks.onTextChunk("A report.")
      return { outcome: "settled" }
    })
    await restart()
    await vi.waitFor(() => expect(readInboundOutcome(state.root, "teams", id)).toMatchObject({ outcome: "answered" }))
    expect(state.run).toHaveBeenCalledTimes(1)
  })

  it("records a turn whose only reply Teams never confirmed as failed", async () => {
    state.sdkLostAck = true
    state.sdkSendDelayMs = 50
    state.run.mockImplementationOnce(async () => ({ outcome: "settled" }))
    await state.processActivity!(sdkActivity("Say nothing, and the fallback send fails."))
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "failed", detail: "Teams confirmed no reply; failed sends: 1" })])
  })

  it("records a /new that fails while a turn holds the session as failed, and never replays it", async () => {
    const { acquireSessionTurnLease } = await import("../../mind/session-transaction")
    const held = await acquireSessionTurnLease(sessionFile())
    try {
      await expect(state.processActivity!(sdkActivity("/new"))).resolves.toBeDefined()
    } finally { await held.release() }
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
    expect(outcomeFiles()).toEqual([expect.objectContaining({ outcome: "failed", detail: expect.stringMatching(/^the turn failed: /) })])
  })

  it("records a command a dead process left as failed instead of running it as an ordinary turn", async () => {
    const id = await leaveUnfinishedTurn(sdkActivity("/new"))
    await restart()
    await vi.waitFor(() => expect(readInboundOutcome(state.root, "teams", id)).toMatchObject({
      outcome: "failed", detail: "a command is not run again after a restart",
    }))
    expect(state.run).not.toHaveBeenCalled()
    expect(state.sdkAcceptances).toEqual([])
  })

  it.skipIf(asRoot)("still answers an admitted message whose journal entry cannot be written", async () => {
    const pendingDir = path.join(state.root, "state", "senses", "teams", "pending-inbound")
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.chmodSync(pendingDir, 0o500)
    try {
      await state.processActivity!(sdkActivity("The disk is full."))
    } finally { fs.chmodSync(pendingDir, 0o700) }
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.sdkAcceptances).toHaveLength(1)
    expect(state.requestEvents).toContainEqual(expect.objectContaining({ level: "error", event: "senses.teams_inbound_record_failed" }))
    expect(openTeamsInboundJournal(state.root).pending()).toEqual([])
  })

  it("does not run a replayed message again once another turn recorded its outcome", async () => {
    const id = await leaveUnfinishedTurn(sdkActivity("Replay me only once."))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks) => {
      entered.resolve()
      await release.promise
      messages.push({ role: "assistant", content: "Done." })
      callbacks.onTextChunk("Done.")
      return { outcome: "settled" }
    })
    // A live turn in the same conversation runs first, so the replay waits behind it.
    const running = state.handlers.get("message")!(activity("a live message first"))
    await entered.promise
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    // Another process records the replayed message's outcome while the replay waits.
    openTeamsInboundJournal(state.root).settle(id, "answered", "answered elsewhere")
    release.resolve()
    await running
    await vi.waitFor(() => expect(outcomeFiles()).toHaveLength(2))
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(readInboundOutcome(state.root, "teams", id)).toMatchObject({ outcome: "answered", detail: "answered elsewhere" })
  })

  it("leaves a replayed message for a later start when another process is running a turn in its conversation", async () => {
    const id = await leaveUnfinishedTurn(sdkActivity("Another process is busy here."))
    const { acquireSessionTurnLease } = await import("../../mind/session-transaction")
    const held = await acquireSessionTurnLease(sessionFile())
    try {
      await restart()
      await vi.waitFor(() => expect(state.requestEvents).toContainEqual(expect.objectContaining({ event: "senses.teams_inbound_replay_deferred" })), { timeout: 15_000 })
    } finally { await held.release() }
    expect(state.run).not.toHaveBeenCalled()
    expect(state.sdkAcceptances).toEqual([])
    expect(openTeamsInboundJournal(state.root).get(id)).toMatchObject({ attempts: 1, spoke: false })
  }, 20_000)

  it("notes a sign-in before it can send the person a card", async () => {
    let during: unknown
    state.run.mockImplementationOnce(async (messages, callbacks: ChannelCallbacks, _channel, _signal, options: RunAgentOptions) => {
      await options.toolContext!.signin!("graph")
      during = openTeamsInboundJournal(state.root).pending()
      messages.push({ role: "assistant", content: "Signed in." })
      callbacks.onTextChunk("Signed in.")
      return { outcome: "settled" }
    })
    await state.processActivity!(sdkActivity("Check my calendar."))
    expect(during).toEqual([expect.objectContaining({ spoke: true, spokeRecords: [expect.objectContaining({ kind: "signin", textHash: null })] })])
  })
})
