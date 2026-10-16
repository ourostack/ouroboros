import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import type { RunAgentOptions, ChannelCallbacks } from "../../heart/core"
import { feedbackStorePath, openFeedbackStore } from "../../senses/shepherd/feedback-store"
import { loadSession } from "../../mind/context"
import { createOwnerNotifier } from "../../senses/shepherd/owner-notice"
import { readNoticeOutbox } from "../../senses/shepherd/notice-outbox"
import { appendReturn, type ReturnRecord } from "../../senses/shepherd/returns"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"

const state = vi.hoisted(() => ({
  root: "", handlers: new Map<string, (ctx: any) => Promise<void>>(), run: vi.fn(), handlerLogFailures: 0,
  refusalLogFailures: 0,
  requestEvents: [] as Array<{ event: string; meta?: Record<string, unknown> }>,
  processActivity: undefined as ((body: unknown) => Promise<unknown>) | undefined,
  sdkAcceptances: [] as Array<{ activityId: string; conversationId: string; outgoingId: string }>,
  sdkLostAck: false,
  sdkStreamLostAck: false,
}))
vi.mock("@microsoft/teams.apps", async original => {
  const actual = await original<typeof import("@microsoft/teams.apps")>()
  const client = { clone() { return this }, get: async () => ({ data: {} }), post: async () => ({ data: {} }), request: async () => ({ data: {} }) }
  return { ...actual, App: class extends actual.App {
    constructor(options: ConstructorParameters<typeof actual.App>[0]) {
      super({ ...options, client: client as never })
      const on = this.on.bind(this)
      this.on = (event: any, handler: any) => { state.handlers.set(event, handler); return on(event, handler) }
      this.getUserToken = async () => undefined
      this.activitySender = {
        createStream: (ref: { activityId: string; conversation: { id: string } }) => ({
          events: new EventEmitter(),
          emit() {
            if (state.sdkStreamLostAck) {
              state.sdkAcceptances.push({ activityId: ref.activityId, conversationId: ref.conversation.id, outgoingId: "sdk-stream-accepted" })
              return Promise.reject(new Error("fixture lost stream acknowledgement after acceptance"))
            }
            throw new Error("fixture rejected before transport")
          },
          update() {}, close: async () => undefined,
        }),
        send: async (value: unknown, ref: { activityId: string; conversation: { id: string } }) => {
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
  state.sdkStreamLostAck = false
  incomingSequence = 0
  state.run.mockReset().mockImplementation(async (messages, callbacks: ChannelCallbacks) => {
    messages.push({ role: "assistant", content: "Clarification recorded." })
    callbacks.onTextChunk("Clarification recorded.")
    return { outcome: "settled" }
  })
  await setup()
}, 60_000)

describe("actual Teams feedback adapter and leased pipeline", () => {
  it("holds an admission left before execution without claiming that it answered", async () => {
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

  it.each(["send", "stream"])("never resends after an uncertain SDK %s acceptance, including after restart", async transport => {
    state.sdkLostAck = transport === "send"
    state.sdkStreamLostAck = transport === "stream"
    const body = sdkActivity("Do this once even if the acknowledgement is lost.")
    await state.processActivity!(structuredClone(body))
    expect(state.sdkAcceptances).toHaveLength(1)
    vi.resetModules()
    const { startTeamsApp } = await import("../../senses/teams")
    startTeamsApp()
    state.sdkLostAck = false
    state.sdkStreamLostAck = false
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

  it("waits for the SDK stream promise instead of losing asynchronous delivery errors", async () => {
    const emitted = Promise.withResolvers<void>()
    const ctx = activity("Give me the short version.")
    ctx.stream.emit.mockImplementationOnce(() => emitted.promise)
    let complete = false
    const request = state.handlers.get("message")!(ctx).then(() => { complete = true })
    await vi.waitFor(() => expect(ctx.stream.emit).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setImmediate(resolve))
    expect(complete).toBe(false)
    emitted.resolve()
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
        expect.objectContaining({ friendId: "owner" }), expect.stringContaining("historical observations"),
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
      // A definite local rejection lets this fixture test the real SDK send adapter, not an uncertain resend.
      ctx.stream.emit.mockImplementationOnce(() => { throw new Error("fixture rejected before transport") })
      await state.handlers.get("message")!(ctx)
      expect(state.run).toHaveBeenCalledTimes(1)
      const options = state.run.mock.calls[0][4] as RunAgentOptions
      expect(options.toolContext?.currentUserMessage).toBe(request)
      expect(options.toolContext?.currentShepherdSurface).toBeUndefined()
      expect(ctx.send).toHaveBeenCalledTimes(1)
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
    expect(ctx.stream.emit.mock.calls.some(([value]) => JSON.stringify(value).includes(answer))).toBe(true)
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
    expect(ctx.stream.emit.mock.calls.some(([value]) => JSON.stringify(value).includes("Clarification recorded."))).toBe(true)
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
    expect(ctx.stream.emit).toHaveBeenCalled()
    expect(JSON.stringify(ctx.stream.emit.mock.calls)).not.toMatch(/Historical|Feedback for|Question about|33333333|44444444|\/historical/)
  })

  it.each([
    ["other-actor", "private-chat"],
    ["aad-owner", "other-chat"],
  ])("refuses a known archived bare quote before model/tools for actor %s in chat %s", async (actor, chat) => {
    const ctx = activity("Only this one, please.", "sent-a", actor, chat)
    await state.handlers.get("message")!(ctx)
    expect(state.run).not.toHaveBeenCalled()
    expect(ctx.stream.emit).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ctx.stream.emit.mock.calls)).toContain("feedback")
    expect(JSON.stringify(ctx.stream.emit.mock.calls)).not.toMatch(/Historical|Feedback for|Question about|33333333|44444444|\/historical|sent-a|owner|other-chat/)
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
    expect(JSON.stringify(second.stream.emit.mock.calls)).toContain("Clarification recorded.")
    expect(JSON.stringify(first.stream.emit.mock.calls)).not.toContain("Clarification recorded.")
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
    expect(JSON.stringify(tail.stream.emit.mock.calls)).toContain("Clarification recorded.")
    const later = activity("new independent clarification", "sent-a")
    await state.handlers.get("message")!(later)
    expect(state.run).toHaveBeenCalledTimes(4)
    expect(state.run.mock.calls[3][4].toolContext.currentShepherdSurface?.id).toBe(sourceA)
    expect(JSON.stringify(later.stream.emit.mock.calls)).toContain("Clarification recorded.")
  })
})
