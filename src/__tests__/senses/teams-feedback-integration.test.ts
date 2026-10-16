import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import type { RunAgentOptions, ChannelCallbacks } from "../../heart/core"
import { feedbackStorePath, openFeedbackStore } from "../../senses/shepherd/feedback-store"
import { loadSession } from "../../mind/context"

const state = vi.hoisted(() => ({
  root: "", handlers: new Map<string, (ctx: any) => Promise<void>>(), run: vi.fn(),
}))
vi.mock("@microsoft/teams.apps", () => ({
  App: class {
    on(event: string, handler: (ctx: any) => Promise<void>) { state.handlers.set(event, handler) }
    event() {}
    start() {}
  },
}))
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
    if (event.event === "channel.handler_error" || event.event === "channel.feedback_handler_error") console.error(event)
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

function activity(text: string, replyToId?: string, aad = "aad-owner", conversation = "private-chat") {
  return {
    stream: { emit: vi.fn(), update: vi.fn(), close: vi.fn() },
    activity: { id: "incoming", text, replyToId, conversation: { id: conversation, tenantId: "tenant" },
      from: { id: aad, aadObjectId: aad, name: aad }, channelId: "msteams" },
    api: { users: { token: { get: vi.fn().mockResolvedValue(undefined) } } },
    signin: vi.fn(), send: vi.fn().mockResolvedValue({ id: "outgoing" }),
  }
}

beforeEach(async () => {
  vi.resetModules()
  state.handlers.clear()
  state.run.mockReset().mockImplementation(async (messages, callbacks: ChannelCallbacks) => {
    messages.push({ role: "assistant", content: "Clarification recorded." })
    callbacks.onTextChunk("Clarification recorded.")
    return { outcome: "settled" }
  })
  await setup()
}, 60_000)

describe("actual Teams feedback adapter and leased pipeline", () => {
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
})
