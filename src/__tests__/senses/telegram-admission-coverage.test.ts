import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTelegramAdmissionController, FileTelegramAdmissionStore, type TelegramAdmissionRecord } from "../../senses/telegram-admission"
import { acquireSessionTurnLease } from "../../mind/session-transaction"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-admission-coverage-"))
  roots.push(value)
  return value
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    updateId: 1,
    messageId: 2,
    botId: "777",
    userId: "888",
    chatId: "888",
    text: "hello",
    displayLabel: "Unknown",
    hasAttachments: false,
    ...overrides,
  } as Parameters<FileTelegramAdmissionStore["capture"]>[0]
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Telegram admission defensive coverage", () => {
  it("rejects invalid limits, roots, identifiers, and bounded record files", () => {
    expect(() => new FileTelegramAdmissionStore(path.join(root(), "bad-limit"), { maxTextBytes: 0 })).toThrow("positive safe integer")
    const fileRoot = path.join(root(), "file"); fs.writeFileSync(fileRoot, "x")
    expect(() => new FileTelegramAdmissionStore(fileRoot)).toThrow("directory")

    const storeRoot = path.join(root(), "store")
    const store = new FileTelegramAdmissionStore(storeRoot, { maxTextBytes: 8 })
    expect(() => store.read("not-an-id")).toThrow("id is invalid")
    const tooSmall = "a".repeat(20); fs.writeFileSync(path.join(storeRoot, `${tooSmall}.json`), "x")
    expect(() => store.read(tooSmall)).toThrow("not bounded")
    const tooLarge = "b".repeat(20); fs.writeFileSync(path.join(storeRoot, `${tooLarge}.json`), "x".repeat(8 * 1024 + 9))
    expect(() => store.read(tooLarge)).toThrow("not bounded")
  })

  it.each([
    ["unsafe update", { updateId: 1.5 }],
    ["negative update", { updateId: -1 }],
    ["unsafe message", { messageId: 1.5 }],
    ["zero message", { messageId: 0 }],
    ["bad bot", { botId: "0" }],
    ["bad user", { userId: " 8" }],
    ["bad chat", { chatId: "08" }],
  ])("rejects %s", (_label, overrides) => {
    const store = new FileTelegramAdmissionStore(path.join(root(), "store"))
    expect(() => store.capture(message(overrides), "CODE")).toThrow("invalid")
  })

  it("rejects every persisted record invariant and mismatched canonical filenames", () => {
    const storeRoot = path.join(root(), "store")
    const store = new FileTelegramAdmissionStore(storeRoot)
    const captured = store.capture(message(), "CODE")
    if (!("record" in captured)) throw new Error("fixture capture failed")
    const file = path.join(storeRoot, `${captured.record.id}.json`)
    const valid = JSON.parse(fs.readFileSync(file, "utf8")) as TelegramAdmissionRecord
    const mutants: unknown[] = [
      null, [], {},
      { ...valid, schemaVersion: 2 }, { ...valid, id: "bad" }, { ...valid, revision: 1.5 }, { ...valid, revision: -1 },
      { ...valid, status: "unknown" }, { ...valid, botId: 7 }, { ...valid, botId: "0" }, { ...valid, userId: 8 },
      { ...valid, userId: "08" }, { ...valid, chatId: 8 }, { ...valid, chatId: " 8" }, { ...valid, updateId: 1.5 },
      { ...valid, updateId: -1 }, { ...valid, messageId: 1.5 }, { ...valid, messageId: 0 },
      { ...valid, quarantinedText: 1 }, { ...valid, contentDigest: 1 }, { ...valid, contentDigest: "f" },
      { ...valid, displayLabel: 1 }, { ...valid, displayLabel: "x".repeat(121) }, { ...valid, displayCode: 1 },
      { ...valid, displayCode: "abc" }, { ...valid, displayCode: "x".repeat(33) }, { ...valid, hasAttachments: "no" },
      { ...valid, createdAt: 1.5 }, { ...valid, updatedAt: 1.5 }, { ...valid, expiresAt: 1.5 },
      { ...valid, friendId: 1 }, { ...valid, friendId: "" }, { ...valid, acknowledgementArtifactId: 1 },
      { ...valid, ownerCardArtifactId: 1 }, { ...valid, status: "denied", quarantinedText: "must purge" },
    ]
    for (const mutant of mutants) {
      fs.writeFileSync(file, JSON.stringify(mutant))
      expect(() => store.read(captured.record.id)).toThrow("invalid")
    }
    fs.writeFileSync(file, JSON.stringify(valid))
    const otherId = "c".repeat(20)
    fs.copyFileSync(file, path.join(storeRoot, `${otherId}.json`))
    expect(() => store.read(otherId)).toThrow("invalid")
  })

  it("rejects corrupt self-health and reports shared lease contention without consuming input", async () => {
    const storeRoot = path.join(root(), "store")
    const store = new FileTelegramAdmissionStore(storeRoot)
    fs.writeFileSync(path.join(storeRoot, "self-health.json"), JSON.stringify({ schemaVersion: 1, code: "wrong", count: 0, lastObservedAt: 0 }))
    expect(() => store.readSelfHealth()).toThrow("self-health is invalid")
    fs.rmSync(path.join(storeRoot, "self-health.json"))
    const lease = await acquireSessionTurnLease(path.join(path.dirname(storeRoot), ".store-coordination", "admission"))
    try { expect(() => store.capture(message(), "CODE")).toThrow("busy") } finally { await lease.release() }
  })

  it("pins the admission directory identity and rejects root replacement", () => {
    const parent = root()
    const storeRoot = path.join(parent, "store")
    const store = new FileTelegramAdmissionStore(storeRoot)
    const captured = store.capture(message(), "CODE")
    if (!("record" in captured)) throw new Error("fixture capture failed")
    fs.renameSync(storeRoot, path.join(parent, "displaced"))
    fs.mkdirSync(storeRoot, { mode: 0o700 })
    expect(() => store.read(captured.record.id)).toThrow("root identity changed")
    expect(() => store.capture(message({ updateId: 2 }), "CODE")).toThrow("root identity changed")
    store.close()
    expect(() => store.list()).toThrow("closed")
  })

  it("covers terminal replay, cooldown, CAS mismatch, and effect recording guards", () => {
    let now = 1_000
    const store = new FileTelegramAdmissionStore(path.join(root(), "store"), { retryCooldownMs: 10 }, () => now)
    const captured = store.capture(message(), "CODE")
    if (!("record" in captured)) throw new Error("fixture capture failed")
    expect(() => store.compareAndSwap({ admissionId: captured.record.id, expectedStatus: "approved", nextStatus: "handled" })).toThrow("CAS failed")
    const denied = store.compareAndSwap({ admissionId: captured.record.id, expectedStatus: "pending", nextStatus: "denied" })
    expect(store.recordEffect(denied.id, "acknowledgement", "ignored")).toEqual(denied)
    expect(store.capture(message(), "CODE")).toEqual({ kind: "blocked" })
    now += 11
    expect(store.capture(message(), "CODE")).toEqual({ kind: "blocked" })
    const second = store.capture(message({ updateId: 2 }), "CODE")
    expect(second).toMatchObject({ kind: "created" })
    if (!("record" in second)) throw new Error("fixture capture failed")
    expect(store.compareAndSwap({
      admissionId: second.record.id,
      expectedStatus: "pending",
      nextStatus: "approved",
      friendId: "friend",
      acknowledgementArtifactId: "ack",
      ownerCardArtifactId: "card",
    })).toMatchObject({ friendId: "friend", acknowledgementArtifactId: "ack", ownerCardArtifactId: "card" })
  })

  it("sorts multiple records for one identity and preserves a permanent block", () => {
    let now = 1_000
    const store = new FileTelegramAdmissionStore(path.join(root(), "store"), { retryCooldownMs: 1 }, () => now)
    const first = store.capture(message(), "CODE")
    if (!("record" in first)) throw new Error("fixture capture failed")
    store.compareAndSwap({ admissionId: first.record.id, expectedStatus: "pending", nextStatus: "denied" })
    now += 2
    const second = store.capture(message({ updateId: 2 }), "CODE")
    if (!("record" in second)) throw new Error("fixture capture failed")
    store.compareAndSwap({ admissionId: second.record.id, expectedStatus: "pending", nextStatus: "blocked" })
    now += 2
    expect(store.capture(message({ updateId: 3 }), "CODE")).toEqual({ kind: "blocked" })
  })

  it("repairs each missing effect, uses defaults, handles attachments, and expires on decision", async () => {
    let now = 1_000
    const store = new FileTelegramAdmissionStore(path.join(root(), "store"), { retentionMs: 10 }, () => now)
    const effects: unknown[] = []
    const controller = createTelegramAdmissionController({
      store,
      owner: { friendId: "ari", sessionKey: "telegram:ari", chatId: "42" },
      sendEffect: vi.fn(async (effect) => { effects.push(effect); return `effect-${effects.length}` }),
      claimFriend: vi.fn(async () => ({ kind: "created" as const, friendId: "friend" })),
      revokeFriend: vi.fn(async () => ({ kind: "revoked" as const })),
      commitApprovedIngress: vi.fn(async (turn) => ({ admissionId: turn.admissionId, friendId: turn.friendId, sessionKey: "telegram:friend", eventId: "evt-000001", reference: `telegram-admission:${turn.admissionId}` })),
      enqueueApprovedWork: vi.fn(async () => undefined),
      dispatchApprovedWork: vi.fn(async () => "settled" as const),
    })
    const pending = await controller.handleUnknown(message({ displayLabel: "", hasAttachments: true }))
    expect(JSON.stringify(effects)).toContain("Attachments were not downloaded")
    if (pending.kind !== "pending") throw new Error("fixture capture failed")
    now = 1_011
    await expect(controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })).rejects.toThrow("terminal")
  })

  it("resumes a decision already moved beyond pending and repairs pending effects on recovery", async () => {
    const store = new FileTelegramAdmissionStore(path.join(root(), "store"))
    const sendEffect = vi.fn(async () => "effect")
    const queue = vi.fn(async () => undefined)
    const controller = createTelegramAdmissionController({
      store,
      owner: { friendId: "ari", sessionKey: "telegram:ari", chatId: "42" },
      sendEffect,
      claimFriend: vi.fn(async () => ({ kind: "created" as const, friendId: "friend" })),
      revokeFriend: vi.fn(async () => ({ kind: "revoked" as const })),
      commitApprovedIngress: vi.fn(async (turn) => ({ admissionId: turn.admissionId, friendId: turn.friendId, sessionKey: "telegram:friend", eventId: "evt-000001", reference: `telegram-admission:${turn.admissionId}` })),
      enqueueApprovedWork: vi.fn(async () => undefined),
      dispatchApprovedWork: queue,
      createDisplayCode: () => "CODE",
    })
    const pending = store.capture(message(), "CODE")
    if (!("record" in pending)) throw new Error("fixture capture failed")
    store.compareAndSwap({ admissionId: pending.record.id, expectedStatus: "pending", nextStatus: "approved" })
    await controller.decide({ admissionId: pending.record.id, decision: "allow", actorFriendId: "ari" })
    expect(queue).toHaveBeenCalledOnce()

    const other = store.capture(message({ userId: "999", chatId: "999", updateId: 3 }), "CODE")
    if (!("record" in other)) throw new Error("fixture capture failed")
    await controller.recover()
    expect(sendEffect).toHaveBeenCalledTimes(2)
  })

  it("fails closed on ambiguous display codes and Friends revocation collisions", async () => {
    const store = new FileTelegramAdmissionStore(path.join(root(), "store"))
    const controller = createTelegramAdmissionController({
      store,
      owner: { friendId: "ari", sessionKey: "telegram:ari", chatId: "42" },
      sendEffect: vi.fn(async () => "effect"),
      claimFriend: vi.fn(async () => ({ kind: "created" as const, friendId: "friend" })),
      revokeFriend: vi.fn(async () => ({ kind: "collision" as const, reason: "identity changed" })),
      commitApprovedIngress: vi.fn(async (turn) => ({ admissionId: turn.admissionId, friendId: turn.friendId, sessionKey: "telegram:friend", eventId: "evt-000001", reference: `telegram-admission:${turn.admissionId}` })),
      enqueueApprovedWork: vi.fn(async () => undefined),
      dispatchApprovedWork: vi.fn(async () => "settled" as const),
      createDisplayCode: () => "SAME-1234",
    })
    const first = await controller.handleUnknown(message())
    await controller.handleUnknown(message({ userId: "999", chatId: "999", updateId: 2 }))
    expect(() => controller.parseOwnerDecision("Allow SAME-1234")).toThrow("ambiguous")
    if (first.kind !== "pending") throw new Error("fixture capture failed")
    await controller.decide({ admissionId: first.admissionId, decision: "allow", actorFriendId: "ari" })
    await expect(controller.decide({ admissionId: first.admissionId, decision: "block", actorFriendId: "ari" })).rejects.toThrow("revocation collision")
    expect(store.read(first.admissionId).status).toBe("handled")
  })
})
