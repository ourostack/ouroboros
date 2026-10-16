import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { openFeedbackStore, type FeedbackInput, type FeedbackStore } from "../../../senses/shepherd/feedback-store"

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>()
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) }
})

const stores: FeedbackStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })

function open(file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-feedback-")), "feedback", "queue.sqlite")) {
  const store = openFeedbackStore(file)
  stores.push(store)
  return { store, file }
}

function input(overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    id: `feedback:${randomUUID()}`, actorId: "owner", agent: "orchid-runtime",
    bodyHash: createHash("sha256").update("original feedback").digest("hex"),
    createdAt: "2026-10-15T19:00:00.000Z",
    source: { id: "11111111-1111-4111-8111-111111111111", host: "cmux", label: "Original terminal",
      tty: "/dev/ttys001", cwd: "/project", task: null },
    packet: { feedback: "You should have caught the premature stop.", context: null, screen: "Plan written. Want me to proceed?", previousReturn: null },
    recipient: { friendId: "owner", aadObjectId: "owner-aad", tenantId: "owner-tenant" },
    receipt: "Orchid One: received. I will follow up in Teams.",
    ...overrides,
  }
}

describe("durable session feedback custody", () => {
  it("preserves its immutable source and original receipt when an identical submission is retried", () => {
    const { store, file } = open()
    const original = input()
    const accepted = store.submit(original)
    const retried = store.submit({ ...original, source: { ...original.source, label: "Drifted", tty: "/dev/ttys999" }, receipt: "different" })
    expect(retried).toEqual(accepted)
    expect(store.read(original.id, "other-actor")).toBeNull()
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    store.close()
    const reopened = open(file).store
    expect(reopened.read(original.id, "owner")?.source.tty).toBe("/dev/ttys001")
    expect(reopened.pending().map(record => record.id)).toEqual([original.id])
  })

  it("rejects changed bodies and independently scopes the same request ID to different actors", () => {
    const { store } = open()
    const original = input()
    store.submit(original)
    expect(() => store.submit({ ...original, bodyHash: "a".repeat(64) })).toThrow("different")
    store.submit({ ...original, actorId: "second", recipient: { ...original.recipient, friendId: "second" } })
    expect(store.pending()).toHaveLength(2)
  })

  it("allows one review owner across independent database connections and never reclaims an uncertain invocation", () => {
    const { store, file } = open()
    const record = store.submit(input())
    const other = open(file).store
    expect(store.claimReview(record.id, record.actorId, "worker-a")?.review.state).toBe("claimed")
    expect(other.claimReview(record.id, record.actorId, "worker-b")).toBeNull()
    expect(other.pending()).toEqual([])
    expect(() => other.completeReview(record.id, record.actorId, "worker-b", "Wrong owner")).toThrow("owner")
    store.close()
    const reopened = open(file).store
    expect(reopened.read(record.id, record.actorId)?.review.state).toBe("claimed")
    expect(reopened.claimReview(record.id, record.actorId, "worker-c")).toBeNull()
  })

  it("persists the full response before one transport claim and binds clarification to actor, chat and real message", () => {
    const { store } = open()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    store.completeReview(record.id, "owner", "worker", "I recorded a session-only correction. Did you mean this project too?")
    expect(store.claimDelivery(record.id, "owner", "sender")?.review.response).toContain("session-only")
    expect(store.claimDelivery(record.id, "owner", "other-sender")).toBeNull()
    expect(store.read(record.id, "owner")?.delivery.state).toBe("unknown")
    store.completeDelivery(record.id, "owner", "sender", { state: "sent", conversationId: "private-chat", messageId: "activity-1" })
    expect(store.findReply("owner", "private-chat", "activity-1")?.id).toBe(record.id)
    expect(store.findReply("other", "private-chat", "activity-1")).toBeNull()
    expect(store.findReply("owner", "other-chat", "activity-1")).toBeNull()
    expect(store.pending()).toEqual([])
    expect(store.read(record.id, "owner")?.delivery.state).toBe("sent")
  })

  it("retries only definite not-sent outcomes, never a transport with unknown acceptance", () => {
    const { store } = open()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    store.completeReview(record.id, "owner", "worker", "Acknowledged.")
    store.claimDelivery(record.id, "owner", "sender-a")
    store.completeDelivery(record.id, "owner", "sender-a", { state: "pending", reason: "definitely not sent" })
    expect(store.claimDelivery(record.id, "owner", "sender-b")?.delivery.attempts).toBe(2)
    store.completeDelivery(record.id, "owner", "sender-b", { state: "unknown", reason: "connection lost after send" })
    expect(store.claimDelivery(record.id, "owner", "sender-c")).toBeNull()
    expect(store.read(record.id, "owner")?.delivery.reason).toContain("connection lost")
  })

  it("reserves response capacity before acceptance and keeps an oversized later response from erasing custody", () => {
    const { store } = open()
    expect(() => store.submit(input({ packet: { feedback: "feedback", context: "x".repeat(40_000), screen: "x".repeat(20_000), previousReturn: null } }))).toThrow()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    expect(() => store.completeReview(record.id, "owner", "worker", "x".repeat(20_000))).toThrow("response")
    expect(store.read(record.id, "owner")?.review.state).toBe("claimed")
  })

  it("does not make the hot queue cap a lifetime usage ceiling after accepted delivery", () => {
    const { store } = open()
    const first = store.submit(input())
    store.claimReview(first.id, "owner", "review")
    store.completeReview(first.id, "owner", "review", "Recorded.")
    store.claimDelivery(first.id, "owner", "send")
    store.completeDelivery(first.id, "owner", "send", { state: "sent", conversationId: "chat", messageId: "first" })
    for (let index = 0; index < 512; index++) store.submit(input())
    expect(() => store.submit(input())).toThrow("capacity")
    expect(store.read(first.id, "owner")?.delivery.messageId).toBe("first")
    expect(store.findReply("owner", "chat", "first")?.id).toBe(first.id)
  })

  it("refuses database and archive symlinks instead of following another file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-feedback-links-"))
    const target = path.join(directory, "target")
    fs.writeFileSync(target, "preserve")
    const file = path.join(directory, "queue.sqlite")
    fs.symlinkSync(target, file)
    expect(() => openFeedbackStore(file)).toThrow()
    expect(fs.readFileSync(target, "utf8")).toBe("preserve")
  })

  it.each([
    { review: { state: "complete", owner: null, response: null, reason: null } },
    { review: { state: "claimed", owner: null, response: null, reason: null } },
    { delivery: { state: "sent", owner: null, attempts: 1, conversationId: null, messageId: null, reason: null } },
  ])("refuses corrupt phase evidence instead of advertising completion: %j", change => {
    const { store, file } = open()
    const record = store.submit(input())
    const database = new Database(file)
    try {
      database.prepare("UPDATE feedback SET data=? WHERE actor=? AND id=?")
        .run(JSON.stringify({ ...record, ...change }), record.actorId, record.id)
    } finally { database.close() }
    expect(() => store.read(record.id, record.actorId)).toThrow("schema")
  })

  it("rejects unsupported database generations instead of opening them as today's schema", () => {
    const { store, file } = open()
    store.close()
    const database = new Database(file)
    database.pragma("user_version = 99")
    database.close()
    expect(() => openFeedbackStore(file)).toThrow("schema")
  })

  it("rejects UUID-shaped garbage and malformed historical judgments rather than preserving them as verified context", () => {
    const { store } = open()
    expect(() => store.submit(input({ id: `feedback:${"-".repeat(36)}` }))).toThrow("schema")
    const original = input()
    expect(() => store.submit({ ...original, source: { ...original.source, id: "-".repeat(36) } })).toThrow("schema")
    const malformed: FeedbackInput = JSON.parse(JSON.stringify(original))
    Object.assign(malformed.packet, { previousReturn: {} })
    expect(() => store.submit(malformed)).toThrow("schema")
  })

  it("retains custody when a late sender/unknown request or malformed outcome tries to change it", () => {
    const { store } = open()
    const record = store.submit(input())
    expect(store.claimDelivery(record.id, record.actorId, "sender")).toBeNull()
    expect(() => store.claimReview("unknown", "owner", "worker")).toThrow("unknown")
    expect(() => store.claimReview(record.id, "owner", "")).toThrow("owner")
    store.claimReview(record.id, "owner", "worker")
    expect(() => store.completeReview(record.id, "owner", "worker", "answer", "")).toThrow("uncertainty")
    store.completeReview(record.id, "owner", "worker", "answer")
    store.claimDelivery(record.id, "owner", "sender")
    expect(() => store.completeDelivery(record.id, "owner", "other", { state: "pending" })).toThrow("owner")
    expect(() => store.completeDelivery(record.id, "owner", "sender", { state: "sent" })).toThrow("receipt")
    const malformed = JSON.parse('{"state":"fabricated"}')
    expect(() => store.completeDelivery(record.id, "owner", "sender", malformed)).toThrow("state")
    expect(store.read(record.id, "owner")?.delivery.state).toBe("unknown")
  })

  it.each([
    { actorId: "x".repeat(513) },
    { agent: "x".repeat(257) },
    { receipt: "x".repeat(4097) },
  ])("refuses oversized identity/receipt metadata before creating custody: %j", override => {
    const { store } = open()
    const value = input(override)
    if (override.actorId) value.recipient.friendId = override.actorId
    expect(() => store.submit(value)).toThrow("limit")
    expect(store.pending()).toEqual([])
  })

  it("reserves enough space for the later full response even when each source field fits its own bound", () => {
    const { store } = open()
    const value = input()
    value.packet.context = "x".repeat(7000)
    value.packet.screen = "x".repeat(14000)
    value.packet.previousReturn = {
      at: "now", host: "cmux", session: value.source.id, transition: "old", agent: "Copilot", cwd: "/project", task: null,
      kind: "done", action: "let_through", reason: "x".repeat(30000), reply: null, latencyMs: null, inputTokens: null,
    }
    expect(() => store.submit(value)).toThrow("reserved response capacity")
    expect(store.pending()).toEqual([])
  })

  it("refuses unsafe database locations, permissions and unsupported existing table layouts", () => {
    expect(() => openFeedbackStore("relative.sqlite")).toThrow("path")
    const { store, file } = open()
    store.close()
    fs.chmodSync(path.dirname(file), 0o755)
    expect(() => openFeedbackStore(file)).toThrow("directory")
    fs.chmodSync(path.dirname(file), 0o700)
    fs.chmodSync(file, 0o644)
    expect(() => openFeedbackStore(file)).toThrow("file")
    fs.chmodSync(file, 0o600)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "malformed-feedback-db-"))
    const malformed = path.join(directory, "queue.sqlite")
    const database = new Database(malformed)
    database.exec("CREATE TABLE feedback (wrong TEXT)")
    database.pragma("user_version = 1")
    database.close()
    fs.chmodSync(malformed, 0o600)
    expect(() => openFeedbackStore(malformed)).toThrow()
  })

  it("refuses a changed process owner before trusting either directory or database bytes", () => {
    const { store, file } = open()
    store.close()
    const uid = process.getuid!()
    const owner = vi.spyOn(process, "getuid")
    try {
      owner.mockReturnValue(uid + 1)
      expect(() => openFeedbackStore(file)).toThrow("ownership")
      owner.mockReset().mockReturnValueOnce(uid).mockReturnValue(uid + 1)
      expect(() => openFeedbackStore(file)).toThrow("ownership")
    } finally { owner.mockRestore() }
  })

  it("reconciles an already-written identical archive without overwriting a conflicting one", () => {
    const { store, file } = open()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    store.completeReview(record.id, "owner", "worker", "Recorded.")
    store.claimDelivery(record.id, "owner", "sender")
    const before = store.read(record.id, "owner")!
    const receipt = { state: "sent" as const, conversationId: "chat", messageId: "activity" }
    store.completeDelivery(record.id, "owner", "sender", receipt)
    const directory = path.join(path.dirname(file), "receipts")
    const archive = path.join(directory, fs.readdirSync(directory)[0]!)
    const database = new Database(file)
    try {
      database.prepare("UPDATE feedback SET data=?,archive_hash=NULL,conversation=NULL,message=NULL WHERE id=?")
        .run(JSON.stringify(before), record.id)
      store.completeDelivery(record.id, "owner", "sender", receipt)
      expect(store.read(record.id, "owner")?.delivery.state).toBe("sent")
      database.prepare("UPDATE feedback SET data=?,archive_hash=NULL,conversation=NULL,message=NULL WHERE id=?")
        .run(JSON.stringify(before), record.id)
      fs.writeFileSync(archive, "conflicting immutable bytes")
      expect(() => store.completeDelivery(record.id, "owner", "sender", receipt)).toThrow("archive conflict")
      expect(fs.readFileSync(archive, "utf8")).toBe("conflicting immutable bytes")
      expect(store.read(record.id, "owner")?.delivery.state).toBe("unknown")
    } finally { database.close() }
  })

  it("rejects oversized or changed archived receipt bytes instead of presenting a made-up acknowledgement", () => {
    const { store, file } = open()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    store.completeReview(record.id, "owner", "worker", "Recorded.")
    store.claimDelivery(record.id, "owner", "sender")
    store.completeDelivery(record.id, "owner", "sender", { state: "sent", conversationId: "chat", messageId: "activity" })
    const directory = path.join(path.dirname(file), "receipts")
    const archive = path.join(directory, fs.readdirSync(directory)[0]!)
    const original = fs.readFileSync(archive, "utf8")
    fs.writeFileSync(archive, "x".repeat(70000))
    expect(() => store.read(record.id, "owner")).toThrow("byte limit")
    fs.writeFileSync(archive, original.replace("Recorded.", "Forged!!"))
    expect(() => store.read(record.id, "owner")).toThrow("fingerprint")
  })

  it.each([
    { label: "non-record", patch: null },
    { label: "mismatched recipient", patch: { actorId: "different-actor" } },
    { label: "missing review", patch: { review: null } },
    { label: "missing delivery", patch: { delivery: null } },
    { label: "invalid review phase", patch: { review: { state: "invented", owner: null, response: null, reason: null } } },
  ])("refuses corrupted stored $label data before exposing a receipt", ({ patch }) => {
    const { store, file } = open()
    const record = store.submit(input())
    const value = patch === null ? null : { ...record, ...patch }
    const database = new Database(file)
    try { database.prepare("UPDATE feedback SET data=?").run(JSON.stringify(value)) } finally { database.close() }
    expect(() => store.read(record.id, "owner")).toThrow("schema")
  })

  it("rejects oversized row bytes and valid-but-substituted row identities", () => {
    const { store, file } = open()
    const record = store.submit(input())
    const database = new Database(file)
    try {
      database.prepare("UPDATE feedback SET data=?").run("x".repeat(70000))
      expect(() => store.read(record.id, "owner")).toThrow("byte limit")
      database.prepare("UPDATE feedback SET data=?").run(JSON.stringify({ ...record, id: `feedback:${randomUUID()}` }))
      expect(() => store.read(record.id, "owner")).toThrow("identity")
    } finally { database.close() }
  })

  it("surfaces a failed database creation rather than creating an in-memory success substitute", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "failed-feedback-store-"))
    const file = path.join(directory, "queue.sqlite")
    const nativeOpen = (await vi.importActual<typeof import("node:fs")>("node:fs")).openSync
    const hook = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (target === file) throw Object.assign(new Error("storage unavailable"), { code: "EIO" })
      return nativeOpen(target, flags, mode)
    })
    try {
      expect(() => openFeedbackStore(file)).toThrow("storage unavailable")
      expect(fs.existsSync(file)).toBe(false)
    } finally { hook.mockRestore() }
  })

  it("retains uncertain delivery when receipt archival fails after transport acceptance", async () => {
    const { store, file } = open()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    store.completeReview(record.id, "owner", "worker", "Recorded.")
    store.claimDelivery(record.id, "owner", "sender")
    const before = store.read(record.id, "owner")!
    const receipt = { state: "sent" as const, conversationId: "chat", messageId: "activity" }
    store.completeDelivery(record.id, "owner", "sender", receipt)
    const directory = path.join(path.dirname(file), "receipts")
    const archive = path.join(directory, fs.readdirSync(directory)[0]!)
    fs.renameSync(archive, `${archive}.preserved`)
    const database = new Database(file)
    database.prepare("UPDATE feedback SET data=?,archive_hash=NULL,conversation=NULL,message=NULL").run(JSON.stringify(before))
    database.close()
    const nativeOpen = (await vi.importActual<typeof import("node:fs")>("node:fs")).openSync
    const hook = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (target === archive) throw Object.assign(new Error("archive disk failure"), { code: "EIO" })
      return nativeOpen(target, flags, mode)
    })
    try {
      expect(() => store.completeDelivery(record.id, "owner", "sender", receipt)).toThrow("archive disk failure")
      expect(store.read(record.id, "owner")?.delivery.state).toBe("unknown")
    } finally { hook.mockRestore() }
  })

  it("refuses a receipt file swapped during its descriptor read, even when replacement bytes match", async () => {
    const { store, file } = open()
    const record = store.submit(input())
    store.claimReview(record.id, "owner", "worker")
    store.completeReview(record.id, "owner", "worker", "Recorded.")
    store.claimDelivery(record.id, "owner", "sender")
    store.completeDelivery(record.id, "owner", "sender", { state: "sent", conversationId: "chat", messageId: "activity" })
    const directory = path.join(path.dirname(file), "receipts")
    const archive = path.join(directory, fs.readdirSync(directory)[0]!)
    const replacement = `${archive}.replacement`
    fs.writeFileSync(replacement, fs.readFileSync(archive), { mode: 0o600 })
    const nativeRead = (await vi.importActual<typeof import("node:fs")>("node:fs")).readFileSync
    const hook = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const result = nativeRead(...args)
      if (typeof args[0] === "number") {
        fs.renameSync(archive, `${archive}.preserved`)
        fs.renameSync(replacement, archive)
      }
      return result
    })
    try { expect(() => store.read(record.id, "owner")).toThrow("archive changed") }
    finally { hook.mockRestore() }
  })
})
