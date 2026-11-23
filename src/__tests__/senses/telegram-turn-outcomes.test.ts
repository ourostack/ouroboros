import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../nerves/runtime"
import { openInboundJournal, type InboundOutcomeRecord, type PendingInbound } from "../../senses/inbound-journal"
import { createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import type { TelegramBotApi, TelegramInboundMessage, TelegramLongPoll, TelegramUpdate } from "../../senses/telegram-client"
import { FileTelegramEffectJournal, prepareTelegramEffect } from "../../senses/telegram-effect-adapter"

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
    replay: (update: TelegramUpdate): boolean => pollOptions.replayIndeterminate(update),
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
    expect(restarted.replay(redelivered(11))).toBe(true)
    expect(emitted("senses.telegram_inbound_replayed")).toHaveLength(1)
    await restarted.onMessage(message(11))
    expect(outcomes(root)).toEqual([expect.objectContaining({ outcome: "answered", attempts: 2 })])

    expect(restarted.replay(redelivered(11))).toBe(false)
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
    expect(restarted.replay(redelivered(12))).toBe(false)
    expect(outcomes(root)).toEqual([expect.objectContaining({
      outcome: "failed", detail: "the turn stopped after a reply went out, so it is not run again",
    })])
    expect(sends(restarted.api)).toEqual([])
  })

  it("records a message as failed once it has used its three tries", async () => {
    const root = newRoot()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const crashed = butler(root, never)
      if (attempt > 0) expect(crashed.replay(redelivered(13))).toBe(true)
      void crashed.onMessage(message(13))
      await vi.waitFor(() => expect(crashed.runTurn).toHaveBeenCalled())
    }
    const restarted = butler(root, reply("Again"))
    expect(restarted.replay(redelivered(13))).toBe(false)
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
    expect(restarted.replay(redelivered(15))).toBe(false)
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
    expect(b.replay(redelivered(16))).toBe(false)
    await b.app.run()
    expect(emitted("senses.telegram_inbound_record_failed")).toHaveLength(3)
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
})
