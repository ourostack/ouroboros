import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startFakeRelay, type FakeRelay } from "../test-helpers/fake-relay"
import {
  RELAY_MAX_BACKOFF_MS,
  RELAY_MAX_PER_TICK,
  drainRelayInbox,
  ensureRelayRegistration,
  rebuildRelayedMessage,
  retirePreviousRegistrations,
  memoryRelayRetirements,
  startRelayInbox,
  type RelayConfig,
  type RelayConfigStore,
  type RelayRegistration,
} from "../../a2a/relay-inbox"
import { receiveRefusalError } from "../../a2a/refusals"
import { MAX_ENVELOPE_AGE_MS } from "../../a2a/seen-ledger"
import type { A2AJsonRpcRequest, A2AJsonRpcResponse } from "../../a2a/types"

/** An in-memory `a2a.relay`, with the vault merge's semantics: a patch merges, and an `undefined` value removes a key. */
function memoryConfig(initial: RelayConfig = {}): RelayConfigStore & { value: RelayConfig; writes: number; failWrites: number; onRead?: () => void } {
  const store = {
    value: { ...initial } as RelayConfig,
    writes: 0,
    failWrites: 0,
    onRead: undefined as (() => void) | undefined,
    async read() {
      store.onRead?.()
      return JSON.parse(JSON.stringify(store.value)) as RelayConfig
    },
    async write(patch: Record<string, unknown>) {
      if (store.failWrites > 0) {
        store.failWrites -= 1
        throw new Error("vault locked")
      }
      store.writes += 1
      store.value = JSON.parse(JSON.stringify({ ...store.value, ...patch })) as RelayConfig
    },
  }
  return store
}

const DID = "did:key:zMe"
const sealedMessage = (id: string, nonce = `n-${id}`) => ({
  messageId: id,
  role: "agent",
  contextId: "relay-chosen",
  metadata: { senderName: "spoofed" },
  parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: nonce, ct: "c" }, recipientDid: DID } }],
})
const ok = (id: unknown): A2AJsonRpcResponse => ({ jsonrpc: "2.0", id: id as string, result: { id: "task" } })
/** The refusal the server sends (src/a2a/refusals.ts), so the retry flag the inbox reads is the real one. */
const refused = (id: unknown, what: string, reason: string): A2AJsonRpcResponse => {
  const refusal = receiveRefusalError(what, reason)
  return { jsonrpc: "2.0", id: id as string, error: { code: -32003, message: refusal.message, data: refusal.data } }
}

let relay: FakeRelay
beforeEach(async () => { relay = await startFakeRelay() })
afterEach(async () => { await relay.close() })

function registered(handle = "h1"): RelayRegistration {
  relay.registrations.set(handle, { did: DID, inboxAuth: "ia", sendCredential: "sc", agentCard: {} })
  relay.inbox.set(handle, [])
  return { relayUrl: relay.url, handle, inboxAuth: "ia", sendCredential: "sc" }
}
function enqueue(handle: string, message: unknown, queueId = `q-${relay.inbox.get(handle)!.length}-${Math.random()}`) {
  relay.inbox.get(handle)!.push({ queueId, message })
  return queueId
}

describe("ensureRelayRegistration", () => {
  it("does nothing without a relay url", async () => {
    const config = memoryConfig()
    expect(await ensureRelayRegistration({ config, did: DID, agentName: "me" })).toBeNull()
    expect(config.writes).toBe(0)
  })

  it("registers a random 128-bit handle with a minimal card, records it, and clears the used invite", async () => {
    const config = memoryConfig({ url: relay.url, inviteToken: "inv" })
    const registration = await ensureRelayRegistration({ config, did: DID, agentName: "me" })
    expect(registration).toEqual({ relayUrl: relay.url, handle: expect.stringMatching(/^[0-9a-f]{32}$/), inboxAuth: "ia-1", sendCredential: "sc-1" })
    expect(config.value).toEqual({ url: relay.url, registration })
    const body = relay.requests[0].body as Record<string, unknown>
    expect(body).toEqual({ handle: registration!.handle, did: DID, agentCard: { name: "me", did: DID }, inviteToken: "inv" })
  })

  it("keeps an existing registration and does not call the relay", async () => {
    const registration = { relayUrl: relay.url, handle: "h", inboxAuth: "ia", sendCredential: "sc" }
    const config = memoryConfig({ url: relay.url, registration })
    expect(await ensureRelayRegistration({ config, did: DID, agentName: "me" })).toEqual(registration)
    expect(relay.requests).toHaveLength(0)
  })

  it("rotates credentials on the same handle when an invite token is present", async () => {
    const config = memoryConfig({ url: relay.url, inviteToken: "rotate", registration: { relayUrl: relay.url, handle: "h", inboxAuth: "old", sendCredential: "old" } })
    expect(await ensureRelayRegistration({ config, did: DID, agentName: "me" })).toEqual({ relayUrl: relay.url, handle: "h", inboxAuth: "ia-1", sendCredential: "sc-1" })
    expect(config.value.inviteToken).toBeUndefined()
    expect(config.value.previousRegistrations).toBeUndefined()
  })

  it("keeps an invite token the operator set while registration was running", async () => {
    const config = memoryConfig({ url: relay.url, inviteToken: "first" })
    let reads = 0
    config.onRead = () => { reads += 1; if (reads === 2) config.value.inviteToken = "second" }
    await ensureRelayRegistration({ config, did: DID, agentName: "me" })
    expect(config.value.inviteToken).toBe("second")
  })

  it("reuses the pending handle after a failed attempt and moves an old relay's registration aside", async () => {
    const old = { relayUrl: "https://old.example", handle: "old-h", inboxAuth: "old-ia", sendCredential: "old-sc" }
    const config = memoryConfig({ url: relay.url, inviteToken: "inv", registration: old })
    relay.failNext("register", 403, "bad_invite")
    expect(await ensureRelayRegistration({ config, did: DID, agentName: "me" })).toEqual(old)
    expect(config.value.registration).toEqual(old)
    const pending = config.value.pendingRegistration!
    expect(pending.relayUrl).toBe(relay.url)
    const registration = await ensureRelayRegistration({ config, did: DID, agentName: "me" })
    expect(registration?.handle).toBe(pending.handle)
    expect(config.value).toEqual({ url: relay.url, registration, previousRegistrations: [old] })
  })

  it("moves even while older relays are still being retired: the one it leaves joins the list, once", async () => {
    const current = { relayUrl: "https://b.example", handle: "b-h", inboxAuth: "b-ia", sendCredential: "b-sc" }
    const older = { relayUrl: "https://a.example", handle: "a-h", inboxAuth: "a-ia", sendCredential: "a-sc" }
    const config = memoryConfig({ url: relay.url, inviteToken: "inv", registration: current, previousRegistrations: [older, current] })
    const registration = await ensureRelayRegistration({ config, did: DID, agentName: "me" })
    expect(registration?.relayUrl).toBe(relay.url)
    expect(config.value).toEqual({ url: relay.url, registration, previousRegistrations: [older, current] })
  })

  it("returns null when a first registration fails", async () => {
    const config = memoryConfig({ url: relay.url })
    relay.failNext("register", 503, "busy")
    expect(await ensureRelayRegistration({ config, did: DID, agentName: "me" })).toBeNull()
  })

  it("still registers when the vault cannot record the pending handle, and keeps the credentials in memory when it cannot save them", async () => {
    const config = memoryConfig({ url: relay.url })
    config.failWrites = 2
    const registration = await ensureRelayRegistration({ config, did: DID, agentName: "me" })
    expect(registration).toMatchObject({ relayUrl: relay.url, inboxAuth: "ia-1" })
    expect(config.value.registration).toBeUndefined()
  })
})

describe("rebuildRelayedMessage", () => {
  it("keeps only the message id and the single data part", () => {
    expect(rebuildRelayedMessage(sealedMessage("m1"))).toEqual({
      message: { kind: "message", role: "agent", messageId: "m1", parts: [sealedMessage("m1").parts[0]] },
      nonce: "n-m1",
    })
    expect(rebuildRelayedMessage({ messageId: "m", parts: [{ kind: "data", data: { sealed: {} } }] })).toEqual({ message: expect.objectContaining({ messageId: "m" }) })
  })

  it("refuses anything that is not exactly one data part", () => {
    for (const bad of [null, "x", { parts: [] }, { messageId: 1, parts: [] }, { messageId: "m" }, { messageId: "m", parts: [] },
      { messageId: "m", parts: [{ kind: "text", text: "hi" }] }, { messageId: "m", parts: [null] }, { messageId: "m", parts: [{ kind: "data" }] },
      { messageId: "m", parts: [{ kind: "data", data: {} }, { kind: "data", data: {} }] }]) {
      expect(rebuildRelayedMessage(bad)).toBeNull()
    }
  })
})

describe("drainRelayInbox", () => {
  it("runs each queued message through the handler as message/send and acks it", async () => {
    const registration = registered()
    enqueue("h1", sealedMessage("m1"))
    enqueue("h1", sealedMessage("m2"))
    const seen: A2AJsonRpcRequest[] = []
    expect(await drainRelayInbox({ registration, seen: () => false, handle: async (rpc) => { seen.push(rpc); return ok(rpc.id) } })).toBe("ok")
    expect(seen.map((rpc) => [rpc.method, (rpc.params as { message: { messageId: string; contextId?: string } }).message.messageId])).toEqual([["message/send", "m1"], ["message/send", "m2"]])
    expect((seen[0].params as { message: Record<string, unknown> }).message).not.toHaveProperty("contextId")
    expect(relay.inbox.get("h1")).toEqual([])
  })

  it("acks final refusals, keeps retryable ones, and drops malformed messages", async () => {
    const registration = registered()
    enqueue("h1", sealedMessage("replayed"))
    enqueue("h1", sealedMessage("resolve"))
    const keep = enqueue("h1", sealedMessage("inflight"))
    enqueue("h1", { messageId: "text", parts: [{ kind: "text", text: "plaintext" }] })
    const handled: string[] = []
    const result = await drainRelayInbox({
      registration,
      seen: () => false,
      handle: async (rpc) => {
        const id = (rpc.params as { message: { messageId: string } }).message.messageId
        handled.push(id)
        if (id === "replayed") return refused(rpc.id, "share", "replayed")
        if (id === "resolve") return refused(rpc.id, "share", "resolve_failed")
        return refused(rpc.id, "result", "in_flight")
      },
    })
    expect(result).toBe("ok")
    expect(handled).toEqual(["replayed", "resolve", "inflight"])
    expect(relay.inbox.get("h1")!.map((m) => m.queueId)).toEqual([keep])
  })

  it("keeps only refusals.ts refusals marked retry: a refused delegated command or a look-alike is acked, not kept", async () => {
    const registration = registered()
    enqueue("h1", sealedMessage("delegated"))
    enqueue("h1", sealedMessage("lookalike"))
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    const handled: string[] = []
    const handle = async (rpc: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse> => {
      const id = (rpc.params as { message: { messageId: string } }).message.messageId
      handled.push(id)
      if (id === "delegated") {
        // What server.ts sends for a delegated command the owner could not be told about (delegated-command.ts notify_failed).
        return { jsonrpc: "2.0", id: rpc.id, error: { code: -32004, message: "delegated command refused: notify_failed. Nothing ran.", data: { reason: "notify_failed", nothingRan: true, retry: true, next: "Retry in a minute." } } }
      }
      return { jsonrpc: "2.0", id: rpc.id, error: { code: -32003, message: "A2A share rejected: in_flight", data: { reason: "in_flight", retry: true, next: "Retry in a moment." } } }
    }
    expect(await drainRelayInbox({ registration, seen: () => false, handle })).toBe("ok")
    expect(relay.inbox.get("h1")).toEqual([])
    // Nothing was kept, so the next pass has nothing to replay.
    expect(await drainRelayInbox({ registration, seen: () => false, handle })).toBe("ok")
    expect(handled).toEqual(["delegated", "lookalike"])
    const events = nerves.mock.calls.map(([event]) => event.event)
    expect(events).not.toContain("channel.a2a_relay_message_deferred")
    nerves.mockRestore()
  })

  it("handles at most 20 messages per pass", async () => {
    const registration = registered()
    for (let i = 0; i < RELAY_MAX_PER_TICK + 3; i += 1) enqueue("h1", sealedMessage(`m${i}`))
    let calls = 0
    await drainRelayInbox({ registration, seen: () => false, handle: async (rpc) => { calls += 1; return ok(rpc.id) } })
    expect(calls).toBe(RELAY_MAX_PER_TICK)
    expect(relay.inbox.get("h1")).toHaveLength(3)
  })

  it("after a throw, acks only a message friends already verified, and ends the pass", async () => {
    const registration = registered()
    enqueue("h1", sealedMessage("verified", "nonce-v"))
    const after = enqueue("h1", sealedMessage("later"))
    const throwing = async () => { throw new Error("provider down") }
    expect(await drainRelayInbox({ registration, seen: (n) => n === "nonce-v", handle: throwing })).toBe("backoff")
    expect(relay.inbox.get("h1")!.map((m) => m.queueId)).toEqual([after])

    const unverified = enqueue("h1", sealedMessage("unverified"))
    relay.inbox.set("h1", relay.inbox.get("h1")!.reverse())
    expect(await drainRelayInbox({ registration, seen: () => false, handle: throwing })).toBe("backoff")
    expect(relay.inbox.get("h1")!.map((m) => m.queueId).sort()).toEqual([after, unverified].sort())

    relay.inbox.set("h1", [{ queueId: "no-nonce", message: { messageId: "x", parts: [{ kind: "data", data: { v: 1 } }] } }])
    expect(await drainRelayInbox({ registration, seen: () => true, handle: throwing })).toBe("backoff")
    expect(relay.inbox.get("h1")).toHaveLength(1)
  })

  it("stops on a 401 and backs off on other pull or ack failures", async () => {
    const registration = registered()
    expect(await drainRelayInbox({ registration: { ...registration, inboxAuth: "wrong" }, seen: () => false, handle: async (rpc) => ok(rpc.id) })).toBe("stop")
    relay.failNext("pull", 503, "busy")
    expect(await drainRelayInbox({ registration, seen: () => false, handle: async (rpc) => ok(rpc.id) })).toBe("backoff")
    enqueue("h1", sealedMessage("m1"))
    relay.failNext("ack", 500)
    expect(await drainRelayInbox({ registration, seen: () => false, handle: async (rpc) => ok(rpc.id) })).toBe("backoff")
  })
})

describe("retirePreviousRegistrations", () => {
  it("drains the old relay, deregisters it and forgets it", async () => {
    const previous = registered("old")
    enqueue("old", sealedMessage("left-behind"))
    const config = memoryConfig({ previousRegistrations: [previous] })
    const handled: string[] = []
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => { handled.push((rpc.params as { message: { messageId: string } }).message.messageId); return ok(rpc.id) } })).toBe("retired")
    expect(handled).toEqual(["left-behind"])
    expect(relay.registrations.has("old")).toBe(false)
    expect(config.value).toEqual({})
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => ok(rpc.id) })).toBe("none")
  })

  it("drains more than one pass before deregistering, so nothing queued is deleted", async () => {
    const previous = registered("old")
    for (let i = 0; i < RELAY_MAX_PER_TICK + 5; i += 1) enqueue("old", sealedMessage(`m${i}`))
    const config = memoryConfig({ previousRegistrations: [previous] })
    let handled = 0
    await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => { handled += 1; return ok(rpc.id) } })
    expect(handled).toBe(RELAY_MAX_PER_TICK + 5)
    expect(relay.registrations.has("old")).toBe(false)
    expect(config.value).toEqual({})
  })

  it("keeps the old registration while it holds messages refused for now", async () => {
    const previous = registered("old")
    const kept = enqueue("old", sealedMessage("busy"))
    const config = memoryConfig({ previousRegistrations: [previous] })
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => refused(rpc.id, "result", "in_flight") })).toBe("kept")
    expect(relay.inbox.get("old")!.map((m) => m.queueId)).toEqual([kept])
    expect(relay.registrations.has("old")).toBe(true)
    expect(config.value.previousRegistrations).toEqual([previous])
  })

  it("keeps the old registration when a drain pass fails", async () => {
    const previous = registered("old")
    enqueue("old", sealedMessage("throws"))
    const config = memoryConfig({ previousRegistrations: [previous] })
    await retirePreviousRegistrations({ config, seen: () => false, handle: async () => { throw new Error("provider down") } })
    expect(relay.registrations.has("old")).toBe(true)
    expect(config.value.previousRegistrations).toEqual([previous])
  })

  it("keeps the old registration when the drain or the deregistration fails", async () => {
    const previous = registered("old")
    const config = memoryConfig({ previousRegistrations: [previous] })
    relay.failNext("pull", 503)
    await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => ok(rpc.id) })
    relay.failNext("deregister", 500)
    await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => ok(rpc.id) })
    expect(config.value.previousRegistrations).toEqual([previous])
  })

  it("retires each previous registration on its own and keeps only the ones still waiting", async () => {
    const drained = registered("drained")
    const busy = registered("busy")
    enqueue("busy", sealedMessage("busy"))
    const forgotten = { relayUrl: relay.url, handle: "forgotten", inboxAuth: "ia", sendCredential: "sc" }
    const config = memoryConfig({ previousRegistrations: [drained, busy, forgotten] })
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => refused(rpc.id, "result", "in_flight") })).toBe("kept")
    expect(config.value.previousRegistrations).toEqual([busy])
  })
})

describe("retirePreviousRegistrations when the old relay is gone", () => {
  const ok2 = async (rpc: A2AJsonRpcRequest) => ok(rpc.id)
  const DAY = 24 * 60 * 60 * 1000
  async function closedUrl(): Promise<string> {
    const http = await import("node:http")
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as import("node:net").AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return `http://127.0.0.1:${port}`
  }
  function notices() {
    const sent: Array<{ noticeId: string; text: string }> = []
    return { sent, notifyOwner: async (notice: { noticeId: string; text: string }) => { sent.push(notice) } }
  }
  const failingFetch = (error: () => unknown) => (async () => { throw error() }) as unknown as typeof fetch
  const refusedConnection = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) })

  it("retires at once a registration the relay itself says it does not know (its JSON 401 or 404), without claiming messages were lost", async () => {
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    const forgotten = { relayUrl: relay.url, handle: "forgotten", inboxAuth: "ia", sendCredential: "sc" }
    const config = memoryConfig({ previousRegistrations: [forgotten] })
    const owner = notices()
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, notifyOwner: owner.notifyOwner })).toBe("retired")
    expect(config.value).toEqual({})
    const gone = nerves.mock.calls.map(([event]) => event).find((event) => event.event === "channel.a2a_relay_previous_gone")
    expect(gone).toMatchObject({ level: "warn", meta: { relayUrl: relay.url, reason: "relay 401 unauthorized", lost: false } })
    nerves.mockRestore()

    const previous = registered("old")
    relay.failNext("pull", 404, "not_found")
    const config404 = memoryConfig({ previousRegistrations: [previous] })
    await retirePreviousRegistrations({ config: config404, seen: () => false, handle: ok2, notifyOwner: owner.notifyOwner })
    expect(config404.value).toEqual({})
    expect(owner.sent).toHaveLength(0)
  })

  it("does not take a 404 that is not the relay's own JSON (a proxy page) as gone", async () => {
    const previous = registered("old")
    const proxied = (async () => new Response("<html>not found</html>", { status: 404 })) as unknown as typeof fetch
    const config = memoryConfig({ previousRegistrations: [previous] })
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, fetchImpl: proxied })).toBe("kept")
    expect(config.value.previousRegistrations).toEqual([previous])
  })

  const neverAnswers = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)) })) as unknown as typeof fetch
  it.each([
    ["answers 5xx forever", (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch],
    ["hangs", neverAnswers],
    ["fails TLS", failingFetch(() => new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }))],
    ["answers 200 with something other than its JSON", (async () => new Response("<html>sign in to the wifi</html>", { status: 200 })) as unknown as typeof fetch],
  ])("keeps a relay that %s until attempts have failed for more than the envelope age limit, then retires it and tells the owner", async (_name, fetchImpl) => {
    const previous = { relayUrl: "https://old.example", handle: "old", inboxAuth: "ia", sendCredential: "sc" }
    const config = memoryConfig({ previousRegistrations: [previous] })
    const retirements = memoryRelayRetirements()
    const owner = notices()
    const t0 = Date.parse("2026-11-01T00:00:00Z")
    const run = (at: number) => retirePreviousRegistrations({ config, seen: () => false, handle: ok2, fetchImpl, retirements, notifyOwner: owner.notifyOwner, now: () => at, relayTimeoutMs: 20 })
    expect(await run(t0)).toBe("kept")
    expect(retirements.read(previous)).toEqual({ firstFailedAt: t0 })
    expect(await run(t0 + MAX_ENVELOPE_AGE_MS)).toBe("kept")
    expect(config.value.previousRegistrations).toEqual([previous])
    expect(owner.sent).toHaveLength(0)
    expect(await run(t0 + MAX_ENVELOPE_AGE_MS + 1)).toBe("retired")
    expect(config.value).toEqual({})
    expect(owner.sent).toHaveLength(1)
    expect(owner.sent[0].noticeId).toMatch(/^a2a-relay-gone-[0-9a-f]{16}$/)
    expect(owner.sent[0].text).toMatch(/my old relay \(old\.example\) couldn't be reached for more than 7 days, so any messages still waiting there are lost/)
    expect(owner.sent[0].text).toMatch(/will need to send it again; new messages reach me through the new relay or directly/)
    expect(owner.sent[0].text).not.toContain(previous.inboxAuth)
  })

  it("says how long it waits before giving up on a relay that keeps failing", async () => {
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    const config = memoryConfig({ previousRegistrations: [{ relayUrl: await closedUrl(), handle: "old", inboxAuth: "ia", sendCredential: "sc" }] })
    await retirePreviousRegistrations({ config, seen: () => false, handle: ok2 })
    const failed = nerves.mock.calls.map(([event]) => event).find((event) => event.event === "channel.a2a_relay_previous_retire_failed")!
    expect(failed.message).toMatch(/more than 7 days in a row/)
    expect(failed.meta).toMatchObject({ firstFailedAt: expect.any(String) })
    nerves.mockRestore()
  })

  it("never retires after one refused connection: a later successful pull restarts the clock", async () => {
    const previous = registered("old")
    enqueue("old", sealedMessage("busy"))
    const config = memoryConfig({ previousRegistrations: [previous] })
    const retirements = memoryRelayRetirements()
    const owner = notices()
    const t0 = Date.parse("2026-11-01T00:00:00Z")
    let down = true
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (down) throw refusedConnection()
      return fetch(url, init)
    }) as typeof fetch
    const run = (at: number) => retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => refused(rpc.id, "result", "in_flight"), fetchImpl, retirements, notifyOwner: owner.notifyOwner, now: () => at })
    expect(await run(t0)).toBe("kept")
    expect(retirements.read(previous).firstFailedAt).toBe(t0)
    down = false
    expect(await run(t0 + DAY)).toBe("kept")
    expect(retirements.read(previous)).toEqual({})
    down = true
    expect(await run(t0 + MAX_ENVELOPE_AGE_MS + DAY)).toBe("kept")
    expect(config.value.previousRegistrations).toEqual([previous])
    expect(relay.registrations.has("old")).toBe(true)
    expect(owner.sent).toHaveLength(0)
  })

  it("tells the owner the old relay no longer knows this agent when it forgets the registration mid-drain", async () => {
    const previous = registered("old")
    enqueue("old", sealedMessage("m1"))
    let pulls = 0
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET" && ++pulls === 2) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      return fetch(url, init)
    }) as typeof fetch
    const config = memoryConfig({ previousRegistrations: [previous] })
    const owner = notices()
    await retirePreviousRegistrations({ config, seen: () => false, handle: async (rpc) => refused(rpc.id, "result", "in_flight"), fetchImpl, notifyOwner: owner.notifyOwner })
    expect(config.value).toEqual({})
    expect(owner.sent).toHaveLength(1)
    expect(owner.sent[0].text).toMatch(/my old relay \(127\.0\.0\.1:\d+\) no longer knows me, so any messages still waiting there are lost/)
    expect(owner.sent[0].text).not.toMatch(/couldn't be reached/)
  })

  it("does not tell the owner anything was lost when the old inbox was drained empty and only the deregistration found it gone", async () => {
    const previous = registered("old")
    enqueue("old", sealedMessage("m1"))
    relay.failNext("deregister", 404, "not_found")
    const config = memoryConfig({ previousRegistrations: [previous] })
    const owner = notices()
    await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, notifyOwner: owner.notifyOwner })
    expect(config.value).toEqual({})
    expect(owner.sent).toHaveLength(0)
  })

  it("does not claim messages were lost on a later start when both the local record and the vault write failed after deregistering", async () => {
    const previous = registered("old")
    const config = memoryConfig({ previousRegistrations: [previous] })
    config.failWrites = 1
    const broken = { read: () => ({}), write: () => { throw new Error("disk full") }, clear: () => undefined }
    const owner = notices()
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements: broken, notifyOwner: owner.notifyOwner })).toBe("pending")
    expect(relay.registrations.has("old")).toBe(false)
    // A later start: no record survived, and the relay answers 401 for the handle it deleted.
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements: memoryRelayRetirements(), notifyOwner: owner.notifyOwner })).toBe("retired")
    expect(config.value).toEqual({})
    expect(owner.sent).toHaveLength(0)
  })

  it("still retires the registration when the owner notice cannot be sent", async () => {
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    const previous = { relayUrl: "https://old.example", handle: "old", inboxAuth: "ia", sendCredential: "sc" }
    const retirements = memoryRelayRetirements()
    retirements.write(previous, { firstFailedAt: 0 })
    const config = memoryConfig({ previousRegistrations: [previous] })
    await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements, fetchImpl: failingFetch(refusedConnection), now: () => MAX_ENVELOPE_AGE_MS + 1, notifyOwner: async () => { throw new Error("telegram down") } })
    expect(config.value).toEqual({})
    expect(nerves.mock.calls.map(([event]) => event.event)).toContain("channel.a2a_relay_owner_notice_failed")
    nerves.mockRestore()
  })

  it("retires a relay past its window with no owner channel, and keeps an operator's removal made meanwhile", async () => {
    const previous = { relayUrl: "https://old.example", handle: "old", inboxAuth: "ia", sendCredential: "sc" }
    const retirements = memoryRelayRetirements()
    retirements.write(previous, { firstFailedAt: 0 })
    const config = memoryConfig({ previousRegistrations: [previous] })
    let reads = 0
    config.onRead = () => { reads += 1; if (reads === 2) delete config.value.previousRegistrations }
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements, fetchImpl: failingFetch(refusedConnection), now: () => MAX_ENVELOPE_AGE_MS + 1 })).toBe("retired")
    expect(config.value).toEqual({})
  })

  it("records a retirement whose vault write failed, then retries only the write, without notifying again", async () => {
    const previous = registered("old")
    const config = memoryConfig({ previousRegistrations: [previous] })
    config.failWrites = 1
    const retirements = memoryRelayRetirements()
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements })).toBe("pending")
    expect(relay.registrations.has("old")).toBe(false)
    expect(config.value.previousRegistrations).toEqual([previous])
    expect(retirements.read(previous)).toEqual({ retired: true })

    const requestsBefore = relay.requests.length
    const owner = notices()
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements, notifyOwner: owner.notifyOwner })).toBe("retired")
    expect(relay.requests.length).toBe(requestsBefore)
    expect(config.value).toEqual({})
    expect(retirements.read(previous)).toEqual({})
    expect(owner.sent).toHaveLength(0)
  })

  it("records a gone relay whose vault write failed, and notifies the owner only once", async () => {
    const previous = { relayUrl: "https://old.example", handle: "old", inboxAuth: "ia", sendCredential: "sc" }
    const config = memoryConfig({ previousRegistrations: [previous] })
    config.failWrites = 2
    const retirements = memoryRelayRetirements()
    retirements.write(previous, { firstFailedAt: 0 })
    const owner = notices()
    const run = () => retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements, fetchImpl: failingFetch(refusedConnection), now: () => MAX_ENVELOPE_AGE_MS + 1, notifyOwner: owner.notifyOwner })
    await run()
    await run()
    expect(config.value.previousRegistrations).toEqual([previous])
    await run()
    expect(config.value).toEqual({})
    expect(owner.sent).toHaveLength(1)
  })

  it("still finishes a retirement when its local record cannot be read, written or removed", async () => {
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    const previous = registered("old")
    const config = memoryConfig({ previousRegistrations: [previous] })
    const broken = { read: () => { throw new Error("unreadable") }, write: () => { throw new Error("disk full") }, clear: () => { throw new Error("read-only") } }
    expect(await retirePreviousRegistrations({ config, seen: () => false, handle: ok2, retirements: broken })).toBe("retired")
    expect(config.value).toEqual({})
    expect(nerves.mock.calls.map(([event]) => event.event).filter((event) => event === "channel.a2a_relay_retirement_record_failed")).toHaveLength(3)
    nerves.mockRestore()
  })

  it("skips retiring when the vault cannot be read, without throwing", async () => {
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    expect(await retirePreviousRegistrations({ config: { read: async () => { throw new Error("vault unreachable") }, write: async () => undefined }, seen: () => false, handle: ok2 })).toBe("kept")
    expect(nerves.mock.calls.map(([event]) => event).find((event) => event.event === "channel.a2a_relay_previous_read_failed")).toMatchObject({ level: "warn" })
    nerves.mockRestore()
  })
})

/** Timers the test fires by hand: each `set` is recorded with its delay, and `fire()` runs the latest one. */
function manualTimers() {
  const scheduled: Array<{ ms: number; fn: () => void; cleared: boolean }> = []
  return {
    scheduled,
    delays: () => scheduled.map((t) => t.ms),
    timers: {
      set: (fn: () => void, ms: number) => { const t = { ms, fn, cleared: false }; scheduled.push(t); return t },
      clear: (t: unknown) => { (t as { cleared: boolean }).cleared = true },
    },
    /** Fire the latest timer and wait until the pass it starts has scheduled the next one (or stopped). */
    async fire(expectNext = true) {
      const count = scheduled.length
      scheduled[count - 1].fn()
      if (expectNext) await vi.waitFor(() => expect(scheduled.length).toBe(count + 1))
    },
  }
}

describe("startRelayInbox", () => {
  it("is off without a relay url, and when the configuration cannot be read", async () => {
    const off = startRelayInbox({ config: memoryConfig(), did: DID, agentName: "me", seen: () => false, handle: async (rpc) => ok(rpc.id) })
    await off.ready
    expect(off.registration()).toBeNull()
    expect(await off.tick()).toBe("stop")
    const broken = startRelayInbox({ config: { read: async () => { throw new Error("vault unreachable") }, write: async () => undefined }, did: DID, agentName: "me", seen: () => false, handle: async (rpc) => ok(rpc.id) })
    await broken.ready
    expect(broken.registration()).toBeNull()
  })

  it("registers, delivers what is queued, polls on the interval, and backs off doubling to at most five minutes", async () => {
    const clock = manualTimers()
    const delivered: string[] = []
    const inbox = startRelayInbox({
      config: memoryConfig({ url: relay.url }), did: DID, agentName: "me", seen: () => false, timers: clock.timers,
      handle: async (rpc) => { delivered.push((rpc.params as { message: { messageId: string } }).message.messageId); return ok(rpc.id) },
    })
    await inbox.ready
    expect(clock.delays()).toEqual([30_000])
    enqueue(inbox.registration()!.handle, sealedMessage("while-away"))
    await clock.fire()
    expect(delivered).toEqual(["while-away"])
    for (let i = 0; i < 6; i += 1) {
      relay.failNext("pull", 503)
      await clock.fire()
    }
    await clock.fire()
    expect(clock.delays()).toEqual([30_000, 30_000, 60_000, 120_000, 240_000, RELAY_MAX_BACKOFF_MS, RELAY_MAX_BACKOFF_MS, RELAY_MAX_BACKOFF_MS, 30_000])
    inbox.stop()
    expect(clock.scheduled.at(-1)!.cleared).toBe(true)
  })

  it("stops polling after a 401 and stops scheduling once stopped", async () => {
    const clock = manualTimers()
    const registration = registered()
    const inbox = startRelayInbox({ config: memoryConfig({ url: relay.url, registration }), did: DID, agentName: "me", seen: () => false, timers: clock.timers, handle: async (rpc) => ok(rpc.id) })
    await inbox.ready
    relay.registrations.set("h1", { did: DID, inboxAuth: "rotated", sendCredential: "sc", agentCard: {} })
    clock.scheduled.at(-1)!.fn()
    await vi.waitFor(() => expect(inbox.registration()).toBeNull())
    expect(clock.scheduled).toHaveLength(1)

    const second = startRelayInbox({ config: memoryConfig({ url: relay.url, registration: { ...registration, inboxAuth: "rotated" } }), did: DID, agentName: "me", seen: () => false, timers: clock.timers, handle: async (rpc) => ok(rpc.id) })
    await second.ready
    const count = clock.scheduled.length
    second.stop()
    clock.scheduled.at(-1)!.fn()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(clock.scheduled).toHaveLength(count)
  })

  it("starts with a doubled delay when the first pass fails, and does not run two passes at once", async () => {
    const clock = manualTimers()
    const registration = registered()
    relay.failNext("pull", 503)
    let release: () => void = () => undefined
    let calls = 0
    const inbox = startRelayInbox({
      config: memoryConfig({ url: relay.url, registration }), did: DID, agentName: "me", seen: () => false, timers: clock.timers,
      handle: async (rpc) => { calls += 1; await new Promise<void>((resolve) => { release = resolve }); return ok(rpc.id) },
    })
    await inbox.ready
    expect(clock.delays()).toEqual([60_000])
    enqueue("h1", sealedMessage("slow"))
    clock.scheduled[0].fn()
    await vi.waitFor(() => expect(calls).toBe(1))
    const again = inbox.tick()
    release()
    expect(await again).toBe("ok")
    expect(calls).toBe(1)
    inbox.stop()
  })

  it("keeps the inbox on when the vault read for retiring fails", async () => {
    const clock = manualTimers()
    const registration = registered()
    const config = memoryConfig({ url: relay.url, registration })
    let reads = 0
    // The first read registers; the second, for retiring, fails.
    config.onRead = () => { reads += 1; if (reads === 2) throw new Error("vault busy") }
    const inbox = startRelayInbox({ config, did: DID, agentName: "me", seen: () => false, timers: clock.timers, handle: async (rpc) => ok(rpc.id) })
    await inbox.ready
    expect(inbox.registration()).toEqual(registration)
    expect(clock.delays()).toEqual([30_000])
    inbox.stop()
  })

  it("moves to the new relay and polls it while an old relay is still inside its window; only that relay's retirement waits", async () => {
    const http = await import("node:http")
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const dead = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const clock = manualTimers()
    const current = { relayUrl: `${dead}/b`, handle: "b-h", inboxAuth: "b-ia", sendCredential: "b-sc" }
    const previous = { relayUrl: `${dead}/a`, handle: "a-h", inboxAuth: "a-ia", sendCredential: "a-sc" }
    const config = memoryConfig({ url: relay.url, inviteToken: "inv", registration: current, previousRegistrations: [previous] })
    const sent: string[] = []
    const delivered: string[] = []
    const inbox = startRelayInbox({
      config, did: DID, agentName: "me", seen: () => false, timers: clock.timers, notifyOwner: async (notice) => { sent.push(notice.noticeId) },
      handle: async (rpc) => { delivered.push((rpc.params as { message: { messageId: string } }).message.messageId); return ok(rpc.id) },
    })
    await inbox.ready
    expect(inbox.registration()?.relayUrl).toBe(relay.url)
    expect(config.value).toEqual({ url: relay.url, registration: inbox.registration(), previousRegistrations: [previous, current] })
    expect(sent).toEqual([])
    enqueue(inbox.registration()!.handle, sealedMessage("via-new-relay"))
    await inbox.tick()
    expect(delivered).toEqual(["via-new-relay"])
    inbox.stop()
  })

  it("retries a pending retirement's vault write on the next pass, with no deregistration", async () => {
    const clock = manualTimers()
    const registration = registered()
    const previous = registered("old")
    const config = memoryConfig({ url: relay.url, registration, previousRegistrations: [previous] })
    config.failWrites = 1
    const inbox = startRelayInbox({ config, did: DID, agentName: "me", seen: () => false, timers: clock.timers, handle: async (rpc) => ok(rpc.id) })
    // The deregistration succeeds and the vault write after it fails; the first pass after that saves the removal.
    await inbox.ready
    expect(config.value.previousRegistrations).toBeUndefined()
    expect(relay.requests.filter((r) => r.method === "DELETE")).toHaveLength(1)
    expect(relay.registrations.has("h1")).toBe(true)
    inbox.stop()
  })

  it("keeps retrying a pending retirement's vault write on later passes while it fails, and keeps polling", async () => {
    const clock = manualTimers()
    const registration = registered()
    const previous = registered("old")
    const config = memoryConfig({ url: relay.url, registration, previousRegistrations: [previous] })
    config.failWrites = 2
    const delivered: string[] = []
    const inbox = startRelayInbox({ config, did: DID, agentName: "me", seen: () => false, timers: clock.timers, handle: async (rpc) => { delivered.push((rpc.params as { message: { messageId: string } }).message.messageId); return ok(rpc.id) } })
    await inbox.ready
    expect(config.value.previousRegistrations).toEqual([previous])
    enqueue("h1", sealedMessage("still-polled"))
    await inbox.tick()
    expect(delivered).toEqual(["still-polled"])
    expect(config.value.previousRegistrations).toBeUndefined()
    expect(relay.requests.filter((r) => r.method === "DELETE")).toHaveLength(1)
    inbox.stop()
  })

  it("does not poll when stopped before registration finished, and uses the real timers by default", async () => {
    const stopped = startRelayInbox({ config: memoryConfig({ url: relay.url }), did: DID, agentName: "me", seen: () => false, handle: async (rpc) => ok(rpc.id) })
    stopped.stop()
    await stopped.ready
    expect(relay.requests.filter((r) => r.method === "GET")).toHaveLength(0)
    const running = startRelayInbox({ config: memoryConfig({ url: relay.url }), did: DID, agentName: "me", seen: () => false, handle: async (rpc) => ok(rpc.id) })
    await running.ready
    expect(running.registration()).not.toBeNull()
    running.stop()
  })
})
