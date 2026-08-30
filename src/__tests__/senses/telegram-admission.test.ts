import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FIXED_ADMISSION_ACKNOWLEDGEMENT,
  createTelegramAdmissionController,
  FileTelegramAdmissionStore,
  type TelegramAdmissionEffectRequest,
} from "../../senses/telegram-admission"
import { createTelegramLongPoll, type TelegramBotApi, type TelegramUpdate } from "../../senses/telegram-client"

const roots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-admission-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const unknown = (overrides: Partial<{
  updateId: number
  messageId: number
  botId: string
  userId: string
  chatId: string
  text: string
  displayLabel: string
  hasAttachments: boolean
}> = {}) => ({
  updateId: 11,
  messageId: 22,
  botId: "777",
  userId: "888",
  chatId: "888",
  text: "<script>steal()</script> https://evil.invalid/?token=secret",
  displayLabel: "<b>Definitely Ari's brother</b>",
  hasAttachments: false,
  ...overrides,
})

function fixture(input: {
  root?: string
  now?: () => number
  limits?: ConstructorParameters<typeof FileTelegramAdmissionStore>[1]
  claim?: ReturnType<typeof vi.fn>
  revoke?: ReturnType<typeof vi.fn>
  queue?: ReturnType<typeof vi.fn>
  sendEffect?: (request: TelegramAdmissionEffectRequest) => Promise<string>
} = {}) {
  const root = input.root ?? temporaryRoot()
  const effects: TelegramAdmissionEffectRequest[] = []
  const claim = input.claim ?? vi.fn(async () => ({ kind: "created", friendId: "friend-1" }))
  const queue = input.queue ?? vi.fn(async () => "settled" as const)
  const commit = vi.fn(async (turn) => ({ admissionId: turn.admissionId, friendId: turn.friendId, sessionKey: `telegram:${turn.userId}`, eventId: "evt-000001", reference: `telegram-admission:${turn.admissionId}` }))
  const enqueue = vi.fn(async () => undefined)
  const store = new FileTelegramAdmissionStore(path.join(root, "admission"), input.limits, input.now)
  const controller = createTelegramAdmissionController({
    store,
    owner: { friendId: "ari", sessionKey: "telegram:ari" },
    sendEffect: vi.fn(async (request: TelegramAdmissionEffectRequest) => {
      effects.push(structuredClone(request))
      if (input.sendEffect) return input.sendEffect(request)
      return `artifact-${effects.length}`
    }),
    resolveOwnerCard: (messageId) => {
      const effect = effects[messageId - 101]
      return effect?.target.kind === "approved_relationship" && effect.target.requestId
        ? { artifactId: `artifact-${messageId - 100}`, admissionId: effect.target.requestId }
        : null
    },
    resolveOwnerCardMessageId: (artifactId) => artifactId === "artifact-2" ? 102 : null,
    claimFriend: claim,
    revokeFriend: input.revoke ?? vi.fn(async () => ({ kind: "revoked" as const })),
    commitApprovedIngress: commit,
    enqueueApprovedWork: enqueue,
    dispatchApprovedWork: queue,
    now: input.now,
    createDisplayCode: () => "PINE-4821",
  })
  return { root, store, controller, effects, claim, commit, enqueue, queue }
}

describe("Telegram household admission", () => {
  it("quarantines hostile unknown content before model/session work and emits only fixed typed effects", async () => {
    const runTurn = vi.fn()
    const value = fixture({ queue: runTurn })
    const result = await value.controller.handleUnknown(unknown())

    expect(result.kind).toBe("pending")
    expect(FIXED_ADMISSION_ACKNOWLEDGEMENT).toContain("unread and unprocessed")
    expect(runTurn).not.toHaveBeenCalled()
    expect(value.effects).toHaveLength(2)
    expect(value.effects[0]).toEqual({
      idempotencyKey: `ack:${result.admissionId}`,
      target: { kind: "admission_gate", admissionId: result.admissionId, botId: "777", userId: "888", chatId: "888" },
      authorClass: "control",
      effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT },
    })
    expect(value.effects[1]).toMatchObject({
      idempotencyKey: `owner-card:${result.admissionId}`,
      target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:ari", requestId: result.admissionId },
      authorClass: "control",
      effect: {
        kind: "card",
        buttons: [[
          { text: "Allow", callbackData: `admit:${result.admissionId}:allow` },
          { text: "Deny", callbackData: `admit:${result.admissionId}:deny` },
          { text: "Block", callbackData: `admit:${result.admissionId}:block` },
        ]],
      },
    })
    expect((value.effects[1]!.effect as { text: string }).text).toContain("Unverified Telegram label: &lt;b&gt;Definitely Ari&#39;s brother&lt;/b&gt;")
    expect((value.effects[1]!.effect as { text: string }).text).toContain("PINE-4821")
    expect(JSON.stringify(value.effects)).not.toContain("steal()")

    const record = value.store.read(result.admissionId)
    expect(record.quarantinedText).toContain("steal()")
    expect(record.hasAttachments).toBe(false)
    expect(fs.statSync(path.join(value.root, "admission")).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(value.root, "admission", `${result.admissionId}.json`)).mode & 0o777).toBe(0o600)
  })

  it("emits one acknowledgement and one owner card for replayed or repeated pending contact", async () => {
    const value = fixture()
    const first = await value.controller.handleUnknown(unknown())
    const replay = await value.controller.handleUnknown(unknown())
    const repeated = await value.controller.handleUnknown(unknown({ updateId: 12, messageId: 23, text: "second payload" }))
    expect(replay).toEqual(first)
    expect(repeated).toEqual(first)
    expect(value.effects).toHaveLength(2)
    expect(value.store.read(first.admissionId).quarantinedText).not.toContain("second payload")
  })

  it("allows exactly one real user turn after an atomic Friend claim and survives decision replay", async () => {
    const value = fixture()
    const pending = await value.controller.handleUnknown(unknown())
    await value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })
    await value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })
    expect(value.claim).toHaveBeenCalledTimes(1)
    expect(value.claim).toHaveBeenCalledWith(expect.objectContaining({ provider: "telegram-user", botId: "777", userId: "888", chatId: "888" }))
    expect(value.queue).toHaveBeenCalledTimes(1)
    expect(value.queue).toHaveBeenCalledWith(expect.objectContaining({ friendId: "friend-1", eventId: "evt-000001", reference: `telegram-admission:${pending.admissionId}`, orientation: { kind: "newly_admitted", instruction: "welcome_and_explain_capabilities", attachmentsNeedResend: false } }))
    expect(value.store.read(pending.admissionId)).toMatchObject({ status: "handled", quarantinedText: null, friendId: "friend-1" })
    expect(value.effects.at(-1)).toMatchObject({
      idempotencyKey: `owner-card-terminal:${pending.admissionId}:handled`,
      effect: { kind: "edit", messageId: 102, text: "Allowed" },
    })
    expect(value.effects.filter((effect) => effect.effect.kind === "edit")).toHaveLength(1)
  })

  it("commits the session event before reference-only enqueue and fences an indeterminate dispatch with Friends revocation", async () => {
    const order: string[] = []
    const revoke = vi.fn(async () => { order.push("revoke"); return { kind: "revoked" as const } })
    const value = fixture({ revoke, queue: vi.fn(async () => { order.push("dispatch"); return "indeterminate" as const }) })
    value.commit.mockImplementation(async (turn) => {
      order.push("commit")
      return { admissionId: turn.admissionId, friendId: turn.friendId, sessionKey: `telegram:${turn.userId}`, eventId: "evt-000001", reference: `telegram-admission:${turn.admissionId}` }
    })
    value.enqueue.mockImplementation(async () => { order.push("enqueue") })
    const pending = await value.controller.handleUnknown(unknown())
    await value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })
    expect(order).toEqual(["commit", "enqueue", "dispatch", "revoke"])
    expect(value.store.read(pending.admissionId)).toMatchObject({ status: "indeterminate", quarantinedText: null, ingressEventId: "evt-000001" })
    await expect(value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })).resolves.toMatchObject({ status: "indeterminate" })
  })

  it("compensates Friends and terminalizes when dispatch throws after claim", async () => {
    const revoke = vi.fn(async () => ({ kind: "revoked" as const }))
    const value = fixture({ revoke, queue: vi.fn(async () => { throw new Error("worker crashed") }) })
    const pending = await value.controller.handleUnknown(unknown())
    await expect(value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })).rejects.toThrow("worker crashed")
    expect(revoke).toHaveBeenCalledOnce()
    expect(value.store.read(pending.admissionId)).toMatchObject({ status: "indeterminate", quarantinedText: null })
  })

  it("parses only strict owner display-code decisions and routes revocation through Friends", async () => {
    const value = fixture()
    const pending = await value.controller.handleUnknown(unknown())
    expect(value.controller.parseOwnerDecision({ text: "let them in", replyToMessageId: 102 })).toEqual({ admissionId: pending.admissionId, decision: "allow" })
    expect(value.controller.parseOwnerDecision({ text: "allow" })).toBeNull()
    expect(value.controller.parseOwnerDecision({ text: "please allow them", replyToMessageId: 102 })).toBeNull()
    expect(value.controller.parseOwnerDecision({ text: "yes", replyToMessageId: 999 })).toBeNull()
    await value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })
    expect(value.controller.parseOwnerDecision({ text: "block them", replyToMessageId: 102 })).toBeNull()
    await value.controller.decide({ admissionId: pending.admissionId, decision: "block", actorFriendId: "ari" })
    expect(value.store.read(pending.admissionId).status).toBe("handled")
  })

  it("acknowledges stale handled decisions without changing the admitted Friend", async () => {
    const revoke = vi.fn(async () => ({ kind: "revoked" as const }))
    const value = fixture({ revoke })
    const pending = await value.controller.handleUnknown(unknown())
    await value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })
    await value.controller.decide({ admissionId: pending.admissionId, decision: "block", actorFriendId: "ari" })
    expect(revoke).not.toHaveBeenCalled()
    expect(value.store.read(pending.admissionId).status).toBe("handled")
  })

  it("recovers approved, friend-bound, committed, and queued crash points without duplicating the turn", async () => {
    for (const state of ["approved", "friend_bound", "ingress_committed", "turn_queued"] as const) {
      const root = temporaryRoot()
      const queue = vi.fn(async () => undefined)
      const first = fixture({ root, queue })
      const pending = await first.controller.handleUnknown(unknown({ userId: String(900 + state.length), chatId: String(900 + state.length) }))
      if (state === "approved") first.store.compareAndSwap({ admissionId: pending.admissionId, expectedStatus: "pending", nextStatus: "approved" })
      else {
        first.store.compareAndSwap({ admissionId: pending.admissionId, expectedStatus: "pending", nextStatus: "approved" })
        first.store.compareAndSwap({ admissionId: pending.admissionId, expectedStatus: "approved", nextStatus: "friend_bound", friendId: "friend-1" })
        if (state === "ingress_committed" || state === "turn_queued") {
          first.store.compareAndSwap({ admissionId: pending.admissionId, expectedStatus: "friend_bound", nextStatus: "ingress_committed", ingress: {
            sessionKey: `telegram:${900 + state.length}`,
            eventId: "evt-000001",
            reference: `telegram-admission:${pending.admissionId}`,
          } })
        }
        if (state === "turn_queued") {
          first.store.compareAndSwap({ admissionId: pending.admissionId, expectedStatus: "ingress_committed", nextStatus: "turn_queued" })
        }
      }
      const restarted = fixture({ root, queue })
      await restarted.controller.recover()
      expect(queue).toHaveBeenCalledTimes(1)
      expect(restarted.store.read(pending.admissionId).status).toBe("handled")
    }
  })

  it("fails closed on Friend collisions and purges raw content", async () => {
    const value = fixture({ claim: vi.fn(async () => ({ kind: "collision", reason: "ambiguous identity" })) })
    const pending = await value.controller.handleUnknown(unknown())
    await expect(value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })).rejects.toThrow("collision")
    expect(value.queue).not.toHaveBeenCalled()
    expect(value.store.read(pending.admissionId)).toMatchObject({ status: "collision", quarantinedText: null })
  })

  it.each(["deny", "block"] as const)("%s is single-use and immediately purges quarantined content", async (decision) => {
    const value = fixture()
    const pending = await value.controller.handleUnknown(unknown())
    await value.controller.decide({ admissionId: pending.admissionId, decision, actorFriendId: "ari" })
    const record = value.store.read(pending.admissionId)
    expect(record.quarantinedText).toBeNull()
    expect(record.status).toBe(decision === "deny" ? "denied" : "blocked")
    await expect(value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })).resolves.toMatchObject({ status: decision === "deny" ? "denied" : "blocked" })
    expect(value.effects.at(-1)).toMatchObject({ effect: { kind: "edit", messageId: 102, text: decision === "deny" ? "Denied" : "Blocked" } })
  })

  it("expires to denial, purges content, and never replays it", async () => {
    let now = 1_000
    const value = fixture({ now: () => now, limits: { retentionMs: 100 } })
    const pending = await value.controller.handleUnknown(unknown())
    now = 1_101
    await value.controller.reconcileExpired()
    expect(value.store.read(pending.admissionId)).toMatchObject({ status: "expired", quarantinedText: null })
    await expect(value.controller.decide({ admissionId: pending.admissionId, decision: "allow", actorFriendId: "ari" })).resolves.toMatchObject({ status: "expired" })
  })

  it("reconciles a terminal owner-card edit that failed before restart", async () => {
    const root = temporaryRoot()
    let initialEffects = 0
    const first = fixture({ root, sendEffect: async (request) => {
      if (request.effect.kind === "edit") throw new Error("edit unavailable")
      initialEffects += 1
      return `artifact-${initialEffects}`
    } })
    const pending = await first.controller.handleUnknown(unknown({ userId: "991", chatId: "991" }))
    await expect(first.controller.decide({ admissionId: pending.admissionId, decision: "deny", actorFriendId: "ari" })).rejects.toThrow("edit unavailable")
    expect(first.store.read(pending.admissionId).status).toBe("denied")

    const retried: TelegramAdmissionEffectRequest[] = []
    const restarted = fixture({ root, sendEffect: async (request) => { retried.push(request); return "terminal-artifact" } })
    await restarted.controller.recover()
    expect(retried).toContainEqual(expect.objectContaining({
      idempotencyKey: `owner-card-terminal:${pending.admissionId}:denied`,
      effect: { kind: "edit", messageId: 102, text: "Denied" },
    }))
    await restarted.controller.decide({ admissionId: pending.admissionId, decision: "deny", actorFriendId: "ari" })
    expect(retried).toHaveLength(1)
  })

  it("bounds pending contacts, per-identity messages, bytes, and records overflow without hostile content", async () => {
    const value = fixture({ limits: { maxPendingContacts: 1, maxTextBytes: 16, maxMessagesPerIdentity: 1, maxTotalBytes: 16 } })
    const tooLarge = await value.controller.handleUnknown(unknown({ userId: "889", chatId: "889", text: "x".repeat(17) }))
    expect(tooLarge.kind).toBe("overflow")
    const accepted = await value.controller.handleUnknown(unknown({ text: "small" }))
    expect(accepted.kind).toBe("pending")
    const overflow = await value.controller.handleUnknown(unknown({ userId: "999", chatId: "999", text: "other" }))
    expect(overflow.kind).toBe("overflow")
    expect(value.effects).toHaveLength(2)
    expect(JSON.stringify(value.store.readSelfHealth())).not.toContain("evil.invalid")
    expect(value.store.readSelfHealth()).toMatchObject({ code: "telegram_admission_overflow", count: 2 })
  })

  it("enforces replay-safe per-identity and global rate windows and resets at the exact boundary", () => {
    let now = 1_000
    const store = new FileTelegramAdmissionStore(path.join(temporaryRoot(), "admission"), {
      maxMessagesPerIdentity: 2,
      maxMessagesPerWindow: 3,
      rateWindowMs: 100,
      maxPendingContacts: 10,
    }, () => now)
    expect(store.capture(unknown({ updateId: 1 }), "CODE").kind).toBe("created")
    expect(store.capture(unknown({ updateId: 1 }), "CODE").kind).toBe("existing")
    expect(store.capture(unknown({ updateId: 2 }), "CODE").kind).toBe("existing")
    expect(store.capture(unknown({ updateId: 3 }), "CODE")).toEqual({ kind: "overflow" })
    expect(store.capture(unknown({ updateId: 4, userId: "999", chatId: "999" }), "CODE")).toEqual({ kind: "overflow" })
    now = 1_101
    expect(store.capture(unknown({ updateId: 5, userId: "999", chatId: "999" }), "CODE").kind).toBe("created")
  })

  it("compacts terminal records to a hard total bound", () => {
    let now = 1_000
    const admissionRoot = path.join(temporaryRoot(), "admission")
    const store = new FileTelegramAdmissionStore(admissionRoot, {
      maxTerminalRecords: 2,
      terminalRetentionMs: 10_000,
      maxMessagesPerWindow: 100,
      maxPendingContacts: 10,
    }, () => now)
    for (let index = 0; index < 3; index++) {
      const captured = store.capture(unknown({ updateId: index + 1, userId: String(900 + index), chatId: String(900 + index) }), `CODE-${index}`)
      if (!("record" in captured)) throw new Error("fixture capture failed")
      store.compareAndSwap({ admissionId: captured.record.id, expectedStatus: "pending", nextStatus: "denied" })
      now += 1
    }
    expect(store.capture(unknown({ updateId: 10, userId: "999", chatId: "999" }), "CODE-X").kind).toBe("created")
    expect(store.list().filter((record) => record.status === "denied")).toHaveLength(2)
    expect(fs.readdirSync(admissionRoot).filter((name) => /^[a-f0-9]{20}\.json$/u.test(name))).toHaveLength(3)
  })

  it("rejects symlink roots, corrupt records, non-owner decisions, and callback collisions", async () => {
    const root = temporaryRoot()
    const target = path.join(root, "real"); fs.mkdirSync(target)
    const link = path.join(root, "link"); fs.symlinkSync(target, link)
    expect(() => new FileTelegramAdmissionStore(link)).toThrow("symbolic link")

    const value = fixture()
    const pending = await value.controller.handleUnknown(unknown())
    fs.writeFileSync(path.join(value.root, "admission", `${pending.admissionId}.json`), "{}")
    expect(() => value.store.read(pending.admissionId)).toThrow("invalid")

    const owner = fixture()
    const ownerPending = await owner.controller.handleUnknown(unknown({ userId: "889", chatId: "889" }))
    await expect(owner.controller.decide({ admissionId: ownerPending.admissionId, decision: "allow", actorFriendId: "not-ari" })).rejects.toThrow("owner")
    expect(() => owner.controller.parseCallback(`admit:${ownerPending.admissionId}:allow:extra`, 102)).toThrow("invalid")
  })

  it("generalizes long polling so unknown private content is durably routed to admission, never dropped or modeled", async () => {
    const update: TelegramUpdate = { update_id: 7, message: {
      message_id: 9,
      from: { id: 888, first_name: "<Unknown>" },
      chat: { id: 888, type: "private" },
      text: "hostile https://evil.invalid",
      entities: [{ type: "url", offset: 8, length: 20 }],
      document: { file_id: "do-not-download" },
    } }
    const api: TelegramBotApi = { request: vi.fn(async () => [update]), stop: vi.fn() }
    const owner = vi.fn()
    const stranger = vi.fn()
    const inbox = { load: vi.fn(() => []), loadPending: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), quarantineStranded: vi.fn(() => []), acknowledgeIndeterminateWarning: vi.fn(), capture: vi.fn(() => true), claim: vi.fn(() => true), complete: vi.fn(), commit: vi.fn() }
    const poll = createTelegramLongPoll({
      api,
      expectedUserId: "42",
      expectedChatId: "42",
      botId: "777",
      offsetStore: { load: () => 0, save: vi.fn() },
      inboxStore: inbox,
      onMessage: owner,
      onUnknownMessage: stranger,
    })
    await poll.pollOnce()
    expect(owner).not.toHaveBeenCalled()
    expect(stranger).toHaveBeenCalledWith(expect.objectContaining({ botId: "777", userId: "888", chatId: "888", text: "hostile https://evil.invalid", hasAttachments: true, displayLabel: "<Unknown>" }))
    expect(inbox.capture).toHaveBeenCalledWith(update)
    expect(inbox.complete).toHaveBeenCalledWith(update)
  })

  it("rejects a non-owner admission callback before the generic update handler can act", async () => {
    const update: TelegramUpdate = { update_id: 8, callback_query: {
      id: "hostile-callback",
      from: { id: 888 },
      data: `admit:${"a".repeat(20)}:allow`,
      message: { message_id: 101, chat: { id: 42 } },
    } }
    const onUpdate = vi.fn(async () => true)
    const offsetSave = vi.fn()
    const poll = createTelegramLongPoll({
      api: { request: vi.fn(async () => [update]), stop: vi.fn() },
      expectedUserId: "42",
      expectedChatId: "42",
      botId: "777",
      offsetStore: { load: () => 0, save: offsetSave },
      onMessage: vi.fn(),
      onUnknownMessage: vi.fn(),
      onUpdate,
    })

    await poll.pollOnce()

    expect(onUpdate).not.toHaveBeenCalled()
    expect(offsetSave).toHaveBeenCalledWith(9)
  })
})
