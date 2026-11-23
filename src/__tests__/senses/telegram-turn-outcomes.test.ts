import { createHash, createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../nerves/runtime"
import { openInboundJournal, readInboundOutcome, type InboundOutcomeRecord, type PendingInbound } from "../../senses/inbound-journal"
import { createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import type { TelegramBotApi, TelegramInboundMessage, TelegramLongPoll, TelegramLongPollOptions, TelegramUpdate } from "../../senses/telegram-client"
import { FileTelegramEffectJournal, abandonTelegramEffect, prepareTelegramEffect, recoverTelegramEffectOutbox } from "../../senses/telegram-effect-adapter"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-turn-outcomes-"))
  roots.push(root)
  return root
}

const never = (): Promise<never> => new Promise(() => undefined)

type RunTurn = (options: any) => Promise<unknown>

const reply = (text: string): RunTurn => async (options) => {
  await options.deliverySink.onDelivery({ kind: "settle", text })
  return { response: text, ponderDeferred: false, deliveries: [{ kind: "settle", text }], deliveryFailures: [] }
}

/** One Butler process on `agentRoot`. A second call on the same root is the process that starts after a crash. */
function butler(agentRoot: string, runTurn: RunTurn, api?: TelegramBotApi) {
  let pollOptions: any
  const poll: TelegramLongPoll = { pollOnce: vi.fn(async () => 0), run: vi.fn(async () => undefined), stop: vi.fn() }
  const telegram: TelegramBotApi = api ?? { request: vi.fn(async () => ({ message_id: 71 })) as TelegramBotApi["request"], stop: vi.fn() }
  const turn = vi.fn(runTurn)
  const app = createTelegramSenseApp({
    agentName: "butler",
    credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
    identityKey: "k".repeat(43),
    migrateIdentity: async () => undefined,
    api: telegram,
    offsetStore: { load: () => 0, save: vi.fn() },
    createLongPoll: vi.fn((options: any) => { pollOptions = options; return poll }),
    runTurn: turn,
    _agentRoot: agentRoot,
  } as any)
  return {
    app,
    api: telegram,
    runTurn: turn,
    onMessage: (message: TelegramInboundMessage): Promise<void> => pollOptions.onMessage(message),
    replay: async (update: TelegramUpdate, reclaim: () => boolean = () => true): Promise<boolean> => pollOptions.replayIndeterminate(update, reclaim),
  }
}

const message = (updateId: number, text = "what's up?"): TelegramInboundMessage => ({ updateId, messageId: String(updateId + 1000), userId: "42", chatId: "42", text })
const redelivered = (updateId: number): TelegramUpdate => ({ update_id: updateId, message: { message_id: updateId + 1000, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "what's up?" } })

function journalFiles<T>(agentRoot: string, folder: "pending-inbound" | "inbound-outcomes"): T[] {
  const dir = path.join(agentRoot, "state", "senses", "telegram", folder)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as T)
}
const outcomes = (agentRoot: string) => journalFiles<InboundOutcomeRecord>(agentRoot, "inbound-outcomes")
const pending = (agentRoot: string) => journalFiles<PendingInbound<unknown>>(agentRoot, "pending-inbound")
const sends = (api: TelegramBotApi) => vi.mocked(api.request).mock.calls.filter(([method]) => method === "sendMessage")

function emitted(name: string): unknown[] {
  return vi.mocked(nerves.emitNervesEvent).mock.calls.map(([event]) => event).filter((event) => event.event === name)
}

describe("Telegram turn outcomes", () => {
  it("records a turn that replied as answered, keeping nothing the person wrote", async () => {
    const root = newRoot()
    const b = butler(root, reply("All systems nominal."))
    await b.onMessage(message(7, "a private question"))
    expect(outcomes(root)).toEqual([expect.objectContaining({ sense: "telegram", outcome: "answered", attempts: 1 })])
    expect(pending(root)).toEqual([])
    const dir = path.join(root, "state", "senses", "telegram")
    for (const folder of ["pending-inbound", "inbound-outcomes"]) {
      for (const name of fs.readdirSync(path.join(dir, folder))) {
        const text = fs.readFileSync(path.join(dir, folder, name), "utf8")
        for (const secret of ["a private question", "1007", '"7"']) expect(text).not.toContain(secret)
      }
    }
  })

  it("records a turn that sent nothing as silent", async () => {
    const root = newRoot()
    const b = butler(root, async () => ({ response: "", ponderDeferred: false, deliveries: [], deliveryFailures: [] }))
    await b.onMessage(message(8))
    expect(sends(b.api)).toEqual([])
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "silent" })])
  })

  it("records a turn that failed as failed, after telling the person", async () => {
    const root = newRoot()
    const b = butler(root, async () => { throw new TypeError("provider exploded") })
    await b.onMessage(message(9))
    expect(sends(b.api)).toHaveLength(1)
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed", detail: "the turn failed (TypeError)" })])
  })

  it("records a turn that could not even tell the person as failed, and still raises the error", async () => {
    const root = newRoot()
    const api: TelegramBotApi = {
      request: vi.fn(async (method: string) => {
        if (method === "sendMessage") throw new RangeError("telegram down")
        return true
      }) as TelegramBotApi["request"],
      stop: vi.fn(),
    }
    const b = butler(root, async () => { throw new TypeError("provider exploded") }, api)
    await expect(b.onMessage(message(10))).rejects.toThrow()
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed", detail: expect.stringMatching(/^the turn stopped with an error \(/) })])
  })

  it("runs a message again after a crash when nothing went out, and does not run one that has an outcome", async () => {
    const root = newRoot()
    const crashed = butler(root, never)
    void crashed.onMessage(message(11))
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    expect(pending(root)).toEqual([expect.objectContaining({ attempts: 1, spoke: false })])

    vi.spyOn(nerves, "emitNervesEvent")
    const restarted = butler(root, reply("Back, and all good."))
    expect(await restarted.replay(redelivered(11))).toBe(true)
    expect(emitted("senses.telegram_inbound_replaying")).toHaveLength(1)
    await restarted.onMessage(message(11))
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "answered", attempts: 2 })])

    expect(await restarted.replay(redelivered(11))).toBe(false)
    await restarted.onMessage(message(11))
    expect(restarted.runTurn).toHaveBeenCalledTimes(1)
  })

  it("records a message whose reply had started going out as failed instead of running it again", async () => {
    const root = newRoot()
    const crashed = butler(root, async (options) => {
      await options.deliverySink.onDelivery({ kind: "settle", text: "Half an answer" })
      return never()
    })
    void crashed.onMessage(message(12))
    await vi.waitFor(() => expect(sends(crashed.api)).toHaveLength(1))
    expect(pending(root)).toEqual([expect.objectContaining({ spoke: true })])

    const restarted = butler(root, reply("Again"))
    expect(await restarted.replay(redelivered(12))).toBe(false)
    expect(outcomes(root)).toEqual([expect.objectContaining({
      outcome: "failed", detail: "the turn stopped after a reply went out, so it is not run again",
    })])
    expect(sends(restarted.api)).toEqual([])
  })

  it("records a message as failed once it has used its three tries", async () => {
    const root = newRoot()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const crashed = butler(root, never)
      if (attempt > 0) expect(await crashed.replay(redelivered(13))).toBe(true)
      void crashed.onMessage(message(13))
      await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    }
    const restarted = butler(root, reply("Again"))
    expect(await restarted.replay(redelivered(13))).toBe(false)
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed", detail: "the turn did not finish in 3 attempts", attempts: 3 })])
  })

  it("also stops a message that comes back as new once the inbox forgot it", async () => {
    const root = newRoot()
    const crashed = butler(root, async (options) => {
      await options.deliverySink.onDelivery({ kind: "settle", text: "Half an answer" })
      return never()
    })
    void crashed.onMessage(message(14))
    await vi.waitFor(() => expect(sends(crashed.api)).toHaveLength(1))
    const restarted = butler(root, reply("Again"))
    await restarted.onMessage(message(14))
    expect(restarted.runTurn).not.toHaveBeenCalled()
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed" })])
  })

  it("notes a reply the outbox sends for a crashed turn, so that turn is not run again", async () => {
    const root = newRoot()
    const crashed = butler(root, never)
    void crashed.onMessage(message(15))
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    // The crashed turn had prepared its reply, but the send never happened.
    const subject = opaqueTelegramSubject("k".repeat(43), "test-token", "42", "42")
    const effects = new FileTelegramEffectJournal(path.join(root, "state", "telegram", "effects"))
    prepareTelegramEffect(effects, {
      idempotencyKey: `turn:${subject}:15:delivery:0`,
      target: { kind: "approved_relationship", friendId: `telegram-user:${subject}`, sessionKey: `telegram:${subject}` },
      authorClass: "butler",
      effect: { kind: "text", text: "Prepared before the crash" },
      authorization: { allowed: true, receiptId: `configured-owner:${subject}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), transport: { chatId: "42" } },
    })
    effects.close()

    const restarted = butler(root, reply("Again"))
    await restarted.app.run()
    expect(sends(restarted.api)).toHaveLength(1)
    expect(await restarted.replay(redelivered(15))).toBe(false)
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed" })])
  })

  it("counts a reply the outbox sends during another message's turn for the turn it belongs to", async () => {
    const root = newRoot()
    const crashed = butler(root, never)
    void crashed.onMessage(message(17))
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    const subject = opaqueTelegramSubject("k".repeat(43), "test-token", "42", "42")
    const effects = new FileTelegramEffectJournal(path.join(root, "state", "telegram", "effects"))
    prepareTelegramEffect(effects, {
      idempotencyKey: `turn:${subject}:17:delivery:0`,
      target: { kind: "approved_relationship", friendId: `telegram-user:${subject}`, sessionKey: `telegram:${subject}` },
      authorClass: "butler",
      effect: { kind: "text", text: "Prepared before the crash" },
      authorization: { allowed: true, receiptId: `configured-owner:${subject}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), transport: { chatId: "42" } },
    })
    effects.close()

    const restarted = butler(root, async () => ({ response: "", ponderDeferred: false, deliveries: [], deliveryFailures: [] }))
    await restarted.onMessage(message(18))
    expect(sends(restarted.api)).toHaveLength(1)
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "silent" })])
    expect(pending(root)).toEqual([expect.objectContaining({ spoke: true })])
  })

  it("records a message Telegram no longer redelivers as failed when the sense starts", async () => {
    const root = newRoot()
    const dayAgo = Date.now() - 25 * 60 * 60_000
    openInboundJournal(root, "telegram", { now: () => dayAgo }).record("telegram-update:old", { updateClass: "message" })
    // Only the old one is past Telegram's day of redelivery.
    openInboundJournal(root, "telegram").record("telegram-update:recent", { updateClass: "message" })
    const b = butler(root, reply("hi"))
    await b.app.run()
    expect(outcomes(root)).toEqual([expect.objectContaining({
      id: "telegram-update:old", outcome: "failed", detail: "Telegram stopped redelivering it after a day, so it was never answered",
    })])
    expect(pending(root)).toEqual([expect.objectContaining({ id: "telegram-update:recent" })])
  })

  it("still answers when the outcome records cannot be written", async () => {
    const root = newRoot()
    fs.mkdirSync(path.join(root, "state", "senses", "telegram"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "senses", "telegram", "pending-inbound"), "not a folder")
    vi.spyOn(nerves, "emitNervesEvent")
    const b = butler(root, reply("All systems nominal."))
    await b.onMessage(message(16))
    expect(sends(b.api)).toHaveLength(1)
    expect(emitted("senses.telegram_inbound_record_failed")).toEqual([expect.objectContaining({ level: "error" })])
    expect(await b.replay(redelivered(16))).toBe(false)
    await b.app.run()
    expect(emitted("senses.telegram_inbound_record_failed")).toHaveLength(3)
  })

  it("still raises a turn's error when its outcome records cannot be written", async () => {
    const root = newRoot()
    fs.mkdirSync(path.join(root, "state", "senses", "telegram"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "senses", "telegram", "pending-inbound"), "not a folder")
    const api: TelegramBotApi = {
      request: vi.fn(async (method: string) => {
        if (method === "sendMessage") throw new RangeError("telegram down")
        return true
      }) as TelegramBotApi["request"],
      stop: vi.fn(),
    }
    const b = butler(root, async () => { throw new TypeError("provider exploded") }, api)
    await expect(b.onMessage(message(32))).rejects.toThrow()
    expect(outcomes(root)).toEqual([])
  })

  it("logs a reply the outbox sends after a crash when its note cannot be written, and still sends it", async () => {
    const root = newRoot()
    const subject = opaqueTelegramSubject("k".repeat(43), "test-token", "42", "42")
    const effects = new FileTelegramEffectJournal(path.join(root, "state", "telegram", "effects"))
    prepareTelegramEffect(effects, {
      idempotencyKey: `turn:${subject}:19:delivery:0`,
      target: { kind: "approved_relationship", friendId: `telegram-user:${subject}`, sessionKey: `telegram:${subject}` },
      authorClass: "butler",
      effect: { kind: "text", text: "Prepared before the crash" },
      authorization: { allowed: true, receiptId: `configured-owner:${subject}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), transport: { chatId: "42" } },
    })
    effects.close()
    fs.mkdirSync(path.join(root, "state", "senses", "telegram"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "senses", "telegram", "pending-inbound"), "not a folder")
    vi.spyOn(nerves, "emitNervesEvent")
    const b = butler(root, reply("hi"))
    await b.app.run()
    expect(sends(b.api)).toHaveLength(1)
    expect(emitted("senses.telegram_inbound_record_failed").length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(process.getuid?.() === 0)("logs an outcome it cannot write instead of failing the turn", async () => {
    const root = newRoot()
    const outcomesDir = path.join(root, "state", "senses", "telegram", "inbound-outcomes")
    const b = butler(root, async (options) => {
      fs.chmodSync(outcomesDir, 0o500)
      return reply("All systems nominal.")(options)
    })
    vi.spyOn(nerves, "emitNervesEvent")
    try {
      await b.onMessage(message(20))
    } finally {
      fs.chmodSync(outcomesDir, 0o700)
    }
    expect(sends(b.api)).toHaveLength(1)
    expect(emitted("senses.telegram_inbound_record_failed")).toEqual([expect.objectContaining({ level: "error" })])
    expect(pending(root)).toEqual([expect.objectContaining({ spoke: true })])
  })

  it("counts a reaction or a file the turn sends as a reply, noting each before it goes out", async () => {
    const root = newRoot()
    const file = path.join(root, "menu.pdf")
    fs.writeFileSync(file, "%PDF-1.4 menu")
    const notedBeforeSend: Array<[string, boolean]> = []
    const api: TelegramBotApi = {
      request: vi.fn(async (method: string) => {
        if (method === "setMessageReaction" || method === "sendDocument") notedBeforeSend.push([method, pending(root)[0]!.spoke])
        return true
      }) as TelegramBotApi["request"],
      stop: vi.fn(),
    }
    const b = butler(root, async (options) => {
      await options.toolContext.chatActions.react("👍")
      return { response: "", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
    }, api)
    await b.onMessage(message(21))
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "answered" })])

    const files = butler(root, async (options) => {
      await options.toolContext.chatActions.sendFile(file, "")
      return { response: "", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
    }, api)
    await files.onMessage(message(22))
    expect(notedBeforeSend).toEqual([["setMessageReaction", true], ["sendDocument", true]])
    expect(outcomes(root).map((outcome) => outcome.outcome)).toEqual(["answered", "answered"])
  })

  it.skipIf(process.getuid?.() === 0)("sends nothing when a turn cannot note a send, and the outbox never sends it later", async () => {
    const root = newRoot()
    const pendingDir = path.join(root, "state", "senses", "telegram", "pending-inbound")
    const b = butler(root, async (options) => {
      fs.chmodSync(pendingDir, 0o500)
      return reply("This must not go out late.")(options)
    })
    try {
      await expect(b.onMessage(message(23))).rejects.toThrow()
    } finally {
      fs.chmodSync(pendingDir, 0o700)
    }
    expect(sends(b.api)).toEqual([])
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed" })])

    const restarted = butler(root, reply("Fine."))
    await restarted.app.run()
    await restarted.onMessage(message(24))
    expect(sends(restarted.api).map(([, body]) => (body as { text: string }).text)).toEqual(["Fine."])
  })

  it("runs a redelivered message that has no entry, because its turn never started", async () => {
    const root = newRoot()
    vi.spyOn(nerves, "emitNervesEvent")
    const b = butler(root, reply("Here now."))
    expect(await b.replay(redelivered(25))).toBe(true)
    expect(emitted("senses.telegram_inbound_replaying")).toEqual([expect.objectContaining({ meta: expect.objectContaining({ attempts: 0 }) })])
    await b.onMessage(message(25))
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "answered", attempts: 1 })])
  })

  it("records a redelivered message with no entry but a prepared reply as failed instead of running it", async () => {
    const root = newRoot()
    const subject = opaqueTelegramSubject("k".repeat(43), "test-token", "42", "42")
    const effects = new FileTelegramEffectJournal(path.join(root, "state", "telegram", "effects"))
    prepareTelegramEffect(effects, {
      idempotencyKey: `turn:${subject}:26:fallback`,
      target: { kind: "approved_relationship", friendId: `telegram-user:${subject}`, sessionKey: `telegram:${subject}` },
      authorClass: "butler",
      effect: { kind: "text", text: "Prepared while the record could not be written" },
      authorization: { allowed: true, receiptId: `configured-owner:${subject}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), transport: { chatId: "42" } },
    })
    effects.close()
    const b = butler(root, reply("Again"))
    expect(await b.replay(redelivered(26))).toBe(false)
    expect(outcomes(root)).toEqual([expect.objectContaining({
      outcome: "failed", detail: "a reply was prepared before it stopped, but its record could not be written, so it is not run again",
    })])
  })

  it("records a message the inbox could not take back as failed, without saying it runs again", async () => {
    const root = newRoot()
    const crashed = butler(root, never)
    void crashed.onMessage(message(27))
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    vi.spyOn(nerves, "emitNervesEvent")
    const restarted = butler(root, reply("Again"))
    expect(await restarted.replay(redelivered(27), () => false)).toBe(false)
    expect(emitted("senses.telegram_inbound_replaying")).toEqual([])
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed", detail: "it could not be taken back from the update inbox to run again" })])
  })

  it.skipIf(process.getuid?.() === 0)("logs a failure it cannot record for a redelivered message", async () => {
    const root = newRoot()
    const subject = opaqueTelegramSubject("k".repeat(43), "test-token", "42", "42")
    const effects = new FileTelegramEffectJournal(path.join(root, "state", "telegram", "effects"))
    prepareTelegramEffect(effects, {
      idempotencyKey: `turn:${subject}:31:delivery:0`,
      target: { kind: "approved_relationship", friendId: `telegram-user:${subject}`, sessionKey: `telegram:${subject}` },
      authorClass: "butler",
      effect: { kind: "text", text: "Prepared while the record could not be written" },
      authorization: { allowed: true, receiptId: `configured-owner:${subject}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), transport: { chatId: "42" } },
    })
    effects.close()
    const pendingDir = path.join(root, "state", "senses", "telegram", "pending-inbound")
    openInboundJournal(root, "telegram")
    vi.spyOn(nerves, "emitNervesEvent")
    const b = butler(root, reply("Again"))
    fs.chmodSync(pendingDir, 0o500)
    try {
      expect(await b.replay(redelivered(31))).toBe(false)
    } finally {
      fs.chmodSync(pendingDir, 0o700)
    }
    expect(emitted("senses.telegram_inbound_record_failed")).toHaveLength(1)
    expect(outcomes(root)).toEqual([])
  })

  it("abandons only the parts of an effect that had not gone out", () => {
    const root = newRoot()
    const effects = new FileTelegramEffectJournal(path.join(root, "effects"))
    const artifact = prepareTelegramEffect(effects, {
      idempotencyKey: "turn:abandon:delivery:0",
      target: { kind: "approved_relationship", friendId: "friend", sessionKey: "telegram:friend" },
      authorClass: "butler",
      effect: { kind: "text", text: `${"a".repeat(4_000)}\n\n${"b".repeat(4_000)}` },
      authorization: { allowed: true, receiptId: "receipt", expiresAt: new Date(Date.now() + 60_000).toISOString(), transport: { chatId: "42" } },
    })
    expect(artifact.parts).toHaveLength(2)
    artifact.parts[0]!.state = "accepted"
    artifact.parts[0]!.messageId = 5
    artifact.parts[1]!.attempts = 1
    abandonTelegramEffect(effects, artifact)
    const stored = effects.read(artifact.id)
    expect(stored.parts.map((part) => [part.state, part.attempts])).toEqual([["accepted", undefined], ["prepared", 3]])
    return recoverTelegramEffectOutbox({ store: effects, execute: vi.fn() }).then((result) => expect(result.attempted).toBe(0))
  })

  it("runs an owner's edit or reaction again when its stopped turn sent nothing", async () => {
    const root = newRoot()
    for (const updateId of [50, 51]) {
      const crashed = butler(root, never)
      void crashed.onMessage(message(updateId))
      await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    }
    const restarted = butler(root, reply("hi"))
    expect(await restarted.replay({ update_id: 50, edited_message: { message_id: 1050, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "edited" } } as TelegramUpdate)).toBe(true)
    expect(await restarted.replay({ update_id: 51, message_reaction: { message_id: 1051, user: { id: 42 }, chat: { id: 42, type: "private" }, date: 0, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } } as TelegramUpdate)).toBe(true)
  })

  it("records a message as failed when taking it back from the inbox throws", async () => {
    const root = newRoot()
    const crashed = butler(root, never)
    void crashed.onMessage(message(52))
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    const restarted = butler(root, reply("hi"))
    expect(await restarted.replay(redelivered(52), () => { throw new Error("inbox unreadable") })).toBe(false)
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "failed", detail: "deciding whether to run it again failed (Error)" })])
  })

  it("leaves callbacks, and messages from people it does not know, to their own recovery", async () => {
    const root = newRoot()
    const b = butler(root, reply("hi"))
    expect(await b.replay({ update_id: 28, callback_query: { id: "cb", from: { id: 42 }, data: "x" } } as TelegramUpdate)).toBe(false)
    expect(await b.replay({ update_id: 29, message: { message_id: 1, from: { id: 99 }, chat: { id: 99, type: "private" }, text: "hi" } })).toBe(false)
    expect(await b.replay({ update_id: 30, message: { message_id: 1, from: { id: 42 }, chat: { id: 7, type: "group" }, text: "hi" } } as TelegramUpdate)).toBe(false)
    expect(outcomes(root)).toEqual([])
  })
})

describe("Telegram household Friend outcomes", () => {
  const identityKey = "k".repeat(43)
  const householdMessage = (updateId: number) => ({ updateId, messageId: updateId + 100, botId: "777", userId: "888", chatId: "888", text: "is it ready?", displayLabel: "Household", hasAttachments: false })
  const householdUpdate = (updateId: number): TelegramUpdate => ({ update_id: updateId, message: { message_id: updateId + 100, from: { id: 888 }, chat: { id: 888, type: "private" }, text: "is it ready?" } })
  const reference = (updateId: number) => `telegram-inbound:${createHmac("sha256", identityKey).update(["777", "888", updateId, updateId + 100].join("\0")).digest("hex")}`
  const householdId = (updateId: number) => `telegram-household:${createHash("sha256").update(reference(updateId)).digest("hex")}`

  function household(agentRoot: string, runTurn: RunTurn, approved: (userId: string) => boolean | Promise<boolean> = (userId) => userId === "888") {
    let pollOptions!: TelegramLongPollOptions
    const api: TelegramBotApi = { request: vi.fn(async (method: string) => method === "sendMessage" ? { message_id: 100 } : true) as TelegramBotApi["request"], stop: vi.fn() }
    const turn = vi.fn(runTurn)
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "777:secret", botId: "777", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey,
      _agentRoot: agentRoot,
      api,
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { pollOptions = options; return { pollOnce: vi.fn(), run: vi.fn(async () => undefined), stop: vi.fn() } },
      runTurn: turn,
      migrateIdentity: async () => undefined,
      admission: {
        ownerFriendId: "ari",
        resolveOwner: vi.fn(async () => ({ friendId: "ari" })),
        resolveApprovedFriend: vi.fn(async ({ userId }: { userId: string }) => await approved(userId) ? { friendId: "household" } : null),
        claimFriend: vi.fn(),
        revokeFriend: vi.fn(),
      },
      authorizeRelationshipEffect: vi.fn(async () => ({ allowed: true, receiptId: "household", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "888" } })),
      resolveRelationshipAuthorization: vi.fn(async () => ({
        subject: { friendId: "household", trustLevel: "friend" as const, admissionState: "active" as const, initiativePolicy: "request_follow_up_only" as const },
        authorizedContextScopes: [], advertisedToolNames: [], authorizeContext: vi.fn(), authorizeTool: vi.fn(), authorizeEffect: vi.fn(),
      })),
    } as any)
    return {
      app, api, runTurn: turn,
      onUnknownMessage: (updateId: number) => pollOptions.onUnknownMessage!(householdMessage(updateId) as any),
      replay: async (update: TelegramUpdate) => pollOptions.replayIndeterminate!(update, () => true),
    }
  }

  it("records a household Friend's message and its outcome like the owner's", async () => {
    const root = newRoot()
    const b = household(root, reply("It is ready."))
    await b.onUnknownMessage(40)
    expect(readInboundOutcome(root, "telegram", householdId(40))).toMatchObject({ outcome: "answered", attempts: 1 })
    expect(pending(root)).toEqual([])
    await b.onUnknownMessage(40)
    expect(b.runTurn).toHaveBeenCalledTimes(1)
    await b.app.stop()
  })

  it("runs a household Friend's message again after a crash before anything went out", async () => {
    const root = newRoot()
    const crashed = household(root, never)
    void crashed.onUnknownMessage(41)
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    const restarted = household(root, reply("It is ready."))
    expect(await restarted.replay(householdUpdate(41))).toBe(true)
    await restarted.onUnknownMessage(41)
    expect(readInboundOutcome(root, "telegram", householdId(41))).toMatchObject({ outcome: "answered", attempts: 2 })
    await crashed.app.stop()
    await restarted.app.stop()
  })

  it("does not run a household Friend's message again once the outbox sent its reply", async () => {
    const root = newRoot()
    const crashed = household(root, never)
    void crashed.onUnknownMessage(42)
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    const effects = new FileTelegramEffectJournal(path.join(root, "state", "telegram", "effects"))
    prepareTelegramEffect(effects, {
      idempotencyKey: `relationship-turn:${reference(42)}:delivery:0`,
      target: { kind: "approved_relationship", friendId: "household", sessionKey: "telegram:777:888", requestId: reference(42) },
      authorClass: "butler",
      effect: { kind: "text", text: "Prepared before the crash" },
      authorization: { allowed: true, receiptId: "household", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "888" } },
    })
    effects.close()
    const restarted = household(root, reply("Again"))
    await restarted.app.run()
    expect(sends(restarted.api)).toHaveLength(1)
    expect(await restarted.replay(householdUpdate(42))).toBe(false)
    expect(readInboundOutcome(root, "telegram", householdId(42))).toMatchObject({ outcome: "failed" })
    await crashed.app.stop()
    await restarted.app.stop()
  })

  it("records a household Friend's turn that threw as failed, even when what it threw was not an Error", async () => {
    const root = newRoot()
    const b = household(root, async () => { throw "provider gone" })
    await expect(b.onUnknownMessage(44)).rejects.toBe("provider gone")
    expect(readInboundOutcome(root, "telegram", householdId(44))).toMatchObject({ outcome: "failed", detail: "the turn stopped with an error (unknown), and no reply reached them" })
    await b.app.stop()
  })

  it("records a household Friend's message as failed when they stopped being one before it came back", async () => {
    const root = newRoot()
    const crashed = household(root, never)
    void crashed.onUnknownMessage(45)
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    const revoked = household(root, reply("hi"), () => false)
    expect(await revoked.replay(householdUpdate(45))).toBe(false)
    expect(readInboundOutcome(root, "telegram", householdId(45))).toMatchObject({ outcome: "failed", detail: "they are no longer a household Friend, so it is not run again" })
    await crashed.app.stop()
    await revoked.app.stop()
  })

  it("records a message as failed when deciding whether to run it again throws", async () => {
    const root = newRoot()
    const crashed = household(root, never)
    void crashed.onUnknownMessage(46)
    await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    const broken = household(root, reply("hi"), async () => { throw new RangeError("friends store down") })
    expect(await broken.replay(householdUpdate(46))).toBe(false)
    expect(readInboundOutcome(root, "telegram", householdId(46))).toMatchObject({ outcome: "failed", detail: "deciding whether to run it again failed (RangeError)" })
    await crashed.app.stop()
    await broken.app.stop()
  })

  it("records a household Friend's turn that threw after a reply went out as failed, saying so", async () => {
    const root = newRoot()
    const b = household(root, async (options) => {
      await options.deliverySink.onDelivery({ kind: "settle", text: "Half an answer" })
      throw new TypeError("provider exploded")
    })
    await expect(b.onUnknownMessage(47)).rejects.toThrow("provider exploded")
    expect(readInboundOutcome(root, "telegram", householdId(47))).toMatchObject({ outcome: "failed", detail: "the turn stopped with an error (TypeError) after part of the reply went out" })
    await b.app.stop()
  })

  it("leaves a message from someone who is not a household Friend to the admission gate", async () => {
    const root = newRoot()
    const b = household(root, reply("hi"), () => false)
    expect(await b.replay(householdUpdate(43))).toBe(false)
    expect(outcomes(root)).toEqual([])
    await b.app.stop()
  })
})
