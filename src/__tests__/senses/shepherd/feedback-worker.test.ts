import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { getChannelCapabilities, type FriendRecord } from "@ouro.bot/friends"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunSenseTurnOptions, RunSenseTurnResult } from "../../../senses/shared-turn"
import { feedbackStorePath, openFeedbackStore, type FeedbackInput, type FeedbackStore } from "../../../senses/shepherd/feedback-store"
import * as feedbackStorage from "../../../senses/shepherd/feedback-store"
import { feedbackReviewOptions, startFeedbackWorker, type FeedbackWorker, type FeedbackWorkerOptions } from "../../../senses/shepherd/feedback-worker"
import type { NoticeSender } from "../../../senses/shepherd/owner-notice"
import { selectToolsForChannel } from "../../../repertoire/tools"
import * as sharedTurn from "../../../senses/shared-turn"
import * as notices from "../../../senses/shepherd/owner-notice"

const stores: FeedbackStore[] = []
const workers: FeedbackWorker[] = []
afterEach(() => { for (const worker of workers.splice(0)) worker.stop(); for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })
const friend: FriendRecord = { id: "owner", name: "Owner", role: "friend", trustLevel: "family", connections: [],
  externalIds: [{ provider: "aad", externalId: "owner-aad", tenantId: "tenant", linkedAt: "2026-10-15" }],
  tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-10-15", updatedAt: "2026-10-15", schemaVersion: 1 }
const result = (response = "I recorded a session-only correction. Should that apply to this project too?"): RunSenseTurnResult => ({
  response, ponderDeferred: false, deliveries: [{ kind: "settle", text: response }], deliveryFailures: [], turnOutcome: "settled",
})
function setup(overrides: Partial<FeedbackInput> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-feedback-worker-"))
  fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: "Orchid One" }))
  const store = openFeedbackStore(feedbackStorePath(root))
  stores.push(store)
  const record = store.submit({
    id: `feedback:${randomUUID()}`, actorId: "owner", agent: "orchid", bodyHash: "a".repeat(64), createdAt: "2026-10-15T20:00:00.000Z",
    source: { id: "11111111-1111-4111-8111-111111111111", host: "cmux", label: "Copilot / implement task",
      tty: "/dev/ttys001", cwd: "/project", task: null },
    packet: { feedback: "You should have caught this.", context: "The plan is not the deliverable.", screen: "Plan written. Proceed?", previousReturn: null },
    recipient: { friendId: "owner", aadObjectId: "owner-aad", tenantId: "tenant" }, receipt: "Orchid One: received.",
    ...overrides,
  })
  let now = 0
  const schedules: Array<{ fn: () => void; ms: number }> = []
  const calls: RunSenseTurnOptions[] = []
  const sends: Array<{ friendId: string; text: string }> = []
  const defaults = {
    agent: "orchid", agentRoot: root, now: () => now,
    schedule: (fn: () => void, ms: number) => { const entry = { fn, ms }; schedules.push(entry); return () => {
      const index = schedules.indexOf(entry); if (index >= 0) schedules.splice(index, 1)
    } },
    friendStore: { get: async () => friend },
    run: async (options: RunSenseTurnOptions) => {
      calls.push(options)
      expect(store.read(record.id, "owner")?.review.state).toBe("claimed")
      return result()
    },
    send: (async (target, text) => {
      expect(store.read(record.id, "owner")).toMatchObject({ review: { state: "complete" }, delivery: { state: "unknown" } })
      expect(target.friendId).toBe("owner")
      sends.push({ friendId: target.friendId, text })
      return { delivered: true, delivery: { state: "accepted", conversationId: "private-chat", messageId: "activity-1" } }
    }) satisfies NoticeSender,
  }
  function start(overrides: Partial<FeedbackWorkerOptions> = {}) {
    const worker = startFeedbackWorker({ ...defaults, ...overrides })
    workers.push(worker)
    return worker
  }
  return { root, store, record, calls, sends, schedules, start, advance: () => { now += 60_000 } }
}

describe("managed feedback review and owner acknowledgement", () => {
  it("uses the normal default turn/recipient/sender factories in this existing agent process", async () => {
    const fixture = setup()
    fs.mkdirSync(path.join(fixture.root, "friends"))
    fs.writeFileSync(path.join(fixture.root, "friends", "owner.json"), JSON.stringify(friend))
    vi.spyOn(sharedTurn, "runSenseTurn").mockImplementation(async options => {
      expect(options.shepherdSession?.id).toBe(fixture.record.source.id)
      return result("I saved the scoped feedback.")
    })
    vi.spyOn(notices, "createNoticeSender").mockReturnValue(async (target, text, noticeIds) => {
      expect(target).toMatchObject({ friendId: "owner", channel: "teams" })
      expect(noticeIds).toEqual([fixture.record.id])
      expect(text).toContain("I saved the scoped feedback.")
      return { delivered: true, delivery: { state: "accepted", conversationId: "default-chat", messageId: "default-activity" } }
    })
    await fixture.start({ run: undefined, send: undefined, friendStore: undefined }).drain()
    expect(fixture.store.findReply("owner", "default-chat", "default-activity")?.id).toBe(fixture.record.id)
  })

  it("drains from the managed scheduler without creating a feedback store when no request exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "empty-feedback-worker-"))
    const worker = startFeedbackWorker({ agent: "orchid", agentRoot: root, schedule: () => () => {}, now: Date.now })
    workers.push(worker)
    await worker.drain()
    expect(fs.existsSync(feedbackStorePath(root))).toBe(false)
    worker.stop()
    await worker.drain()
    const fixture = setup()
    fixture.start()
    fixture.schedules.shift()!.fn()
    await vi.waitFor(() => expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("sent"))
    expect(fixture.sends).toHaveLength(1)
  })

  it("advertises only guidance/read tools and the final settle engine, not implicit background work", async () => {
    const fixture = setup()
    const options = feedbackReviewOptions(fixture.record, new AbortController().signal)
    const channel = getChannelCapabilities("mcp")
    const resolvedContext = { friend, channel }
    const prepared = await options.prepareRunAgentOptions!({
      messages: [], currentUserMessages: [], resolvedContext, runAgentOptions: {},
      activeCares: [], careEvidenceNow: 0,
    })
    if (!prepared) throw new Error("feedback review omitted its policy")
    expect(prepared.tools?.map(tool => tool.function.name)).toEqual([
      "shepherd_read", "shepherd_history", "shepherd_correct", "shepherd_guidance",
    ])
    const menu = selectToolsForChannel(channel, undefined, resolvedContext, undefined, undefined, undefined, prepared.toolContext)
    expect(menu.engine.map(tool => tool.function.name)).toEqual(["settle"])
    const constrained = selectToolsForChannel(channel, undefined, resolvedContext, undefined, undefined, undefined,
      { ...prepared.toolContext, allowedEngineTools: ["settle", "shell", "nonexistent"] })
    expect(constrained.engine.map(tool => tool.function.name)).toEqual(["settle"])
    await expect(prepared.toolContext!.signin("not-an-authorized-signin")).resolves.toBeUndefined()
  })

  it("runs the real bound review contract and persists it before one private Teams follow-up", async () => {
    const fixture = setup()
    await fixture.start().drain()
    expect(fixture.calls).toHaveLength(1)
    const options = fixture.calls[0]!
    expect(options).toMatchObject({ agentName: "orchid", friendId: "owner", channel: "mcp",
      userMessage: "You should have caught this.", shepherdSession: { id: fixture.record.source.id } })
    expect(JSON.stringify(options.orientationFrame)).toContain("The plan is not the deliverable.")
    expect(JSON.stringify(options.orientationFrame)).toContain("no recorded judgment")
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0]!.text).toContain("Orchid One")
    expect(fixture.sends[0]!.text).toContain("session-only correction")
    expect(fixture.sends[0]!.text).toContain("Should that apply")
    expect(fixture.store.findReply("owner", "private-chat", "activity-1")?.id).toBe(fixture.record.id)
    await fixture.start().drain()
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.sends).toHaveLength(1)
  })

  it("prevents two worker instances from reviewing the same feedback concurrently", async () => {
    const fixture = setup()
    const gate = Promise.withResolvers<RunSenseTurnResult>()
    let runs = 0
    const first = fixture.start({ run: async () => { runs++; return gate.promise } })
    const running = first.drain()
    await new Promise(resolve => setImmediate(resolve))
    await fixture.start().drain()
    expect(runs).toBe(1)
    expect(fixture.calls).toEqual([])
    gate.resolve(result())
    await running
    expect(fixture.sends).toHaveLength(1)
  })

  it("reports uncertain model handling honestly rather than retrying possible guidance effects", async () => {
    const fixture = setup()
    let runs = 0
    const worker = fixture.start({
      run: async () => { runs++; throw new Error("provider connection lost after a possible tool effect") },
      send: async (_target, text) => {
        expect(text).toContain("could not confirm")
        expect(text).not.toContain("I recorded a session-only correction")
        return { delivered: true, delivery: { state: "accepted", conversationId: "chat", messageId: "failed-review" } }
      },
    })
    await worker.drain()
    await worker.drain()
    expect(runs).toBe(1)
    expect(fixture.store.read(fixture.record.id, "owner")).toMatchObject({ review: { state: "uncertain" }, delivery: { state: "sent" } })
  })

  it("never replays unknown Teams acceptance, but retries a definite not-sent outcome without another model", async () => {
    const fixture = setup()
    let sends = 0
    const worker = fixture.start({ send: async () => {
      sends++
      return sends === 1 ? { delivered: false, delivery: { state: "not_sent" } }
        : { delivered: false, delivery: { state: "unknown" } }
    } })
    await worker.drain()
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("pending")
    await worker.drain()
    expect(sends).toBe(1)
    fixture.advance()
    await worker.drain()
    expect(sends).toBe(2)
    await fixture.start({ send: async () => { throw new Error("must not replay") } }).drain()
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("unknown")
  })

  it("does not send to a changed or different family Teams route", async () => {
    const fixture = setup()
    let sends = 0
    await fixture.start({
      friendStore: { get: async () => ({ ...friend, externalIds: [{ provider: "aad", externalId: "other-aad", tenantId: "tenant", linkedAt: "2026-10-15" }] }) },
      send: async () => { sends++; throw new Error("wrong route") },
    }).drain()
    expect(sends).toBe(0)
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).not.toBe("sent")
  })

  it("refuses a revoked actor at the final pre-provider boundary", async () => {
    const fixture = setup()
    const options = feedbackReviewOptions(fixture.record, new AbortController().signal)
    const context = { friend: { ...friend, admissionState: "revoked" as const }, channel: getChannelCapabilities("mcp") }
    expect(() => options.prepareRunAgentOptions!({ messages: [], currentUserMessages: [], activeCares: [], careEvidenceNow: 0,
      resolvedContext: context, runAgentOptions: {} })).toThrow("authority")
    await fixture.start({ friendStore: { get: async () => ({ ...friend, trustLevel: "stranger" as const }) } }).drain()
    expect(fixture.calls).toEqual([])
    expect(fixture.sends).toEqual([])
    expect(fixture.store.read(fixture.record.id, "owner")?.review.state).toBe("uncertain")
  })

  it.each([
    { outcome: "errored" as const, response: "An unconfirmed partial answer." },
    { outcome: "settled" as const, response: "" },
  ])("does not promote an incomplete agent result to confirmed learning: $outcome", async ({ outcome, response }) => {
    const fixture = setup()
    await fixture.start({ run: async () => ({ ...result(response), turnOutcome: outcome }),
      send: async () => ({ delivered: false, reason: "no configured bot" }) }).drain()
    expect(fixture.store.read(fixture.record.id, "owner")).toMatchObject({
      review: { state: "uncertain" }, delivery: { state: "pending", reason: "no configured bot" },
    })
  })

  it.each([
    { delivered: true },
    { delivered: true, delivery: { state: "accepted" as const } },
    { delivered: false, delivery: { state: "unknown" as const }, reason: "result unknown" },
  ])("preserves unknown acceptance without retry or made-up message IDs: %j", async delivery => {
    const fixture = setup()
    const worker = fixture.start({ send: async () => delivery })
    await worker.drain()
    fixture.advance()
    await worker.drain()
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("unknown")
    expect(fixture.calls).toHaveLength(1)
  })

  it("does not claim delivery from a contradictory transport result", async () => {
    const fixture = setup()
    await fixture.start({ send: async () => ({ delivered: false,
      delivery: { state: "accepted", conversationId: "chat", messageId: "contradictory" } }) }).drain()
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("unknown")
  })

  it("does not retry a throwing Teams send or start a second model turn", async () => {
    const fixture = setup()
    let attempted = 0
    const worker = fixture.start({ send: async () => { attempted++; throw new Error("connection ended after submit") } })
    await Promise.all([worker.drain(), worker.drain()])
    fixture.advance()
    await worker.drain()
    expect(attempted).toBe(1)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("unknown")
  })

  it("stops its scheduler and never starts Teams transport after stopping during a model turn", async () => {
    const fixture = setup()
    const gate = Promise.withResolvers<RunSenseTurnResult>()
    const worker = fixture.start({ run: async () => gate.promise })
    const running = worker.drain()
    await new Promise(resolve => setImmediate(resolve))
    worker.stop()
    gate.resolve(result())
    await running
    expect(fixture.sends).toEqual([])
    expect(fixture.schedules).toEqual([])
  })

  it.each(["review", "delivery"])("honors a concurrent %s claim acquired after its pending snapshot", async phase => {
    const fixture = setup()
    if (phase === "delivery") {
      fixture.store.claimReview(fixture.record.id, "owner", "previous")
      fixture.store.completeReview(fixture.record.id, "owner", "previous", "Already reviewed.")
    }
    const nativeOpen = feedbackStorage.openFeedbackStore
    vi.spyOn(feedbackStorage, "openFeedbackStore").mockImplementation(file => {
      const store = nativeOpen(file)
      return { ...store,
        pending() {
          const snapshot = store.pending()
          if (phase === "review") fixture.store.claimReview(fixture.record.id, "owner", "concurrent")
          return snapshot
        },
        claimDelivery(id, actor, owner) {
          fixture.store.claimDelivery(id, actor, "concurrent-sender")
          return store.claimDelivery(id, actor, owner)
        },
      }
    })
    await fixture.start().drain()
    expect(fixture.calls).toEqual([])
    expect(fixture.sends).toEqual([])
    expect(fixture.store.read(fixture.record.id, "owner")).toMatchObject(phase === "review"
      ? { review: { state: "claimed", owner: "concurrent" } }
      : { delivery: { state: "unknown", owner: "concurrent-sender" } })
  })

  it("does not begin model work after shutdown while owner authority lookup was pending", async () => {
    const fixture = setup()
    const gate = Promise.withResolvers<FriendRecord | null>()
    const worker = fixture.start({ friendStore: { get: async () => gate.promise } })
    const running = worker.drain()
    await new Promise(resolve => setImmediate(resolve))
    worker.stop()
    gate.resolve(friend)
    await running
    expect(fixture.calls).toEqual([])
    expect(fixture.sends).toEqual([])
    expect(fixture.store.read(fixture.record.id, "owner")?.review.state).toBe("uncertain")
  })

  it("does not initiate delivery after shutdown while its final Teams route check was pending", async () => {
    const fixture = setup()
    const gate = Promise.withResolvers<FriendRecord | null>()
    let reads = 0
    const worker = fixture.start({ friendStore: { get: async () => ++reads === 2 ? gate.promise : friend } })
    const running = worker.drain()
    await vi.waitFor(() => expect(reads).toBe(2))
    worker.stop()
    gate.resolve(friend)
    await running
    expect(fixture.sends).toEqual([])
    expect(fixture.store.read(fixture.record.id, "owner")?.delivery.state).toBe("pending")
  })

  it("keeps a malformed foreign-agent queue pending instead of executing it in this agent's process", async () => {
    const fixture = setup({ agent: "different-agent" })
    fixture.start()
    fixture.schedules.shift()!.fn()
    await vi.waitFor(() => expect(fixture.schedules.length).toBe(1))
    expect(fixture.calls).toEqual([])
    expect(fixture.sends).toEqual([])
    expect(fixture.store.read(fixture.record.id, "owner")?.review.state).toBe("pending")
  })

  it("leaves later queued requests untouched when shutdown occurs after one completed acknowledgement", async () => {
    const fixture = setup()
    const second = fixture.store.submit({ ...fixture.record, id: `feedback:${randomUUID()}` })
    let worker: FeedbackWorker
    worker = fixture.start({ send: async () => {
      worker.stop()
      return { delivered: true, delivery: { state: "accepted", conversationId: "chat", messageId: "one" } }
    } })
    await worker.drain()
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.store.read(second.id, "owner")?.review.state).toBe("pending")
  })

  it("uses the primary private Teams route when that existing actor has no tenant-specific binding", async () => {
    const fixture = setup({ recipient: { friendId: "owner", aadObjectId: "owner-aad", tenantId: null } })
    await fixture.start({
      friendStore: { get: async () => ({ ...friend, externalIds: [{ provider: "aad", externalId: "owner-aad", linkedAt: "2026-10-15" }] }) },
      send: async target => {
        expect(target.tenantId).toBeUndefined()
        return { delivered: true, delivery: { state: "accepted", conversationId: "primary-chat", messageId: "primary" } }
      },
    }).drain()
    expect(fixture.store.findReply("owner", "primary-chat", "primary")?.id).toBe(fixture.record.id)
  })
})
