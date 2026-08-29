import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { createLogger } from "../../nerves"
import { emitNervesEvent, setRuntimeLogger } from "../../nerves/runtime"
import { createTelegramSenseApp, opaqueTelegramSubject, sanctuaryTelegramApprovalEvidenceMac, sanctuaryTelegramTurnReceiptDigest, sanctuaryTelegramTurnReceiptMac, telegramAcceptanceAuditOwnerDigest } from "../../senses/telegram"
import { TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH, verifyTelegramAuditLedger } from "../../senses/telegram-audit-ledger"
import { splitTelegramText, type TelegramBotApi, type TelegramInboundMessage, type TelegramLongPoll } from "../../senses/telegram-client"
import { getSenseSessionPath } from "../../senses/shared-turn"

const RECEIPT_DOMAIN = "ouroboros.telegram.turn-receipt.v3"
const RECEIPT_KEY = "k".repeat(43)
const HEX_DIGEST = "a".repeat(64)

function inboundReference(updateId: number, messageId: string): string {
  return `telegram-inbound:${createHmac("sha256", "k".repeat(43)).update(`${updateId}\0${messageId}`).digest("hex")}`
}

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
  acceptanceMarker?: () => { scenarioHandleDigest: string; label?: string } | null
  acceptanceReceiptRoot?: string
  runTurn?: any
  api?: TelegramBotApi
  runWithToolReceiptCollection?: any
  afterAcceptanceLedgerPreReadStat?: (filePath: string) => void
  authorizeEffect?: any
} = {}) {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-sense-fixture-"))
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
    _agentRoot: agentRoot,
    _runWithToolReceiptCollection: input.runWithToolReceiptCollection,
    _afterAcceptanceLedgerPreReadStat: input.afterAcceptanceLedgerPreReadStat,
    authorizeEffect: input.authorizeEffect,
  })
  return { app, api, poll, runTurn, approvalTransport, agentRoot, getOnMessage: () => onMessage!, getOnUpdate: () => onUpdate! }
}

describe("Telegram sense", () => {
  it("derives one canonical opaque subject from bot, user, and chat identity", () => {
    const identityKey = "k".repeat(43)
    const baseline = opaqueTelegramSubject(identityKey, "bot-a", "42", "43")
    expect(baseline).toMatch(/^tg_[A-Za-z0-9_-]{43}$/u)
    expect(opaqueTelegramSubject(identityKey, "bot-b", "42", "43")).not.toBe(baseline)
    expect(opaqueTelegramSubject(identityKey, "bot-a", "44", "43")).not.toBe(baseline)
    expect(opaqueTelegramSubject(identityKey, "bot-a", "42", "45")).not.toBe(baseline)
  })

  it("rejects unsupported receipt MAC values and invalid acceptance scenario handles", () => {
    expect(() => sanctuaryTelegramTurnReceiptMac("k".repeat(43), { unsupported: undefined })).toThrow("unsupported value")
    expect(() => createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: fs.mkdtempSync(path.join(os.tmpdir(), "telegram-invalid-marker-")), _toolContext: {} as never,
      acceptanceMarker: () => ({ scenarioHandleDigest: "invalid" }),
    })).toThrow("scenario handle is invalid")
  })

  it("renders every dropped-update acceptance binding shape from request-time marker state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-drop-meta-"))
    let marker: { scenarioHandleDigest: string; label?: string } | null = null
    let acceptanceEventMeta!: (update: any, distinct: boolean) => Record<string, unknown>
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, _toolContext: {} as never, acceptanceMarker: () => marker,
      migrateIdentity: async () => undefined, api: { request: vi.fn(async () => ({ message_id: 71 })), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { acceptanceEventMeta = options.acceptanceEventMeta!; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      approvalRuntime: {
        transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
        coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
      } as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
    })
    try {
      expect(acceptanceEventMeta(undefined, false)).toEqual({})
      marker = { scenarioHandleDigest: "a".repeat(64) }
      expect(acceptanceEventMeta(undefined, false)).toEqual({ scenarioHandleDigest: marker.scenarioHandleDigest })
      expect(acceptanceEventMeta({ callback_query: { message: { message_id: 7 } } }, false)).toEqual({ scenarioHandleDigest: marker.scenarioHandleDigest })
      expect(acceptanceEventMeta({ update_id: 1, message: { message_id: 7, from: { id: 42 } } }, false)).toMatchObject({ senderDistinct: false, scenarioHandleDigest: marker.scenarioHandleDigest })
      expect(() => acceptanceEventMeta({ update_id: 1, message: { message_id: 7, from: { id: 99 } } }, false)).toThrow("classification mismatch")
      marker = { scenarioHandleDigest: "b".repeat(64), label: "unit-16d-whats-up" }
      expect(acceptanceEventMeta({ update_id: 2, message: { message_id: 8, from: { id: 99 } } }, true)).toMatchObject({ senderDistinct: true })
      await app.sendProactive("activate owner")
      expect(acceptanceEventMeta(undefined, false)).toMatchObject({ acceptanceAuditOwnerDigest: expect.any(String) })
    } finally {
      await app.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("uses the packaged marker reader when no acceptance-marker override is supplied", () => {
    let acceptanceEventMeta!: (update: any, distinct: boolean) => Record<string, unknown>
    const app = createTelegramSenseApp({
      agentName: "butler", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" }, identityKey: "k".repeat(43),
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { acceptanceEventMeta = options.acceptanceEventMeta!; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      runTurn: vi.fn(async () => ({ response: "", deliveries: [], deliveryFailures: [], ponderDeferred: false })),
    })
    expect(acceptanceEventMeta(undefined, false)).toEqual({})
    void app.stop()
  })

  it("keeps default Sanctuary useful without a marker and dynamically acquires audit ownership when one appears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-normal-sanctuary-"))
    let marker: { scenarioHandleDigest: string } | null = null
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const api: TelegramBotApi = { request: vi.fn(async () => ({ message_id: 71 })), stop: vi.fn() }
    const run = vi.fn(async (options: any) => {
      await options.deliverySink.onDelivery({ kind: "settle", text: "Sanctuary is healthy." })
      return { response: "Sanctuary is healthy.", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
    })
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43),
      _agentRoot: root,
      _toolContext: {} as never,
      _runTurn: run,
      acceptanceMarker: () => marker,
      migrateIdentity: async () => undefined,
      api,
      offsetStore: { load: () => 0, save: vi.fn() },
      inboxStore: { load: vi.fn(() => []), capture: vi.fn(() => true), claim: vi.fn(() => true), complete: vi.fn(), quarantineStranded: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), acknowledgeIndeterminateWarning: vi.fn(() => true) },
      createLongPoll: (options) => { onMessage = options.onMessage; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      approvalRuntime: approvalRuntime as never,
    })
    try {
      await onMessage({ updateId: 1, messageId: "2", userId: "42", chatId: "42", text: "hello" })
      expect(api.request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: "Sanctuary is healthy.", parse_mode: "HTML" }, undefined)
      expect(fs.existsSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH))).toBe(false)
      marker = { scenarioHandleDigest: "a".repeat(64) }
      await onMessage({ updateId: 3, messageId: "4", userId: "42", chatId: "42", text: "hello again" })
      const events = verifyTelegramAuditLedger({
        ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
        headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"),
        identityKey: "k".repeat(43),
      })
      expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining(["senses.telegram_turn_start", "senses.telegram_turn_end"]))
      const firstScenarioRows = events.length
      marker = { scenarioHandleDigest: "b".repeat(64) }
      await onMessage({ updateId: 5, messageId: "6", userId: "42", chatId: "42", text: "direct second scenario" })
      const directRotation = verifyTelegramAuditLedger({
        ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
        headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"),
        identityKey: "k".repeat(43),
      })
      expect(directRotation.length).toBeGreaterThan(firstScenarioRows)
      expect(new Set(directRotation.map(({ meta }) => meta.scenarioHandleDigest).filter(Boolean))).toEqual(new Set(["a".repeat(64), "b".repeat(64)]))
      marker = null
      await onMessage({ updateId: 7, messageId: "8", userId: "42", chatId: "42", text: "ordinary again" })
      expect(verifyTelegramAuditLedger({
        ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
        headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"),
        identityKey: "k".repeat(43),
      })).toHaveLength(directRotation.length)
      marker = { scenarioHandleDigest: "c".repeat(64) }
      await onMessage({ updateId: 9, messageId: "10", userId: "42", chatId: "42", text: "third scenario" })
      const bothScenarios = verifyTelegramAuditLedger({
        ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
        headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"),
        identityKey: "k".repeat(43),
      })
      expect(bothScenarios.length).toBeGreaterThan(directRotation.length)
      expect(new Set(bothScenarios.map(({ meta }) => meta.scenarioHandleDigest).filter(Boolean))).toEqual(new Set(["a".repeat(64), "b".repeat(64), "c".repeat(64)]))
    } finally {
      await app.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed when an active acceptance scenario drifts after ownership is acquired", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-scenario-drift-"))
    let scenario = "a".repeat(64)
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const api = { request: vi.fn(async () => ({ message_id: 71 })), stop: vi.fn() }
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, acceptanceReceiptRoot: root,
      _toolContext: {} as never,
      acceptanceMarker: () => ({ scenarioHandleDigest: scenario }), migrateIdentity: async () => undefined,
      _runTurn: async (options) => {
        scenario = "b".repeat(64)
        await options.deliverySink.onDelivery({ kind: "settle", text: "must not escape" })
        return { response: "must not escape", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
      },
      api,
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { onMessage = options.onMessage; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      approvalRuntime: approvalRuntime as never,
    })
    await expect(onMessage({ updateId: 1, messageId: "2", userId: "42", chatId: "42", text: "hello" }))
      .rejects.toThrow("scenario ownership drift")
    expect(api.request).not.toHaveBeenCalled()
    await expect(app.stop()).rejects.toThrow("scenario ownership drift")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("fails closed when an acceptance scenario appears during an ordinary in-flight effect", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-scenario-appears-"))
    let marker: { scenarioHandleDigest: string } | null = null
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    let releaseTurn!: () => void
    let announceTurnStarted!: () => void
    const turnStarted = new Promise<void>((resolve) => { announceTurnStarted = resolve })
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve })
    const api = { request: vi.fn(async () => ({ message_id: 71 })), stop: vi.fn() }
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, acceptanceReceiptRoot: root,
      _toolContext: {} as never, acceptanceMarker: () => marker, migrateIdentity: async () => undefined,
      _runTurn: async (options) => {
        announceTurnStarted()
        await turnGate
        await options.deliverySink.onDelivery({ kind: "settle", text: "must not escape" })
        return { response: "must not escape", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
      },
      api, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { onMessage = options.onMessage; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      approvalRuntime: approvalRuntime as never,
    })
    try {
      const turn = onMessage({ updateId: 1, messageId: "2", userId: "42", chatId: "42", text: "hello" })
      await turnStarted
      marker = { scenarioHandleDigest: "a".repeat(64) }
      releaseTurn()
      await expect(turn).rejects.toThrow("acceptance audit verification failed")
      expect(api.request).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH))).toBe(false)
    } finally {
      await app.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("pins one scenario read before the initial barrier so marker races cannot acquire an unaudited owner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-scenario-pin-race-"))
    const scenarioHandleDigest = "a".repeat(64)
    let markerReadCount = 0
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const runTurn = vi.fn()
    const api = { request: vi.fn(async () => ({ message_id: 71 })), stop: vi.fn() }
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, acceptanceReceiptRoot: root,
      _toolContext: {} as never,
      acceptanceMarker: () => (++markerReadCount <= 2 ? null : { scenarioHandleDigest }),
      migrateIdentity: async () => undefined, _runTurn: runTurn,
      api, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { onMessage = options.onMessage; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      approvalRuntime: approvalRuntime as never,
    })
    try {
      await expect(onMessage({ updateId: 1, messageId: "2", userId: "42", chatId: "42", text: "hello" }))
        .rejects.toThrow("scenario ownership drift")
      expect(markerReadCount).toBe(3)
      expect(runTurn).not.toHaveBeenCalled()
      expect(api.request).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH))).toBe(false)
    } finally {
      await app.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("shares exact acceptance leases and rejects identity or scenario conflicts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-shared-audit-"))
    const scenarioHandleDigest = "a".repeat(64)
    const released = vi.fn()
    const apps: ReturnType<typeof createTelegramSenseApp>[] = []
    const create = (identityKey: string, scenario = scenarioHandleDigest) => createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey, _agentRoot: root, acceptanceReceiptRoot: root, _toolContext: {} as never,
      acceptanceMarker: () => ({ scenarioHandleDigest: scenario }), migrateIdentity: async () => undefined,
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      approvalRuntime: {
        transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
        coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
      } as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
      _acceptanceAuditReleaseHook: released,
    })
    try {
      apps.push(create("k".repeat(43)), create("k".repeat(43)), create("k".repeat(43)))
      expect(() => create("j".repeat(43))).toThrow("identity changed while active")
      expect(() => create("k".repeat(43), "b".repeat(64))).toThrow("scenario changed while active")
      await apps[0]!.stop()
      expect(released).not.toHaveBeenCalled()
      await apps[1]!.stop()
      expect(released).not.toHaveBeenCalled()
      await apps[2]!.stop()
      expect(released).toHaveBeenCalledOnce()
    } finally {
      await Promise.allSettled(apps.map((app) => app.stop()))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("poisons an explicitly owned audit event whose scenario does not match its lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-event-scenario-drift-"))
    const identityKey = "k".repeat(43)
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey, _agentRoot: root, acceptanceReceiptRoot: root, _toolContext: {} as never,
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }), migrateIdentity: async () => undefined,
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      approvalRuntime: {
        transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
        coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
      } as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
    })
    const logger = createLogger({ level: "info", sinks: [() => undefined] })
    logger.info({
      event: "senses.telegram_turn_start", component: "senses", message: "wrong scenario", trace_id: "trace",
      meta: { acceptanceAuditOwnerDigest: telegramAcceptanceAuditOwnerDigest(identityKey, "sanctuary", root), scenarioHandleDigest: "b".repeat(64) },
    })
    await expect(app.stop()).rejects.toThrow("Telegram sense cleanup failed")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("binds interactive control callbacks to the scenario active when each request arrives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-interactive-owner-"))
    let marker: { scenarioHandleDigest: string } | null = null
    let runRequest!: <T>(operation: () => T | Promise<T>) => Promise<T>
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, acceptanceReceiptRoot: root,
      _toolContext: {} as never, acceptanceMarker: () => marker, migrateIdentity: async () => undefined,
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      approvalRuntime: approvalRuntime as never,
      _createInteractiveControl: ((options) => {
        runRequest = options.runRequest!
        return { socketPath: path.join(root, "unused.sock"), start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
      }) as never,
    })
    try {
      marker = { scenarioHandleDigest: "a".repeat(64) }
      await runRequest(() => emitNervesEvent({
        component: "senses", event: "senses.telegram_turn_start", message: "interactive scenario A",
        meta: { scenarioHandleDigest: marker!.scenarioHandleDigest },
      }))
      marker = { scenarioHandleDigest: "b".repeat(64) }
      await runRequest(() => emitNervesEvent({
        component: "senses", event: "senses.telegram_turn_start", message: "interactive scenario B",
        meta: { scenarioHandleDigest: marker!.scenarioHandleDigest },
      }))
      const events = verifyTelegramAuditLedger({
        ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
        headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"),
        identityKey: "k".repeat(43),
      })
      expect(events.map(({ meta }) => meta.scenarioHandleDigest)).toEqual(["a".repeat(64), "b".repeat(64)])
    } finally {
      await app.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("records authenticated callback recovery settlement in the live chained ledger", async () => {
    const root = fs.mkdtempSync("/tmp/tgr-")
    const scenarioHandleDigest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const unsigned = {
      scenarioHandleDigest, approvalId: "approval-1", actionDigest: "1".repeat(64), targetDigest: "2".repeat(64),
      checkpointDigest: "3".repeat(64), suspendedSessionRevisionDigest: "4".repeat(64), messageIdDigest: "5".repeat(64),
      boundAt: 1_000, callbackAt: 1_100, acknowledgementState: "indeterminate_after_restart", accepted: true,
      reason: "accepted", recoveredAt: 1_200, decisionAttemptDigest: "6".repeat(64),
    }
    const meta = { ...unsigned, evidenceMac: sanctuaryTelegramApprovalEvidenceMac(identityKey, "telegram.callback_recovery_settled", unsigned) }
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(),
      recover: vi.fn(async () => { emitNervesEvent({ component: "senses", event: "telegram.callback_recovery_settled", message: "recovered", meta }) }),
      close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey, _agentRoot: root, _toolContext: {} as never, acceptanceReceiptRoot: root, acceptanceMarker: () => ({ scenarioHandleDigest }),
      migrateIdentity: async () => undefined, api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }), approvalRuntime: approvalRuntime as never,
    })
    await app.run()
    await app.stop()
    const events = verifyTelegramAuditLedger({
      ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
      headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"), identityKey,
    })
    expect(events).toContainEqual(expect.objectContaining({ event: "telegram.callback_recovery_settled", meta }))
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("dynamically binds a lazily activated scenario owner to timer expiry reconciliation", async () => {
    vi.useFakeTimers()
    const root = fs.mkdtempSync("/tmp/tgt-")
    const identityKey = "k".repeat(43)
    let marker: { scenarioHandleDigest: string } | null = null
    let finishPolling!: () => void
    const reconcileExpired = vi.fn(async () => {
      if (!marker) return
      const common = { scenarioHandleDigest: marker.scenarioHandleDigest, approvalId: "approval-1", evidenceMac: "f".repeat(64) }
      emitNervesEvent({ component: "senses", event: "telegram.approval_expiry_observed", message: "expired", meta: { ...common, expiryObservedAt: Date.now() } })
      emitNervesEvent({ component: "senses", event: "telegram.approval_prompt_terminalized", message: "terminal", meta: { ...common, buttonsRemoved: true, terminalizedAt: Date.now() } })
    })
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired, terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey, _agentRoot: root, _toolContext: {} as never, acceptanceReceiptRoot: root, acceptanceMarker: () => marker,
      migrateIdentity: async () => undefined, api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(() => new Promise<void>((resolve) => { finishPolling = resolve })), stop: vi.fn() }),
      approvalRuntime: approvalRuntime as never,
      _createInteractiveControl: (() => ({ start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) })) as never,
    })
    try {
      const running = app.run()
      await vi.waitFor(() => expect(reconcileExpired).toHaveBeenCalledOnce())
      marker = { scenarioHandleDigest: "a".repeat(64) }
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(reconcileExpired.mock.calls.length).toBeGreaterThanOrEqual(2))
      const events = verifyTelegramAuditLedger({
        ledgerRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8"),
        headRaw: fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "utf8"), identityKey,
      })
      expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining(["telegram.approval_expiry_observed", "telegram.approval_prompt_terminalized"]))
      finishPolling()
      await running
      await app.stop()
    } finally {
      vi.useRealTimers()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("propagates a live chained-ledger append failure before settlement cleanup", async () => {
    const root = fs.mkdtempSync("/tmp/tgf-")
    const scenarioHandleDigest = "a".repeat(64)
    let runtimeInput: any
    const runtime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, _toolContext: {} as never, acceptanceReceiptRoot: root,
      acceptanceMarker: () => ({ scenarioHandleDigest }),
      migrateIdentity: async () => undefined, api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      _createApprovalRuntime: ((input: unknown) => { runtimeInput = input; return runtime }) as never,
    })
    const unsigned = {
      scenarioHandleDigest, approvalId: "approval-1", actionDigest: "1".repeat(64), targetDigest: "2".repeat(64),
      checkpointDigest: "3".repeat(64), suspendedSessionRevisionDigest: "4".repeat(64), messageIdDigest: "5".repeat(64),
      boundAt: 1_000, callbackAt: 1_100, acknowledged: true, acknowledgementState: "acknowledged",
      accepted: true, reason: "accepted", decisionAttemptDigest: "6".repeat(64),
    }
    const meta = { ...unsigned, evidenceMac: sanctuaryTelegramApprovalEvidenceMac("k".repeat(43), "telegram.callback_settled", unsigned) }
    const ledgerPath = path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)
    fs.chmodSync(ledgerPath, 0o400)
    const durableSink = Object.assign(vi.fn(), { barrier: vi.fn(async () => undefined) })
    setRuntimeLogger(createLogger({ sinks: [durableSink] }))
    try {
      expect(runtimeInput.dependencies.acceptanceMarker()).toEqual({ scenarioHandleDigest })
      await expect(runtimeInput.dependencies.commitAcceptanceEvidence("telegram.callback_settled", meta))
        .rejects.toThrow(/EACCES|permission denied/iu)
      await expect(app.stop()).rejects.toThrow("Telegram sense cleanup failed")
    } finally {
      setRuntimeLogger(null)
      fs.chmodSync(ledgerPath, 0o600)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("durably emits both settlement kinds without a scenario lease and rejects unsupported kinds", async () => {
    const root = fs.mkdtempSync("/tmp/tg-no-lease-commit-")
    let runtimeInput: any
    const runtime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, _toolContext: {} as never, acceptanceMarker: () => null,
      migrateIdentity: async () => undefined, api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      _createApprovalRuntime: ((input: unknown) => { runtimeInput = input; return runtime }) as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
    })
    const durableSink = Object.assign(vi.fn(), { barrier: vi.fn(async () => undefined) })
    setRuntimeLogger(createLogger({ sinks: [durableSink] }))
    try {
      expect(runtimeInput.dependencies.acceptanceMarker()).toBeNull()
      await runtimeInput.dependencies.commitAcceptanceEvidence("telegram.callback_settled", {})
      await runtimeInput.dependencies.commitAcceptanceEvidence("telegram.callback_recovery_settled", {})
      await expect(runtimeInput.dependencies.commitAcceptanceEvidence("telegram.unsupported", {})).rejects.toThrow("unsupported")
    } finally {
      setRuntimeLogger(null)
      await app.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("surfaces release-hook failures alone and aggregates them with construction failures", async () => {
    const make = (root: string, failConstruction: boolean) => () => createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root, _toolContext: {} as never,
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }),
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      _createApprovalRuntime: failConstruction ? (() => { throw new Error("construction failed") }) as never : undefined,
      approvalRuntime: failConstruction ? undefined : {
        transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
        coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
      } as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
      _acceptanceAuditReleaseHook: () => { throw new Error("release failed") },
    })
    const stopRoot = fs.mkdtempSync("/tmp/tg-release-stop-")
    const constructionRoot = fs.mkdtempSync("/tmp/tg-release-construction-")
    try {
      const app = make(stopRoot, false)()
      await expect(app.stop()).rejects.toThrow("release failed")
      expect(make(constructionRoot, true)).toThrow("construction and audit release failed")
    } finally {
      fs.rmSync(stopRoot, { recursive: true, force: true })
      fs.rmSync(constructionRoot, { recursive: true, force: true })
    }
  })

  it("aggregates poisoned-ledger retirement with release-hook failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-retirement-errors-"))
    const identityKey = "k".repeat(43)
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey, _agentRoot: root, acceptanceReceiptRoot: root, _toolContext: {} as never,
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }), migrateIdentity: async () => undefined,
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      approvalRuntime: {
        transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
        coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
      } as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
      _acceptanceAuditReleaseHook: () => { throw new Error("release failed") },
    })
    const logger = createLogger({ level: "info", sinks: [() => undefined] })
    logger.info({
      event: "senses.telegram_turn_start", component: "senses", message: "wrong scenario", trace_id: "trace",
      meta: { acceptanceAuditOwnerDigest: telegramAcceptanceAuditOwnerDigest(identityKey, "sanctuary", root), scenarioHandleDigest: "b".repeat(64) },
    })
    try {
      await expect(app.stop()).rejects.toThrow("Telegram sense cleanup failed")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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

  it("journals an authorized reply before sending and does not resend an accepted retry", async () => {
    const f = fixture()
    const inbound = { updateId: 91, messageId: "92", userId: "42", chatId: "42", text: "health?" }

    await f.getOnMessage()(inbound)
    await f.getOnMessage()(inbound)

    expect(f.api.request).toHaveBeenCalledTimes(1)
    const journalRoot = path.join(f.agentRoot, "state", "telegram", "effects")
    const artifacts = fs.readdirSync(journalRoot).filter((name) => name.endsWith(".json"))
    expect(artifacts).toHaveLength(1)
    const artifact = JSON.parse(fs.readFileSync(path.join(journalRoot, artifacts[0]!), "utf8"))
    expect(artifact).toMatchObject({
      idempotencyKey: expect.stringMatching(/^turn:tg_[A-Za-z0-9_-]{43}:91:delivery:0$/u),
      authorClass: "butler",
      effect: { kind: "text", text: "All systems nominal." },
      parts: [{ state: "session_recorded", messageId: 71 }],
    })
  })

  it("requires the real relationship authority before preparing and again before sending", async () => {
    const denied = fixture({ authorizeEffect: vi.fn(() => ({ allowed: false, reason: "revoked" })) })
    await expect(denied.getOnMessage()({ updateId: 911, messageId: "912", userId: "42", chatId: "42", text: "health?" })).rejects.toThrow("revoked")
    expect(denied.api.request).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(denied.agentRoot, "state", "telegram", "effects"))).toBe(false)

    const phases: string[] = []
    const allowed = fixture({ authorizeEffect: vi.fn((input: any) => { phases.push(input.phase); return { allowed: true, receiptId: `actual-${input.phase}`, expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "42" } } }) })
    await allowed.getOnMessage()({ updateId: 913, messageId: "914", userId: "42", chatId: "42", text: "health?" })
    expect(phases).toEqual(["prepare", "send"])
    const file = fs.readdirSync(path.join(allowed.agentRoot, "state", "telegram", "effects"))[0]!
    expect(JSON.parse(fs.readFileSync(path.join(allowed.agentRoot, "state", "telegram", "effects", file), "utf8")).authorizationReceiptId).toBe("actual-send")
  })

  it("records every accepted Telegram chunk as a Butler-authored session artifact", async () => {
    let sessionPath = ""
    const f = fixture({
      runTurn: vi.fn(async (options: any) => {
        sessionPath = path.join(f.agentRoot, "state", "sessions", options.friendId, "telegram", "turn.json")
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
        fs.writeFileSync(sessionPath, JSON.stringify({
          version: 2,
          events: [{
            id: "evt-000001", sequence: 1, role: "assistant", content: "A useful answer.", name: null, toolCallId: null, toolCalls: [], attachments: [],
            time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: "2026-08-29T17:00:00.000Z", recordedAtSource: "save" },
            relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
            provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
          }],
          projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
          lastUsage: null,
          state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
        }))
        await options.deliverySink.onDelivery({ kind: "settle", text: "A useful answer." })
        return { response: "A useful answer.", ponderDeferred: false, deliveries: [], deliveryFailures: [], sessionPath, causalSessionEventIds: ["evt-000001"] }
      }),
    })

    await f.getOnMessage()({ updateId: 93, messageId: "94", userId: "42", chatId: "42", text: "help" })

    const envelope = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
    expect(envelope.events).toEqual([expect.objectContaining({
      role: "assistant",
      content: "A useful answer.",
      relations: expect.objectContaining({ references: expect.arrayContaining([expect.stringMatching(/^telegram-artifact:/), "telegram-message:71"]) }),
    })])
    const artifactName = fs.readdirSync(path.join(f.agentRoot, "state", "telegram", "effects"))[0]!
    expect(JSON.parse(fs.readFileSync(path.join(f.agentRoot, "state", "telegram", "effects", artifactName), "utf8")).parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: "evt-000001" })
  })

  it("binds transcript-readback delivery and replies to its persisted canonical assistant event", async () => {
    let sessionPath = ""
    const f = fixture({
      runTurn: vi.fn(async (options: any) => {
        sessionPath = getSenseSessionPath("butler", options.friendId, "telegram", options.sessionKey, f.agentRoot)
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
        const firstTurn = !fs.existsSync(sessionPath)
        if (firstTurn) fs.writeFileSync(sessionPath, JSON.stringify({
          version: 2,
          events: [{
            id: "evt-000001", sequence: 1, role: "assistant", content: "Recovered canonical answer.", name: null, toolCallId: null, toolCalls: [], attachments: [],
            time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: "2026-08-29T17:00:00.000Z", recordedAtSource: "save" },
            relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
            provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
          }],
          projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
          lastUsage: null,
          state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
        }))
        return { response: "Recovered canonical answer.", ponderDeferred: false, deliveries: [], deliveryFailures: [], sessionPath, ...(firstTurn ? { responseCausalSessionEventId: "evt-000001" } : {}) }
      }),
    })

    await f.getOnMessage()({ updateId: 915, messageId: "916", userId: "42", chatId: "42", text: "recover it" })

    expect(f.api.request).toHaveBeenCalledOnce()
    const envelope = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
    expect(envelope.events).toHaveLength(1)
    expect(envelope.events[0]).toMatchObject({ id: "evt-000001", role: "assistant", content: "Recovered canonical answer." })
    expect(envelope.events[0].relations.references).toEqual(expect.arrayContaining([expect.stringMatching(/^telegram-artifact:/u), "telegram-message:71"]))
    const artifactRoot = path.join(f.agentRoot, "state", "telegram", "effects")
    const artifact = JSON.parse(fs.readFileSync(path.join(artifactRoot, fs.readdirSync(artifactRoot)[0]!), "utf8"))
    expect(artifact.parts[0]).toMatchObject({ state: "session_recorded", messageId: 71, sessionEventId: "evt-000001" })

    await f.getOnMessage()({ updateId: 917, messageId: "918", userId: "42", chatId: "42", text: "what did you mean?", replyToMessageId: "71" })
    expect(f.runTurn.mock.calls[1]![0].ingressRelations.replyToEventId).toBe("evt-000001")
  })

  it("repairs the exact inbound before accepted output when an existing-session turn fails", async () => {
    let sessionPath = ""
    const f = fixture({
      runTurn: vi.fn(async (options: any) => {
        sessionPath = getSenseSessionPath("butler", options.friendId, "telegram", options.sessionKey, f.agentRoot)
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
        fs.writeFileSync(sessionPath, JSON.stringify({
          version: 2,
          events: [{ id: "evt-000001", sequence: 1, role: "user", content: "older", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "unknown", observedAt: null, observedAtSource: "ingest", recordedAt: "2026-08-29T17:00:00.000Z", recordedAtSource: "save" }, relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null } }],
          projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
          lastUsage: null,
          state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
        }))
        await options.deliverySink.onDelivery({ kind: "speak", text: "I started checking." })
        throw new Error("provider failed after speak")
      }),
    })

    await f.getOnMessage()({ updateId: 930, messageId: "931", userId: "42", chatId: "42", text: "Please check it" })

    const events = JSON.parse(fs.readFileSync(sessionPath, "utf8")).events
    expect(events.map((event: any) => [event.role, event.content])).toEqual([
      ["user", "older"],
      ["user", "Please check it"],
      ["assistant", "I started checking."],
    ])
    expect(events[1].relations.references).toContain(inboundReference(930, "931"))
  })

  it("binds a Telegram reply to the exact recorded artifact and request", async () => {
    const f = fixture()
    await f.getOnMessage()({ updateId: 95, messageId: "96", userId: "42", chatId: "42", text: "first" })
    const journalRoot = path.join(f.agentRoot, "state", "telegram", "effects")
    const artifactPath = path.join(journalRoot, fs.readdirSync(journalRoot)[0]!)
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"))
    artifact.target.requestId = "req-7"
    artifact.parts[0].state = "session_recorded"
    artifact.parts[0].sessionEventId = "evt-000007"
    fs.writeFileSync(artifactPath, JSON.stringify(artifact))
    const firstTurn = f.runTurn.mock.calls[0]![0]
    const replySessionPath = getSenseSessionPath("butler", firstTurn.friendId, "telegram", firstTurn.sessionKey, f.agentRoot)
    fs.mkdirSync(path.dirname(replySessionPath), { recursive: true })
    fs.writeFileSync(replySessionPath, JSON.stringify({
      version: 2,
      events: [{ id: "evt-000007", sequence: 7, role: "assistant", content: "All systems nominal.", name: "telegram-butler", toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: "2026-08-29T18:00:00.000Z", recordedAtSource: "save" }, relations: { replyToEventId: null, threadRootEventId: null, references: [`telegram-artifact:${artifact.id}`, "telegram-message:71"], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "synthetic", legacyVersion: null, sourceMessageIndex: null } }],
      projection: { eventIds: ["evt-000007"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }))

    await f.getOnMessage()({ updateId: 97, messageId: "98", userId: "42", chatId: "42", text: "that one", replyToMessageId: "71" })

    expect(f.runTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      ingressRelations: {
        replyToEventId: "evt-000007",
        threadRootEventId: null,
        references: [inboundReference(97, "98"), `telegram-artifact:${artifact.id}`, "request:req-7"],
      },
    }))
  })

  it("persists one HMAC-bound acceptance receipt with observed provider, tool, and delivery counts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-acceptance-receipt-"))
    const runTurn = vi.fn(async (options: any) => {
      await options.deliverySink.onDelivery({ kind: "settle", text: "The model's unconstrained prose must not become the live fact claim." })
      return { response: "The model's unconstrained prose must not become the live fact claim.", ponderDeferred: false, deliveries: [{ kind: "settle", text: "The model's unconstrained prose must not become the live fact claim." }], deliveryFailures: [], providerInvocationCount: 2, toolInvocationCount: 1 }
    })
    const grounding = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
    const groundingHash = createHash("sha256").update(JSON.stringify(grounding)).digest("hex")
    const runWithToolReceiptCollection = async (operation: () => Promise<unknown>, observer: { toolResultDigests: string[]; toolGroundings?: unknown[] }) => {
      observer.toolResultDigests.push(HEX_DIGEST)
      observer.toolGroundings?.push({ toolName: "unraid_get_system", resultDigest: HEX_DIGEST, groundingDigest: groundingHash, sourceIdentityDigest: "9".repeat(64), observedAt: "2026-08-20T16:00:00.000Z", facts: grounding })
      return { result: await operation(), toolResultDigests: [...observer.toolResultDigests], toolGroundings: [...(observer.toolGroundings ?? [])] }
    }
    const f = fixture({ acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64), label: "unit-16d-whats-up" }), acceptanceReceiptRoot: root, runTurn, runWithToolReceiptCollection })

    await f.getOnMessage()({ updateId: 9, messageId: "10", userId: "42", chatId: "42", text: "status" })

    const receipt = JSON.parse(fs.readFileSync(path.join(root, "state", "acceptance", "telegram-turns.ndjson"), "utf8"))
    const v4Digest = (purpose: string, value: string) => sanctuaryTelegramTurnReceiptDigest(RECEIPT_KEY, "sanctuary-telegram-turn-receipt-v4", purpose, value)
    const canonicalText = "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded."
    const deliveries = [{ messageIdDigest: v4Digest("delivery", "71"), chunkDigest: v4Digest("chunk", canonicalText), redactedText: canonicalText, utf16Units: canonicalText.length }]
    expect(receipt).toMatchObject({ schemaVersion: "sanctuary-telegram-turn-receipt-v4", scenarioHandleDigest: "a".repeat(64), status: "success", errorCategory: null, providerInvocationCount: 2, toolInvocationCount: 1, deliveryCount: 1, updateDigest: v4Digest("update", ["9", "10"].join("\0")), sequenceDigest: v4Digest("sequence", "9"), responseDigest: v4Digest("response", JSON.stringify(deliveries)), deliveries, toolGroundings: [{ toolName: "unraid_get_system", resultDigest: HEX_DIGEST, groundingDigest: groundingHash, sourceIdentityDigest: "9".repeat(64), observedAt: "2026-08-20T16:00:00.000Z", facts: grounding }], receiptMac: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(receipt.receiptMac).toBe(sanctuaryTelegramTurnReceiptMac(RECEIPT_KEY, receipt))
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: canonicalText, parse_mode: "HTML" }, undefined)
    expect(JSON.stringify(receipt)).not.toContain('"updateId":9')
    expect(JSON.stringify(receipt)).not.toContain('"messageId":"10"')
  })

  it("normalizes only canonical grounded query intents and fails closed on multiple model deliveries", async () => {
    const grounding = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
    const groundingHash = createHash("sha256").update(JSON.stringify(grounding)).digest("hex")
    const collect = async (operation: () => Promise<unknown>, observer: { toolResultDigests: string[]; toolGroundings?: unknown[] }) => {
      observer.toolResultDigests.push(HEX_DIGEST)
      observer.toolGroundings?.push({ toolName: "unraid_get_system", resultDigest: HEX_DIGEST, groundingDigest: groundingHash, sourceIdentityDigest: "9".repeat(64), observedAt: "2026-08-20T16:00:00.000Z", facts: grounding })
      return { result: await operation(), toolResultDigests: [...observer.toolResultDigests], toolGroundings: [...(observer.toolGroundings ?? [])] }
    }
    const ordinary = fixture({
      runWithToolReceiptCollection: collect,
      runTurn: async (options: any) => {
        await options.deliverySink.onDelivery({ kind: "settle", text: "Ordinary grounded prose remains under agent control." })
        return { response: "Ordinary grounded prose remains under agent control.", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
      },
    })
    await ordinary.getOnMessage()({ updateId: 20, messageId: "21", userId: "42", chatId: "42", text: "Explain the server architecture" })
    expect(ordinary.api.request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: "Ordinary grounded prose remains under agent control.", parse_mode: "HTML" }, undefined)

    const ordinaryStatus = fixture({
      runWithToolReceiptCollection: collect,
      runTurn: async (options: any) => {
        await options.deliverySink.onDelivery({ kind: "settle", text: "Books is off because you asked me to keep it off. Everything else I checked is healthy." })
        return { response: "Books is off because you asked me to keep it off. Everything else I checked is healthy.", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
      },
    })
    await ordinaryStatus.getOnMessage()({ updateId: 21, messageId: "22", userId: "42", chatId: "42", text: "status" })
    expect(ordinaryStatus.api.request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: "Books is off because you asked me to keep it off. Everything else I checked is healthy.", parse_mode: "HTML" }, undefined)

    const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-grounded-duplicate-"))
    const duplicate = fixture({
      acceptanceMarker: () => ({ scenarioHandleDigest: "d".repeat(64), label: "unit-16d-whats-up" }),
      acceptanceReceiptRoot: duplicateRoot,
      runWithToolReceiptCollection: collect,
      runTurn: async (options: any) => {
        await options.deliverySink.onDelivery({ kind: "settle", text: "first" })
        await options.deliverySink.onDelivery({ kind: "settle", text: "second" })
        return { response: "second", ponderDeferred: false, deliveries: [], deliveryFailures: [] }
      },
    })
    await duplicate.getOnMessage()({ updateId: 22, messageId: "23", userId: "42", chatId: "42", text: "what's up?" })
    expect(duplicate.api.request).toHaveBeenCalledOnce()
    expect(duplicate.api.request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: "I couldn't complete that turn. The failure was recorded; please try again.", parse_mode: "HTML" }, undefined)
    expect(JSON.parse(fs.readFileSync(receiptPath(duplicateRoot), "utf8"))).toMatchObject({ status: "error", deliveryCount: 1 })
    fs.rmSync(duplicateRoot, { recursive: true, force: true })
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

  it("lets a concurrently queued receipt proceed through a rejected predecessor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-ledger-concurrent-failure-"))
    const f = fixture({
      acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root,
      afterAcceptanceLedgerPreReadStat: () => { throw new Error("synthetic receipt read failure") },
    })
    writeLedger(root, [JSON.stringify(validTurnReceipt())])
    await Promise.all([
      f.getOnMessage()({ updateId: 40, messageId: "41", userId: "42", chatId: "42", text: "first" }),
      f.getOnMessage()({ updateId: 42, messageId: "43", userId: "42", chatId: "42", text: "second" }),
    ])
    expect(readLedger(root)).toHaveLength(1)
  })

  it("records message identifiers when a response-only turn uses fallback delivery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-response-only-"))
    const f = fixture({
      acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root,
      runTurn: vi.fn(async () => ({ response: "response only", deliveries: [], deliveryFailures: [], ponderDeferred: false })),
    })
    await f.getOnMessage()({ updateId: 44, messageId: "45", userId: "42", chatId: "42", text: "hello" })
    expect(readLedger(root)[0]).toMatchObject({ deliveryCount: 1, deliveries: [{ messageIdDigest: expect.any(String), chunkDigest: expect.any(String) }] })
  })

  it("classifies storage wording and records a non-Error receipt persistence failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-storage-nonerror-"))
    writeLedger(root, [JSON.stringify(validTurnReceipt())])
    const f = fixture({
      acceptanceMarker: () => ({ scenarioHandleDigest: HEX_DIGEST }), acceptanceReceiptRoot: root,
      afterAcceptanceLedgerPreReadStat: () => { throw "non-error" },
    })
    await f.getOnMessage()({ updateId: 46, messageId: "47", userId: "42", chatId: "42", text: "how much storage is left?" })
    expect(readLedger(root)).toHaveLength(1)
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

  it("separates opaque friend and session identity across bot-token rotation", async () => {
    const first = fixture({ botToken: "old-token" })
    const rotated = fixture({ botToken: "rotated-token" })
    await first.getOnMessage()({ updateId: 1, messageId: "1", userId: "42", chatId: "42", text: "before" })
    await rotated.getOnMessage()({ updateId: 2, messageId: "2", userId: "42", chatId: "42", text: "after" })

    const firstTurn = first.runTurn.mock.calls[0]![0]
    const rotatedTurn = rotated.runTurn.mock.calls[0]![0]
    expect(rotatedTurn.friendId).not.toBe(firstTurn.friendId)
    expect(rotatedTurn.sessionKey).not.toBe(firstTurn.sessionKey)
    expect(rotatedTurn.identity).not.toEqual(firstTurn.identity)
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
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(6)
    finishPolling()
    await stopping
    await running
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(7)
    vi.useRealTimers()
  })

  it("keeps reconciliation on absolute one-second deadlines after a delayed prior pass", async () => {
    vi.useFakeTimers()
    let releaseReconcile!: () => void
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseReconcile = resolve }))
      .mockResolvedValue(undefined)

    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(800)
    releaseReconcile()
    await vi.advanceTimersByTimeAsync(199)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(3)

    const stopping = f.app.stop()
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
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(4)

    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("keeps the absolute one-second observer cadence through repeated reconciliation failures", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("one approval terminalization remains unavailable"))

    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(6)

    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("starts polling and the absolute observer when startup reconciliation fails", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired.mockRejectedValueOnce(new Error("startup edit unavailable")).mockResolvedValue(undefined)
    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.poll.run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
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

  it("keeps the one-second expiry observer alive until polling shutdown joins and performs a final pass", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(0)
    const stopping = f.app.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.approvalTransport.reconcileExpired.mock.calls.length).toBeGreaterThanOrEqual(3)
    finishPolling()
    await stopping
    await running
    expect(f.approvalTransport.reconcileExpired.mock.calls.length).toBeGreaterThanOrEqual(4)
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

  it("keeps Telegram available when routine recovery needs later inspection", async () => {
    const recoverRoutineActions = vi.fn(async () => { throw new Error("Unraid offline") })
    const poll = { pollOnce: vi.fn(), run: vi.fn(async () => undefined), stop: vi.fn() }
    const approvalRuntime = {
      transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), terminalizeRecovered: vi.fn(), reconcileExpired: vi.fn(async () => undefined) },
      coordinator: vi.fn(), recover: vi.fn(async () => undefined), close: vi.fn(), legacySubjects: vi.fn(() => []), migrateIdentity: vi.fn(),
    }
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43),
      _agentRoot: fs.mkdtempSync(path.join(os.tmpdir(), "telegram-routine-recovery-")),
      _toolContext: { sanctuary: { recoverRoutineActions } } as never,
      migrateIdentity: async () => undefined,
      api: { request: vi.fn(), stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => poll,
      approvalRuntime: approvalRuntime as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
    })
    await expect(app.run()).resolves.toBeUndefined()
    expect(recoverRoutineActions).toHaveBeenCalledOnce()
    expect(poll.run).toHaveBeenCalledOnce()
    await app.stop()
  })

  it("never stops the one-second observer after persistent reconciliation failures", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("persistent failure"))
    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(41)
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

    expect(order).toEqual(["recover", "reconcile", "poll", "reconcile"])
  })

  it("supports proactive private delivery through the same bounded formatter", async () => {
    const f = fixture()
    await f.app.sendProactive("Array recovered")
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "42",
      text: "Array recovered",
      parse_mode: "HTML",
    }, undefined)
    const root = path.join(f.agentRoot, "state", "telegram", "effects")
    const artifact = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]!), "utf8"))
    expect(artifact).toMatchObject({ authorClass: "butler", effect: { kind: "text", text: "Array recovered" }, parts: [{ state: "session_recorded", messageId: 71 }] })
  })

  it("records proactive text as a new event when an older assistant event has identical text", async () => {
    const f = fixture()
    const subject = opaqueTelegramSubject("k".repeat(43), "test-token", "42", "42")
    const sessionPath = getSenseSessionPath("butler", `telegram-user:${subject}`, "telegram", `telegram:${subject}`, f.agentRoot)
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    fs.writeFileSync(sessionPath, JSON.stringify({
      version: 2,
      events: [{
        id: "evt-000001", sequence: 1, role: "assistant", content: "Array recovered", name: null, toolCallId: null, toolCalls: [], attachments: [],
        time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: "2026-08-29T17:00:00.000Z", recordedAtSource: "save" },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      }],
      projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }))

    await f.app.sendProactive("Array recovered")

    const envelope = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
    expect(envelope.events.map((event: any) => event.content)).toEqual(["Array recovered", "Array recovered"])
    expect(envelope.events[0].relations.references).toEqual([])
    expect(envelope.events[1].relations.references).toEqual(expect.arrayContaining([expect.stringMatching(/^telegram-artifact:/u), "telegram-message:71"]))
    const artifactRoot = path.join(f.agentRoot, "state", "telegram", "effects")
    const artifact = JSON.parse(fs.readFileSync(path.join(artifactRoot, fs.readdirSync(artifactRoot)[0]!), "utf8"))
    expect(artifact.parts[0]).toMatchObject({ state: "session_recorded", messageId: 71, sessionEventId: "evt-000002" })

    await f.getOnMessage()({ updateId: 1518, messageId: "1519", userId: "42", chatId: "42", text: "What did you mean?", replyToMessageId: "71" })
    expect(f.runTurn.mock.calls[0]![0].ingressRelations.replyToEventId).toBe("evt-000002")
  })

  it("leaves startup health to the evidence-producing native habit", async () => {
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

    expect(order).toEqual([])
    expect(healthSweep).not.toHaveBeenCalled()
  })

  it("does not attempt legacy health delivery even when Telegram would fail", async () => {
    const healthSweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", deliveryId: "delivery-1" })),
      { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() },
    )
    const f = fixture({ healthSweep })
    ;(f.api.request as any).mockRejectedValue(new Error("offline"))

    await f.app.run()

    expect(healthSweep.markDeliveryAttempting).not.toHaveBeenCalled()
    expect(healthSweep.markDelivered).not.toHaveBeenCalled()
    expect(f.api.request).not.toHaveBeenCalled()
  })
})
