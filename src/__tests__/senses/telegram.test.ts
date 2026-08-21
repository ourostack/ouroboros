import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { createTelegramSenseApp } from "../../senses/telegram"
import { splitTelegramText, type TelegramBotApi, type TelegramInboundMessage, type TelegramLongPoll } from "../../senses/telegram-client"

const RECEIPT_DOMAIN = "ouroboros.telegram.turn-receipt.v3"
const RECEIPT_KEY = "k".repeat(43)
const HEX_DIGEST = "a".repeat(64)

function receiptDigest(purpose: string, value: string): string {
  return createHmac("sha256", RECEIPT_KEY).update(`${RECEIPT_DOMAIN}\0${purpose}\0${value}`).digest("hex")
}

function validTurnReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "sanctuary-telegram-turn-receipt-v3",
    scenarioHandleDigest: HEX_DIGEST,
    status: "success",
    errorCategory: null,
    updateDigest: "1".repeat(64),
    sequenceDigest: "2".repeat(64),
    responseDigest: "3".repeat(64),
    toolResultDigests: [],
    providerInvocationCount: 1,
    toolInvocationCount: 0,
    deliveryCount: 0,
    deliveries: [],
    completedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  }
}

function receiptPath(root: string): string {
  return path.join(root, "state", "acceptance", "telegram-turns.ndjson")
}

function writeLedger(root: string, rows: string[]): void {
  fs.mkdirSync(path.dirname(receiptPath(root)), { recursive: true })
  fs.writeFileSync(receiptPath(root), `${rows.join("\n")}\n`, "utf8")
}

function readLedger(root: string): Record<string, unknown>[] {
  return fs.readFileSync(receiptPath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
}

function fixture(input: {
  healthSweep?: any
  approvalRuntime?: any
  pollRun?: () => Promise<void>
  botToken?: string
  acceptanceMarker?: () => { scenarioHandleDigest: string } | null
  acceptanceReceiptRoot?: string
  runTurn?: any
  api?: TelegramBotApi
  runWithToolReceiptCollection?: any
  afterAcceptanceLedgerPreReadStat?: (filePath: string) => void
} = {}) {
  let onMessage: ((message: TelegramInboundMessage) => Promise<void>) | undefined
  let onUpdate: ((update: any) => Promise<boolean>) | undefined
  const poll: TelegramLongPoll = {
    pollOnce: vi.fn(async () => 0),
    run: vi.fn(input.pollRun ?? (async () => undefined)),
    stop: vi.fn(),
  }
  const api: TelegramBotApi = input.api ?? {
    request: vi.fn(async () => ({ message_id: 71 })),
    stop: vi.fn(),
  }
  const createLongPoll = vi.fn((options: any) => {
    onMessage = options.onMessage
    onUpdate = options.onUpdate
    return poll
  })
  const runTurn = input.runTurn ?? vi.fn(async (options: any) => {
    await options.deliverySink.onDelivery({ kind: "settle", text: "All systems nominal." })
    return {
      response: "All systems nominal.",
      ponderDeferred: false,
      deliveries: [{ kind: "settle", text: "All systems nominal." }],
      deliveryFailures: [],
    }
  })
  const approvalTransport = {
    sendApproval: vi.fn(),
    handleUpdate: vi.fn(async () => ({ handled: true, accepted: true, reason: "accepted" })),
    reconcileExpired: vi.fn(async () => undefined),
    terminalizeRecovered: vi.fn(async () => undefined),
  }
  const app = createTelegramSenseApp({
    agentName: "butler",
    credentials: { botToken: input.botToken ?? "test-token", authorizedUserId: "42", authorizedChatId: "42" },
    identityKey: "k".repeat(43),
    migrateIdentity: async () => undefined,
    api,
    offsetStore: { load: () => 0, save: vi.fn() },
    createLongPoll,
    runTurn,
    approvalTransport: input.approvalRuntime ? undefined : approvalTransport,
    approvalRuntime: input.approvalRuntime,
    healthSweep: input.healthSweep,
    acceptanceMarker: input.acceptanceMarker,
    acceptanceReceiptRoot: input.acceptanceReceiptRoot,
    _runWithToolReceiptCollection: input.runWithToolReceiptCollection,
    _afterAcceptanceLedgerPreReadStat: input.afterAcceptanceLedgerPreReadStat,
  })
  return { app, api, poll, runTurn, approvalTransport, getOnMessage: () => onMessage!, getOnUpdate: () => onUpdate! }
}

describe("Telegram sense", () => {
  it("maps one authorized private update into the shared Telegram turn and delivery route", async () => {
    const f = fixture()
    await f.getOnMessage()({ updateId: 9, messageId: "10", userId: "42", chatId: "42", text: "health?" })

    expect(f.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "butler",
      channel: "telegram",
      sessionKey: expect.stringMatching(/^telegram:tg_[A-Za-z0-9_-]{43}$/u),
      friendId: expect.stringMatching(/^telegram-user:tg_[A-Za-z0-9_-]{43}$/u),
      identity: {
        provider: "telegram-user",
        externalId: expect.stringMatching(/^tg_[A-Za-z0-9_-]{43}$/u),
        displayName: expect.stringMatching(/^Telegram user tg_[A-Za-z0-9_-]{43}$/u),
      },
      userMessage: "health?",
    }))
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "42",
      text: "All systems nominal.",
      parse_mode: "HTML",
    }, undefined)
  })

  it("persists one HMAC-bound acceptance receipt with observed provider, tool, and delivery counts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-acceptance-receipt-"))
    const runTurn = vi.fn(async (options: any) => {
      await options.deliverySink.onDelivery({ kind: "settle", text: "grounded answer" })
      return { response: "grounded answer", ponderDeferred: false, deliveries: [{ kind: "settle", text: "grounded answer" }], deliveryFailures: [], providerInvocationCount: 2, toolInvocationCount: 1 }
    })
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }), acceptanceReceiptRoot: root, runTurn })

    await f.getOnMessage()({ updateId: 9, messageId: "10", userId: "42", chatId: "42", text: "status" })

    const receipt = JSON.parse(fs.readFileSync(path.join(root, "state", "acceptance", "telegram-turns.ndjson"), "utf8"))
    const deliveries = [{ messageIdDigest: receiptDigest("delivery", "71"), chunkDigest: receiptDigest("chunk", "grounded answer") }]
    expect(receipt).toMatchObject({ schemaVersion: "sanctuary-telegram-turn-receipt-v3", scenarioHandleDigest: "a".repeat(64), status: "success", errorCategory: null, providerInvocationCount: 2, toolInvocationCount: 1, deliveryCount: 1, updateDigest: receiptDigest("update", ["9", "10"].join("\0")), sequenceDigest: receiptDigest("sequence", "9"), responseDigest: receiptDigest("response", JSON.stringify(deliveries)), deliveries })
    expect(JSON.stringify(receipt)).not.toContain('"updateId":9')
    expect(JSON.stringify(receipt)).not.toContain('"messageId":"10"')
  })

  it("records partial chunk delivery as an error without sending a duplicate fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-partial-receipt-"))
    const api: TelegramBotApi = { request: vi.fn().mockResolvedValueOnce({ message_id: 71 }).mockRejectedValueOnce(new Error("second chunk failed")), stop: vi.fn() }
    const long = "x".repeat(7_000)
    const runTurn = vi.fn(async (options: any) => {
      options.turnMetricsObserver.providerInvocationCount += 1
      options.turnMetricsObserver.toolInvocationCount += 1
      await options.deliverySink.onDelivery({ kind: "settle", text: long })
      return { response: long, ponderDeferred: false, deliveries: [], deliveryFailures: [], providerInvocationCount: 1, toolInvocationCount: 0 }
    })
    const f = fixture({ api, runTurn, acceptanceMarker: () => ({ scenarioHandleDigest: "b".repeat(64) }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 11, messageId: "12", userId: "42", chatId: "42", text: "long" })

    expect(api.request).toHaveBeenCalledTimes(2)
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "state", "acceptance", "telegram-turns.ndjson"), "utf8"))
    expect(receipt).toMatchObject({ status: "error", errorCategory: "Error", deliveryCount: 1, providerInvocationCount: 1, toolInvocationCount: 1 })
    expect(receipt.deliveries).toHaveLength(1)
  })

  it("does not turn an acceptance receipt write failure into another Telegram reply", async () => {
    const rootFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telegram-receipt-failure-")), "not-a-directory")
    fs.writeFileSync(rootFile, "blocked")
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: "c".repeat(64) }), acceptanceReceiptRoot: rootFile })
    await f.getOnMessage()({ updateId: 13, messageId: "14", userId: "42", chatId: "42", text: "status" })
    expect(f.api.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["invalid JSON", "{"],
    ["primitive row", "null"],
    ["extra field", JSON.stringify(validTurnReceipt({ extra: true }))],
    ["array scenario digest", JSON.stringify(validTurnReceipt({ scenarioHandleDigest: [HEX_DIGEST] }))],
    ["array status", JSON.stringify(validTurnReceipt({ status: ["success"] }))],
    ["success with an error category", JSON.stringify(validTurnReceipt({ errorCategory: "Error" }))],
    ["error without an error category", JSON.stringify(validTurnReceipt({ status: "error" }))],
    ["empty error category", JSON.stringify(validTurnReceipt({ status: "error", errorCategory: "" }))],
    ["untyped digest", JSON.stringify(validTurnReceipt({ updateDigest: ["1".repeat(64)] }))],
    ["too many tool result digests", JSON.stringify(validTurnReceipt({ toolResultDigests: Array(101).fill(HEX_DIGEST) }))],
    ["untyped tool result digest", JSON.stringify(validTurnReceipt({ toolResultDigests: [[HEX_DIGEST]] }))],
    ["delivery with extra field", JSON.stringify(validTurnReceipt({ deliveryCount: 1, deliveries: [{ messageIdDigest: HEX_DIGEST, chunkDigest: HEX_DIGEST, extra: true }] }))],
    ["too many deliveries", JSON.stringify(validTurnReceipt({ deliveryCount: 101, deliveries: Array.from({ length: 101 }, () => ({ messageIdDigest: HEX_DIGEST, chunkDigest: HEX_DIGEST })) }))],
    ["delivery count mismatch", JSON.stringify(validTurnReceipt({ deliveryCount: 1 }))],
    ["fractional provider count", JSON.stringify(validTurnReceipt({ providerInvocationCount: 1.5 }))],
    ["excessive tool count", JSON.stringify(validTurnReceipt({ toolInvocationCount: 1_001 }))],
    ["noncanonical timestamp", JSON.stringify(validTurnReceipt({ completedAt: "2026-08-20" }))],
    ["oversized row", JSON.stringify(validTurnReceipt({ extra: "x".repeat(17 * 1024) }))],
  ])("refuses to append after a corrupt existing ledger row: %s", async (_label, corruptRow) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-corrupt-ledger-"))
    writeLedger(root, [corruptRow])
    const before = fs.readFileSync(receiptPath(root), "utf8")
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 20, messageId: "21", userId: "42", chatId: "42", text: "status" })

    expect(fs.readFileSync(receiptPath(root), "utf8")).toBe(before)
    expect(f.api.request).toHaveBeenCalledOnce()
  })

  it("validates a newly generated receipt before creating the ledger", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-invalid-incoming-receipt-"))
    const f = fixture({
      acceptanceMarker: (() => ({ scenarioHandleDigest: [HEX_DIGEST] })) as any,
      acceptanceReceiptRoot: root,
    })

    await f.getOnMessage()({ updateId: 21, messageId: "22", userId: "42", chatId: "42", text: "status" })

    expect(fs.existsSync(receiptPath(root))).toBe(false)
    expect(f.api.request).toHaveBeenCalledOnce()
  })

  it("rejects ledgers above both the row-count and aggregate-byte read bounds", async () => {
    const tooManyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-too-many-rows-"))
    writeLedger(tooManyRoot, Array.from({ length: 501 }, () => JSON.stringify(validTurnReceipt())))
    const tooMany = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: tooManyRoot })
    await tooMany.getOnMessage()({ updateId: 22, messageId: "23", userId: "42", chatId: "42", text: "status" })
    expect(fs.readFileSync(receiptPath(tooManyRoot), "utf8").trim().split("\n")).toHaveLength(501)

    const oversizedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-oversized-ledger-"))
    fs.mkdirSync(path.dirname(receiptPath(oversizedRoot)), { recursive: true })
    fs.writeFileSync(receiptPath(oversizedRoot), "x".repeat(4 * 1024 * 1024 + 1), "utf8")
    const afterPreReadStat = vi.fn()
    const oversized = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: oversizedRoot, afterAcceptanceLedgerPreReadStat: afterPreReadStat })
    await oversized.getOnMessage()({ updateId: 24, messageId: "25", userId: "42", chatId: "42", text: "status" })
    expect(fs.statSync(receiptPath(oversizedRoot)).size).toBe(4 * 1024 * 1024 + 1)
    expect(afterPreReadStat).not.toHaveBeenCalled()
  })

  it.each(["symbolic link", "directory"])("refuses a non-regular existing ledger: %s", async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-nonregular-ledger-"))
    fs.mkdirSync(path.dirname(receiptPath(root)), { recursive: true })
    const target = path.join(root, "target.ndjson")
    const original = `${JSON.stringify(validTurnReceipt())}\n`
    if (kind === "symbolic link") {
      fs.writeFileSync(target, original, "utf8")
      fs.symlinkSync(target, receiptPath(root))
    } else {
      fs.mkdirSync(receiptPath(root))
    }
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 25, messageId: "26", userId: "42", chatId: "42", text: "status" })

    if (kind === "symbolic link") {
      expect(fs.lstatSync(receiptPath(root)).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(target, "utf8")).toBe(original)
    } else {
      expect(fs.statSync(receiptPath(root)).isDirectory()).toBe(true)
    }
  })

  it("refuses to append when a regular ledger changes during its bounded read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-changing-ledger-"))
    const original = JSON.stringify(validTurnReceipt({ scenarioHandleDigest: "b".repeat(64) }))
    const replacement = JSON.stringify(validTurnReceipt({ scenarioHandleDigest: "c".repeat(64) }))
    expect(replacement).toHaveLength(original.length)
    writeLedger(root, [original])
    const f = fixture({
      acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }),
      acceptanceReceiptRoot: root,
      afterAcceptanceLedgerPreReadStat: (filePath) => fs.writeFileSync(filePath, `${replacement}\n`, "utf8"),
    })

    await f.getOnMessage()({ updateId: 27, messageId: "28", userId: "42", chatId: "42", text: "status" })

    expect(fs.readFileSync(receiptPath(root), "utf8")).toBe(`${replacement}\n`)
  })

  it("refuses to append when a regular ledger is truncated during its bounded read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-truncated-ledger-"))
    writeLedger(root, [JSON.stringify(validTurnReceipt())])
    const f = fixture({
      acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }),
      acceptanceReceiptRoot: root,
      afterAcceptanceLedgerPreReadStat: (filePath) => fs.truncateSync(filePath, 0),
    })

    await f.getOnMessage()({ updateId: 28, messageId: "29", userId: "42", chatId: "42", text: "status" })

    expect(fs.readFileSync(receiptPath(root), "utf8")).toBe("")
  })

  it("rejects a newly generated schema-valid receipt above the row-byte bound", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-oversized-incoming-receipt-"))
    const text = "x".repeat(120_000)
    expect(splitTelegramText(text)).toHaveLength(100)
    let messageId = 100
    const api: TelegramBotApi = { request: vi.fn(async () => ({ message_id: ++messageId })), stop: vi.fn() }
    const runTurn = vi.fn(async (options: any) => {
      await options.deliverySink.onDelivery({ kind: "settle", text })
      return { response: text, ponderDeferred: false, deliveries: [{ kind: "settle", text }], deliveryFailures: [], providerInvocationCount: 1, toolInvocationCount: 100 }
    })
    const runWithToolReceiptCollection = async (operation: () => Promise<unknown>, observer: { toolResultDigests: string[] }) => {
      observer.toolResultDigests.push(...Array(100).fill(HEX_DIGEST))
      return { result: await operation(), toolResultDigests: [...observer.toolResultDigests] }
    }
    const f = fixture({ api, runTurn, runWithToolReceiptCollection, acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 30, messageId: "31", userId: "42", chatId: "42", text: "large" })

    expect(api.request).toHaveBeenCalledTimes(100)
    expect(fs.existsSync(receiptPath(root))).toBe(false)
  })

  it("retains exactly the newest 500 valid receipts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-500-ledger-"))
    const oldestDigest = "b".repeat(64)
    const rows = [JSON.stringify(validTurnReceipt({ scenarioHandleDigest: oldestDigest }))]
    rows.push(...Array.from({ length: 499 }, () => JSON.stringify(validTurnReceipt())))
    writeLedger(root, rows)
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: "c".repeat(64) }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 26, messageId: "27", userId: "42", chatId: "42", text: "status" })

    const ledger = readLedger(root)
    expect(ledger).toHaveLength(500)
    expect(ledger.some((row) => row.scenarioHandleDigest === oldestDigest)).toBe(false)
    expect(ledger.at(-1)?.scenarioHandleDigest).toBe("c".repeat(64))
  })

  it("trims oldest receipts until the final aggregate remains within four MiB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-byte-bound-ledger-"))
    const delivery = { messageIdDigest: HEX_DIGEST, chunkDigest: HEX_DIGEST }
    const largeRow = (deliveryCount: number) => JSON.stringify(validTurnReceipt({
      toolResultDigests: Array(100).fill(HEX_DIGEST),
      deliveryCount,
      deliveries: Array.from({ length: deliveryCount }, () => delivery),
    }))
    const rows = [JSON.stringify(validTurnReceipt({ scenarioHandleDigest: "b".repeat(64) }))]
    rows.push(...Array.from({ length: 336 }, () => largeRow(7)))
    rows.push(...Array.from({ length: 163 }, () => largeRow(6)))
    writeLedger(root, rows)
    expect(fs.statSync(receiptPath(root)).size).toBeLessThanOrEqual(4 * 1024 * 1024)
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: "c".repeat(64) }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 28, messageId: "29", userId: "42", chatId: "42", text: "status" })

    expect(fs.statSync(receiptPath(root)).size).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(readLedger(root)).toHaveLength(499)
  })

  it("serializes concurrent receipt appends without losing either turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-concurrent-ledger-"))
    let messageId = 70
    const api: TelegramBotApi = { request: vi.fn(async () => ({ message_id: ++messageId })), stop: vi.fn() }
    const f = fixture({ api, acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await Promise.all([
      f.getOnMessage()({ updateId: 30, messageId: "31", userId: "42", chatId: "42", text: "first" }),
      f.getOnMessage()({ updateId: 32, messageId: "33", userId: "42", chatId: "42", text: "second" }),
    ])

    const ledger = readLedger(root)
    expect(ledger).toHaveLength(2)
    expect(new Set(ledger.map((row) => row.updateDigest))).toEqual(new Set([
      receiptDigest("update", ["30", "31"].join("\0")),
      receiptDigest("update", ["32", "33"].join("\0")),
    ]))
  })

  it("recovers the append queue after a prior persistence failure", async () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telegram-ledger-recovery-")), "blocked")
    fs.writeFileSync(root, "not a directory")
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })
    await f.getOnMessage()({ updateId: 34, messageId: "35", userId: "42", chatId: "42", text: "first" })
    fs.unlinkSync(root)
    fs.mkdirSync(root)

    await f.getOnMessage()({ updateId: 36, messageId: "37", userId: "42", chatId: "42", text: "second" })

    expect(readLedger(root)).toHaveLength(1)
    expect(readLedger(root)[0]?.updateDigest).toBe(receiptDigest("update", ["36", "37"].join("\0")))
  })

  it("binds each successful Telegram chunk to its ordered message id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-ordered-chunks-"))
    const text = "x".repeat(7_000)
    const chunks = splitTelegramText(text)
    const api: TelegramBotApi = { request: vi.fn().mockResolvedValueOnce({ message_id: 71 }).mockResolvedValueOnce({ message_id: 72 }), stop: vi.fn() }
    const runTurn = vi.fn(async (options: any) => {
      await options.deliverySink.onDelivery({ kind: "settle", text })
      return { response: text, ponderDeferred: false, deliveries: [{ kind: "settle", text }], deliveryFailures: [], providerInvocationCount: 1, toolInvocationCount: 0 }
    })
    const f = fixture({ api, runTurn, acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 38, messageId: "39", userId: "42", chatId: "42", text: "long" })

    const receipt = readLedger(root)[0]!
    const deliveries = [
      { messageIdDigest: receiptDigest("delivery", "71"), chunkDigest: receiptDigest("chunk", chunks[0]!) },
      { messageIdDigest: receiptDigest("delivery", "72"), chunkDigest: receiptDigest("chunk", chunks[1]!) },
    ]
    expect(receipt.deliveries).toEqual(deliveries)
    expect(receipt.responseDigest).toBe(receiptDigest("response", JSON.stringify(deliveries)))
  })

  it("records the fallback delivery when the turn fails before sending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-fallback-success-"))
    const runTurn = vi.fn(async (options: any) => {
      options.turnMetricsObserver.providerInvocationCount += 1
      throw new TypeError("turn failed")
    })
    const f = fixture({ runTurn, acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 40, messageId: "41", userId: "42", chatId: "42", text: "fail" })

    expect(readLedger(root)[0]).toMatchObject({ status: "error", errorCategory: "TypeError", providerInvocationCount: 1, deliveryCount: 1 })
  })

  it("retains tool-result digests and invocation counters in a rejected Telegram turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-rejected-evidence-"))
    const toolDigest = "d".repeat(64)
    const runTurn = vi.fn(async (options: any) => {
      options.turnMetricsObserver.providerInvocationCount += 1
      options.turnMetricsObserver.toolInvocationCount += 2
      throw new Error("turn failed after tool result")
    })
    const runWithToolReceiptCollection = async (operation: () => Promise<unknown>, observer: { toolResultDigests: string[] }) => {
      observer.toolResultDigests.push(toolDigest)
      return { result: await operation(), toolResultDigests: [...observer.toolResultDigests] }
    }
    const f = fixture({ runTurn, runWithToolReceiptCollection, acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await f.getOnMessage()({ updateId: 41, messageId: "42", userId: "42", chatId: "42", text: "fail" })

    expect(readLedger(root)[0]).toMatchObject({
      status: "error",
      providerInvocationCount: 1,
      toolInvocationCount: 2,
      toolResultDigests: [toolDigest],
    })
  })

  it("records zero deliveries and still persists evidence when the fallback send fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-fallback-failure-"))
    const api: TelegramBotApi = { request: vi.fn().mockRejectedValue(new Error("Telegram unavailable")), stop: vi.fn() }
    const runTurn = vi.fn(async (options: any) => {
      options.turnMetricsObserver.providerInvocationCount += 1
      options.turnMetricsObserver.toolInvocationCount += 1
      throw new Error("turn failed")
    })
    const f = fixture({ api, runTurn, acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root })

    await expect(f.getOnMessage()({ updateId: 42, messageId: "43", userId: "42", chatId: "42", text: "fail" })).rejects.toThrow("Telegram unavailable")

    expect(readLedger(root)[0]).toMatchObject({ status: "error", errorCategory: "Error", providerInvocationCount: 1, toolInvocationCount: 1, deliveryCount: 0, deliveries: [] })
  })

  it("keeps the same opaque friend and session identity across bot-token rotation", async () => {
    const first = fixture({ botToken: "old-token" })
    const rotated = fixture({ botToken: "rotated-token" })
    await first.getOnMessage()({ updateId: 1, messageId: "1", userId: "42", chatId: "42", text: "before" })
    await rotated.getOnMessage()({ updateId: 2, messageId: "2", userId: "42", chatId: "42", text: "after" })

    const firstTurn = first.runTurn.mock.calls[0]![0]
    const rotatedTurn = rotated.runTurn.mock.calls[0]![0]
    expect(rotatedTurn.friendId).toBe(firstTurn.friendId)
    expect(rotatedTurn.sessionKey).toBe(firstTurn.sessionKey)
    expect(rotatedTurn.identity).toEqual(firstTurn.identity)
  })

  it("routes callback updates only through the approval transport", async () => {
    const f = fixture()
    const update = { update_id: 10, callback_query: { id: "cb", from: { id: 42 }, data: "opaque" } }
    await expect(f.getOnUpdate()(update)).resolves.toBe(true)
    expect(f.approvalTransport.handleUpdate).toHaveBeenCalledWith(update)
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it("reconciles approvals before polling and stops both poll and API", async () => {
    const f = fixture()
    await f.app.run()
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledBefore(f.poll.run as any)
    await f.app.stop()
    await f.app.stop()
    expect(f.poll.stop).toHaveBeenCalledOnce()
    expect(f.api.stop).toHaveBeenCalledOnce()
  })

  it("reconciles expired approvals while polling stays up and stops scheduling on shutdown", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({
      pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }),
    })

    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(4)

    const stopping = f.app.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(4)
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("keeps expiry reconciliation alive after redacted Error and non-Error failures", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic expiry failure"))
      .mockRejectedValueOnce("synthetic non-error failure")
      .mockResolvedValue(undefined)

    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(3)

    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("joins an in-flight reconciliation before closing transport resources", async () => {
    vi.useFakeTimers()
    let releaseReconcile!: () => void
    let finishPolling!: () => void
    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(), handleUpdate: vi.fn(), terminalizeRecovered: vi.fn(),
        reconcileExpired: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseReconcile = resolve })),
      },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const f = fixture({ approvalRuntime, pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    const running = f.app.run()
    await vi.waitFor(() => expect(approvalRuntime.transport.reconcileExpired).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    const stopping = f.app.stop()
    expect(approvalRuntime.close).not.toHaveBeenCalled()
    releaseReconcile()
    finishPolling()
    await stopping
    expect(approvalRuntime.close).toHaveBeenCalledOnce()
    await running
    vi.useRealTimers()
  })

  it("joins an active callback dispatch before closing the approval journal or API", async () => {
    let releaseDecision!: () => void
    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(), terminalizeRecovered: vi.fn(), reconcileExpired: vi.fn(async () => undefined),
        handleUpdate: vi.fn(() => new Promise<{ handled: boolean; accepted: boolean; reason: string }>((resolve) => {
          releaseDecision = () => resolve({ handled: true, accepted: true, reason: "accepted" })
        })),
      },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const f = fixture({ approvalRuntime })
    ;(f.poll.run as any).mockImplementation(async () => {
      await f.getOnUpdate()({ update_id: 1, callback_query: { id: "decision", from: { id: 42 } } })
    })

    const running = f.app.run()
    await vi.waitFor(() => expect(approvalRuntime.transport.handleUpdate).toHaveBeenCalledOnce())
    const stopping = f.app.stop()
    await Promise.resolve()

    expect(f.api.stop).not.toHaveBeenCalled()
    expect(approvalRuntime.close).not.toHaveBeenCalled()
    releaseDecision()
    await running
    await stopping
    expect(f.api.stop).toHaveBeenCalledOnce()
    expect(approvalRuntime.close).toHaveBeenCalledOnce()
  })

  it("deduplicates concurrent run calls and still closes after a failed startup lifecycle", async () => {
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    const first = f.app.run()
    const second = f.app.run()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(f.poll.run).toHaveBeenCalledOnce())
    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await first

    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(), handleUpdate: vi.fn(), terminalizeRecovered: vi.fn(), reconcileExpired: vi.fn(),
      },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const failed = createTelegramSenseApp({
      agentName: "butler",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43),
      migrateIdentity: async () => { throw new Error("synthetic startup failure") },
      api: { request: vi.fn(), stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      approvalRuntime,
    })
    await expect(failed.run()).rejects.toThrow("synthetic startup failure")
    await expect(failed.stop()).resolves.toBeUndefined()
    expect(approvalRuntime.close).toHaveBeenCalledOnce()

    const neverStarted = fixture()
    await expect(neverStarted.app.stop()).resolves.toBeUndefined()
    expect(neverStarted.api.stop).toHaveBeenCalledOnce()
  })

  it("caps persistent reconciliation retries with exponential backoff", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("persistent failure"))
    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(6)
    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("recovers interrupted approval decisions before expiring prompts or polling", async () => {
    const order: string[] = []
    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(),
        handleUpdate: vi.fn(),
        reconcileExpired: vi.fn(async () => { order.push("reconcile") }),
        terminalizeRecovered: vi.fn(),
      },
      coordinator: vi.fn(),
      recover: vi.fn(async () => { order.push("recover") }),
      close: vi.fn(),
    }
    const f = fixture({ approvalRuntime })
    ;(f.poll.run as any).mockImplementation(async () => { order.push("poll") })

    await f.app.run()

    expect(order).toEqual(["recover", "reconcile", "poll"])
  })

  it("supports proactive private delivery through the same bounded formatter", async () => {
    const f = fixture()
    await f.app.sendProactive("Array recovered")
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "42",
      text: "Array recovered",
      parse_mode: "HTML",
    }, undefined)
  })

  it("persists health delivery intent before Telegram send and receipts it afterward", async () => {
    const order: string[] = []
    const healthSweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", deliveryId: "delivery-1" })),
      {
        markDeliveryAttempting: vi.fn(async () => { order.push("attempting") }),
        markDelivered: vi.fn(async () => { order.push("delivered") }),
      },
    )
    const f = fixture({ healthSweep })
    ;(f.api.request as any).mockImplementation(async () => { order.push("send"); return { message_id: 71 } })

    await f.app.run()

    expect(order).toEqual(["attempting", "send", "delivered"])
  })

  it("leaves an attempted health delivery unreceipted when Telegram send fails", async () => {
    const healthSweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", deliveryId: "delivery-1" })),
      { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() },
    )
    const f = fixture({ healthSweep })
    ;(f.api.request as any).mockRejectedValue(new Error("offline"))

    await f.app.run()

    expect(healthSweep.markDeliveryAttempting).toHaveBeenCalledWith("delivery-1")
    expect(healthSweep.markDelivered).not.toHaveBeenCalled()
  })
})
