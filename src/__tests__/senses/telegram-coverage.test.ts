import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createLogger } from "../../nerves"
import { TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH } from "../../senses/telegram-audit-ledger"

const mocks = vi.hoisted(() => ({
  getAgentRoot: vi.fn(),
  readRuntimeCredentialConfig: vi.fn(),
  runSenseTurn: vi.fn(),
  createTelegramBotApi: vi.fn(),
  createTelegramLongPoll: vi.fn(),
  sendTelegramText: vi.fn(),
  createSanctuaryToolContext: vi.fn(() => ({ sanctuary: true })),
  createSanctuaryInteractiveControl: vi.fn(() => ({ start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) })),
  runWithSanctuaryToolReceiptCollection: vi.fn(async (operation: () => Promise<unknown>, observer?: { toolResultDigests: string[] }) => {
    const result = await operation()
    return { result, toolResultDigests: [...(observer?.toolResultDigests ?? [])] }
  }),
  createTelegramApprovalRuntime: vi.fn(),
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({ getAgentRoot: mocks.getAgentRoot }))
vi.mock("../../heart/runtime-credentials", () => ({ readRuntimeCredentialConfig: mocks.readRuntimeCredentialConfig }))
vi.mock("../../senses/shared-turn", () => ({ runSenseTurn: mocks.runSenseTurn }))
vi.mock("../../senses/sanctuary-runtime", () => ({
  createSanctuaryToolContext: mocks.createSanctuaryToolContext,
  runWithSanctuaryToolReceiptCollection: mocks.runWithSanctuaryToolReceiptCollection,
}))
vi.mock("../../senses/sanctuary-interactive-control", () => ({ createSanctuaryInteractiveControl: mocks.createSanctuaryInteractiveControl }))
vi.mock("../../senses/telegram-approval-runtime", () => ({ createTelegramApprovalRuntime: mocks.createTelegramApprovalRuntime }))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: mocks.emitNervesEvent }))
vi.mock("../../senses/telegram-client", async (importActual) => ({
  ...await importActual<typeof import("../../senses/telegram-client")>(),
  createTelegramBotApi: mocks.createTelegramBotApi,
  createTelegramLongPoll: mocks.createTelegramLongPoll,
  sendTelegramText: mocks.sendTelegramText,
}))

import {
  createTelegramSenseApp,
  loadTelegramSenseCredentials,
  migrateTelegramFriendIdentity,
  migrateTelegramSessionIdentity,
  parseTelegramSenseCredentials,
  readOrCreateTelegramIdentityKey,
  startTelegramSenseApp,
  telegramAcceptanceAuditOwnerDigest,
} from "../../senses/telegram"

const credentials = { botToken: "synthetic-test-token", authorizedUserId: "42", authorizedChatId: "43" }
const isolatedRoots: string[] = []
let isolatedRoot = ""

function defaultFixture() {
  let onMessage: ((message: any) => Promise<void>) | undefined
  let onUpdate: ((update: any) => Promise<boolean>) | undefined
  const poll = { pollOnce: vi.fn(), run: vi.fn(async () => undefined), stop: vi.fn() }
  const api = { request: vi.fn(), stop: vi.fn() }
  const transport = {
    sendApproval: vi.fn(), handleUpdate: vi.fn(async () => ({ handled: true })), reconcileExpired: vi.fn(),
    terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []),
  }
  const runtime = {
    transport,
    coordinator: vi.fn(),
    legacySubjects: vi.fn(() => []),
    migrateIdentity: vi.fn(),
    recover: vi.fn(),
    close: vi.fn(),
  }
  mocks.createTelegramBotApi.mockReturnValue(api)
  mocks.createTelegramLongPoll.mockImplementation((options: any) => {
    onMessage = options.onMessage
    onUpdate = options.onUpdate
    return poll
  })
  mocks.createTelegramApprovalRuntime.mockReturnValue(runtime)
  mocks.sendTelegramText.mockResolvedValue([71])
  mocks.runSenseTurn.mockResolvedValue({ response: "fallback", deliveries: [], deliveryFailures: [], ponderDeferred: false })
  return { api, poll, runtime, transport, getOnMessage: () => onMessage!, getOnUpdate: () => onUpdate! }
}

beforeEach(() => {
  vi.clearAllMocks()
  isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-coverage-"))
  isolatedRoots.push(isolatedRoot)
  mocks.getAgentRoot.mockReturnValue(isolatedRoot)
  mocks.readRuntimeCredentialConfig.mockReturnValue({ ok: true, config: {
    telegramBotToken: ` ${credentials.botToken} `,
    telegramAuthorizedUserId: " 42 ",
    telegramAuthorizedChatId: "43",
  } })
})

afterEach(() => {
  for (const root of isolatedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram sense coverage contracts", () => {
  const acceptanceEvent = (name = "senses.telegram_turn_start") => ({
    event: name,
    trace_id: "acceptance-trace",
    component: "senses",
    message: "scenario-bound Telegram event",
    meta: { scenarioHandleDigest: "a".repeat(64) },
  })

  const emitGlobal = (entry: ReturnType<typeof acceptanceEvent>) => {
    createLogger({ level: "info", sinks: [() => undefined], now: () => new Date("2026-08-20T20:00:00.000Z") }).info(entry)
  }

  it("creates one durable mode-0600 identity key in a repaired mode-0700 directory and rejects corrupt or permissive keys", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-identity-"))
    try {
      const directory = path.join(root, "state", "senses", "telegram")
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
      fs.chmodSync(directory, 0o755)
      const first = readOrCreateTelegramIdentityKey(root)
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(readOrCreateTelegramIdentityKey(root)).toBe(first)
      const keyPath = path.join(directory, "identity.key")
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)
      fs.writeFileSync(keyPath, "invalid\n", { mode: 0o600 })
      expect(() => readOrCreateTelegramIdentityKey(root)).toThrow("identity key is invalid")
      fs.writeFileSync(keyPath, `${first}\n`, { mode: 0o600 })
      fs.chmodSync(keyPath, 0o644)
      expect(() => readOrCreateTelegramIdentityKey(root)).toThrow("permissions are invalid")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("publishes a fully durable identity key atomically and never follows a Telegram-directory symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-atomic-"))
    const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-symlink-"))
    const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-target-"))
    try {
      const keyPath = path.join(root, "state", "senses", "telegram", "identity.key")
      expect(() => readOrCreateTelegramIdentityKey(root, {
        beforePublish: (temporaryPath, finalPath) => {
          expect(finalPath).toBe(keyPath)
          expect(fs.existsSync(finalPath)).toBe(false)
          expect(fs.statSync(temporaryPath).mode & 0o777).toBe(0o600)
          expect(fs.readFileSync(temporaryPath, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}\n$/u)
          throw new Error("synthetic pre-publication crash")
        },
      })).toThrow("synthetic pre-publication crash")
      expect(fs.existsSync(keyPath)).toBe(false)
      expect(fs.readdirSync(path.dirname(keyPath))).toEqual([])

      const senses = path.join(symlinkRoot, "state", "senses")
      fs.mkdirSync(senses, { recursive: true })
      fs.symlinkSync(symlinkTarget, path.join(senses, "telegram"), "dir")
      expect(() => readOrCreateTelegramIdentityKey(symlinkRoot)).toThrow(/symbolic link|directory/u)
      expect(fs.readdirSync(symlinkTarget)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(symlinkRoot, { recursive: true, force: true })
      fs.rmSync(symlinkTarget, { recursive: true, force: true })
    }
  })

  it("cleans unpublished identity-key temporaries and rejects non-directory or non-regular identity paths", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-temp-cleanup-"))
    const linkFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-link-failure-"))
    const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-file-root-"))
    const keyDirectoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-directory-"))
    try {
      expect(() => readOrCreateTelegramIdentityKey(temporaryRoot, {
        afterCreateTemporary: () => { throw new Error("synthetic temporary failure") },
      })).toThrow("synthetic temporary failure")
      expect(fs.readdirSync(path.join(temporaryRoot, "state", "senses", "telegram"))).toEqual([])

      expect(() => readOrCreateTelegramIdentityKey(linkFailureRoot, {
        beforePublish: (temporaryPath) => { fs.unlinkSync(temporaryPath) },
      })).toThrow()

      const telegramFile = path.join(fileRoot, "state", "senses", "telegram")
      fs.mkdirSync(path.dirname(telegramFile), { recursive: true })
      fs.writeFileSync(telegramFile, "not a directory")
      expect(() => readOrCreateTelegramIdentityKey(fileRoot)).toThrow("not a directory")

      const keyDirectory = path.join(keyDirectoryRoot, "state", "senses", "telegram", "identity.key")
      fs.mkdirSync(keyDirectory, { recursive: true })
      expect(() => readOrCreateTelegramIdentityKey(keyDirectoryRoot)).toThrow("permissions are invalid")

      const permissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-directory-permission-"))
      try {
        expect(() => readOrCreateTelegramIdentityKey(permissionRoot, {
          afterOpenDirectory: (handle) => { fs.fchmodSync(handle, 0o755) },
        })).toThrow("directory permissions are invalid")
      } finally {
        fs.rmSync(permissionRoot, { recursive: true, force: true })
      }
    } finally {
      for (const root of [temporaryRoot, linkFailureRoot, fileRoot, keyDirectoryRoot]) {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it("adopts a concurrently created identity key and propagates unrelated create failures", () => {
    const concurrentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-race-"))
    const failingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-key-failure-"))
    const concurrentKey = "b".repeat(43)
    try {
      expect(readOrCreateTelegramIdentityKey(concurrentRoot, { beforeCreate: (keyPath) => {
        fs.writeFileSync(keyPath, `${concurrentKey}\n`, { flag: "wx", mode: 0o600 })
      } })).toBe(concurrentKey)
      expect(() => readOrCreateTelegramIdentityKey(failingRoot, { beforeCreate: (keyPath) => {
        fs.rmSync(path.dirname(keyPath), { recursive: true, force: true })
      } })).toThrow()
    } finally {
      fs.rmSync(concurrentRoot, { recursive: true, force: true })
      fs.rmSync(failingRoot, { recursive: true, force: true })
    }
  })

  it("migrates legacy Friend, session, pending, and return paths without retaining raw IDs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-migration-"))
    const rawUser = "918273645012345678"
    const rawChat = "817263540123456789"
    const subject = `tg_${"a".repeat(43)}`
    const legacyFriend = `telegram-user:${rawUser}`
    const friendPath = path.join(root, "friends", "friend-1.json")
    fs.mkdirSync(path.dirname(friendPath), { recursive: true })
    fs.writeFileSync(friendPath, JSON.stringify({
      id: "friend-1", name: `Telegram user ${rawUser}`, role: "friend", trustLevel: "family",
      externalIds: [{ provider: "telegram-user", externalId: rawUser, linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
    }))
    const session = path.join(root, "state", "sessions", legacyFriend, "telegram", `telegram_${rawChat}.json`)
    const pending = path.join(root, "state", "pending", legacyFriend, "telegram", `telegram:${rawChat}`)
    const returns = path.join(root, "state", "pending-returns", legacyFriend)
    fs.mkdirSync(path.dirname(session), { recursive: true })
    fs.writeFileSync(session, "{}")
    fs.mkdirSync(pending, { recursive: true })
    fs.mkdirSync(returns, { recursive: true })
    try {
      migrateTelegramSessionIdentity(root, rawUser, rawChat, subject)
      await migrateTelegramFriendIdentity(root, rawUser, subject)
      migrateTelegramSessionIdentity(root, rawUser, rawChat, subject)
      const allPaths: string[] = []
      const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name)
          allPaths.push(entryPath)
          if (entry.isDirectory()) visit(entryPath)
        }
      }
      visit(root)
      expect(allPaths.join("\n")).not.toContain(rawUser)
      expect(allPaths.join("\n")).not.toContain(rawChat)
      const friend = fs.readFileSync(friendPath, "utf8")
      expect(friend).toContain(subject)
      expect(friend).not.toContain(rawUser)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed on ambiguous legacy Friend and session migrations", async () => {
    const subject = `tg_${"c".repeat(43)}`
    const rawUser = "918273645012345678"
    const rawChat = "817263540123456789"
    const friendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-friend-ambiguous-"))
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-session-ambiguous-"))
    try {
      fs.mkdirSync(path.join(friendRoot, "friends"), { recursive: true })
      const friend = (id: string, externalId: string, name: string) => ({
        id, name, role: "friend", trustLevel: "family", externalIds: [
          { provider: "telegram-user", externalId, linkedAt: "2026-01-01T00:00:00.000Z" },
          { provider: "local", externalId: "unrelated", linkedAt: "2026-01-01T00:00:00.000Z" },
        ], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
      })
      fs.writeFileSync(path.join(friendRoot, "friends", "legacy.json"), JSON.stringify(friend("legacy", rawUser, "Kept name")))
      fs.writeFileSync(path.join(friendRoot, "friends", "opaque.json"), JSON.stringify(friend("opaque", subject, "Opaque")))
      await expect(migrateTelegramFriendIdentity(friendRoot, rawUser, subject)).rejects.toThrow("ambiguous")

      const legacy = path.join(sessionRoot, "state", "sessions", `telegram-user:${rawUser}`)
      const opaque = path.join(sessionRoot, "state", "sessions", `telegram-user:${subject}`)
      fs.mkdirSync(legacy, { recursive: true })
      fs.mkdirSync(opaque, { recursive: true })
      expect(() => migrateTelegramSessionIdentity(sessionRoot, rawUser, rawChat, subject)).toThrow("ambiguous")
    } finally {
      fs.rmSync(friendRoot, { recursive: true, force: true })
      fs.rmSync(sessionRoot, { recursive: true, force: true })
    }
  })

  it("discovers and records one prior opaque subject after token rotation, and fails closed on ambiguity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-subject-index-"))
    const ambiguousRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-subject-ambiguous-"))
    const legacySubject = `tg_${"l".repeat(43)}`
    const secondLegacySubject = `tg_${"m".repeat(43)}`
    const makeLegacySession = (agentRoot: string, candidate: string): void => {
      fs.mkdirSync(path.join(agentRoot, "state", "sessions", `telegram-user:${candidate}`), { recursive: true })
    }
    try {
      makeLegacySession(root, legacySubject)
      fs.mkdirSync(path.join(root, "state", "sessions", "unrelated"))
      fs.mkdirSync(path.join(root, "state", "sessions", "telegram-user:tg_short"))
      fs.writeFileSync(path.join(root, "state", "sessions", "unrelated.txt"), "ignored")
      mocks.getAgentRoot.mockReturnValue(root)
      const fixture = defaultFixture()
      const app = createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43), approvalRuntime: fixture.runtime })
      await app.run()

      const migratedNames = fs.readdirSync(path.join(root, "state", "sessions"))
        .filter((name) => /^telegram-user:tg_[A-Za-z0-9_-]{43}$/u.test(name))
      expect(migratedNames).toHaveLength(1)
      expect(migratedNames[0]).toMatch(/^telegram-user:tg_[A-Za-z0-9_-]{43}$/u)
      expect(migratedNames[0]).not.toBe(`telegram-user:${legacySubject}`)
      const indexPath = path.join(root, "state", "senses", "telegram", "identity-subjects.json")
      const indexText = fs.readFileSync(indexPath, "utf8")
      expect(fs.statSync(indexPath).mode & 0o777).toBe(0o600)
      expect(indexText).toContain(legacySubject)
      expect(indexText).not.toContain(credentials.botToken)
      expect(indexText).not.toMatch(/"42"|"43"/u)
      expect(fixture.runtime.migrateIdentity).toHaveBeenCalledWith([legacySubject])

      makeLegacySession(ambiguousRoot, legacySubject)
      makeLegacySession(ambiguousRoot, secondLegacySubject)
      mocks.getAgentRoot.mockReturnValue(ambiguousRoot)
      const ambiguousFixture = defaultFixture()
      const ambiguous = createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43), approvalRuntime: ambiguousFixture.runtime })
      await expect(ambiguous.run()).rejects.toThrow("ambiguous")
      expect(ambiguousFixture.runtime.migrateIdentity).not.toHaveBeenCalled()
      expect(fs.readdirSync(path.join(ambiguousRoot, "state", "sessions")).sort()).toEqual([
        `telegram-user:${legacySubject}`,
        `telegram-user:${secondLegacySubject}`,
      ].sort())
    } finally {
      mocks.getAgentRoot.mockReturnValue(isolatedRoot)
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(ambiguousRoot, { recursive: true, force: true })
    }
  })

  it("reads only canonical mode-0600 opaque subject indexes and rejects malformed or redirected indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-subject-validation-"))
    const target = path.join(root, "redirected.json")
    try {
      mocks.getAgentRoot.mockReturnValue(root)
      const firstFixture = defaultFixture()
      await createTelegramSenseApp({
        agentName: "butler", credentials, identityKey: "k".repeat(43), approvalRuntime: firstFixture.runtime,
      }).run()
      const indexPath = path.join(root, "state", "senses", "telegram", "identity-subjects.json")
      const canonical = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { subject: string }
      const oldSessionRoot = path.join(root, "state", "sessions", `telegram-user:${canonical.subject}`)
      fs.mkdirSync(oldSessionRoot, { recursive: true })

      const validFixture = defaultFixture()
      await expect(createTelegramSenseApp({
        agentName: "butler", credentials: { ...credentials, botToken: "rotated-again" }, identityKey: "k".repeat(43), approvalRuntime: validFixture.runtime,
      }).run()).resolves.toBeUndefined()
      const rotatedIndex = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { subject: string; legacySubjects: string[] }
      expect(rotatedIndex.subject).not.toBe(canonical.subject)
      expect(rotatedIndex.legacySubjects).toContain(canonical.subject)
      expect(fs.existsSync(oldSessionRoot)).toBe(false)
      expect(fs.existsSync(path.join(root, "state", "sessions", `telegram-user:${rotatedIndex.subject}`))).toBe(true)
      expect(validFixture.runtime.migrateIdentity).toHaveBeenCalledWith([canonical.subject])

      const invalidRecords: unknown[] = [
        null,
        [],
        { version: 2, subject: canonical.subject, legacySubjects: [] },
        { version: 1, subject: "tg_wrong", legacySubjects: [] },
        { version: 1, subject: canonical.subject, legacySubjects: "not-an-array" },
        { version: 1, subject: canonical.subject, legacySubjects: [], extra: true },
        { version: 1, subject: canonical.subject, legacySubjects: [null] },
        { version: 1, subject: canonical.subject, legacySubjects: ["tg_short"] },
      ]
      for (const invalid of invalidRecords) {
        fs.writeFileSync(indexPath, `${JSON.stringify(invalid)}\n`, { mode: 0o600 })
        fs.chmodSync(indexPath, 0o600)
        const fixture = defaultFixture()
        await expect(createTelegramSenseApp({
          agentName: "butler", credentials, identityKey: "k".repeat(43), approvalRuntime: fixture.runtime,
        }).run()).rejects.toThrow("identity subject index is invalid")
      }

      fs.writeFileSync(indexPath, `${JSON.stringify({ version: 1, subject: canonical.subject, legacySubjects: [] })}\n`)
      fs.chmodSync(indexPath, 0o644)
      await expect(createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43) }).run())
        .rejects.toThrow("permissions are invalid")

      fs.rmSync(indexPath)
      fs.writeFileSync(target, "{}\n", { mode: 0o600 })
      fs.symlinkSync(target, indexPath)
      await expect(createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43) }).run())
        .rejects.toThrow()
    } finally {
      mocks.getAgentRoot.mockReturnValue(isolatedRoot)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("discovers a prior opaque subject from a canonical Friend record while ignoring unrelated entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-friend-subject-discovery-"))
    const legacySubject = `tg_${"f".repeat(43)}`
    try {
      const friendsRoot = path.join(root, "friends")
      fs.mkdirSync(path.join(friendsRoot, "ignored-directory"), { recursive: true })
      fs.writeFileSync(path.join(friendsRoot, "ignored.txt"), "ignored")
      fs.writeFileSync(path.join(friendsRoot, "legacy.json"), JSON.stringify({
        id: "legacy", name: `Telegram user ${legacySubject}`, role: "friend", trustLevel: "family",
        externalIds: [
          { provider: "local", externalId: "unrelated", linkedAt: "2026-01-01T00:00:00.000Z" },
          { provider: "telegram-user", externalId: legacySubject, linkedAt: "2026-01-01T00:00:00.000Z" },
        ],
        tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
      }))
      mocks.getAgentRoot.mockReturnValue(root)
      const fixture = defaultFixture()
      await createTelegramSenseApp({
        agentName: "butler", credentials, identityKey: "k".repeat(43), approvalRuntime: fixture.runtime,
      }).run()

      const friend = fs.readFileSync(path.join(friendsRoot, "legacy.json"), "utf8")
      expect(friend).not.toContain(legacySubject)
      expect(fixture.runtime.migrateIdentity).toHaveBeenCalledWith([legacySubject])
    } finally {
      mocks.getAgentRoot.mockReturnValue(isolatedRoot)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed on unreadable legacy-subject roots and cleans an interrupted subject-index write", async () => {
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-subject-session-error-"))
    const friendsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-subject-friend-error-"))
    const indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-subject-index-error-"))
    try {
      const sessionPath = path.join(sessionRoot, "state", "sessions")
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
      fs.writeFileSync(sessionPath, "not a directory")
      mocks.getAgentRoot.mockReturnValue(sessionRoot)
      await expect(createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43) }).run()).rejects.toThrow()

      const friendPath = path.join(friendsRoot, "friends")
      fs.writeFileSync(friendPath, "not a directory")
      mocks.getAgentRoot.mockReturnValue(friendsRoot)
      await expect(createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43) }).run()).rejects.toThrow()

      mocks.getAgentRoot.mockReturnValue(indexRoot)
      await expect(createTelegramSenseApp({
        agentName: "butler",
        credentials,
        identityKey: "k".repeat(43),
        subjectIndexHooks: { afterCreateTemporary: () => { throw new Error("synthetic index write failure") } },
      }).run()).rejects.toThrow("synthetic index write failure")
      expect(fs.readdirSync(path.join(indexRoot, "state", "senses", "telegram"))).toEqual([])
    } finally {
      mocks.getAgentRoot.mockReturnValue(isolatedRoot)
      for (const root of [sessionRoot, friendsRoot, indexRoot]) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed on malformed Friend identity records during subject discovery", async () => {
    for (const [name, friend] of [
      ["record", { id: "malformed" }],
      ["external", { externalIds: [null] }],
    ] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `ouro-telegram-friend-${name}-`))
      try {
        fs.mkdirSync(path.join(root, "friends"), { recursive: true })
        fs.writeFileSync(path.join(root, "friends", "malformed.json"), JSON.stringify(friend))
        mocks.getAgentRoot.mockReturnValue(root)
        await expect(createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "k".repeat(43) }).run())
          .rejects.toThrow(/Friend/u)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
    mocks.getAgentRoot.mockReturnValue(isolatedRoot)
  })

  it("migrates a Friend already linked to both identities and rejects colliding session artifacts", async () => {
    const subject = `tg_${"d".repeat(43)}`
    const rawUser = "918273645012345678"
    const rawChat = "817263540123456789"
    const friendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-friend-linked-"))
    const sessionFileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-session-file-"))
    const pendingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-pending-file-"))
    try {
      const friendPath = path.join(friendRoot, "friends", "linked.json")
      fs.mkdirSync(path.dirname(friendPath), { recursive: true })
      fs.writeFileSync(friendPath, JSON.stringify({
        id: "linked", name: "Kept name", role: "friend", trustLevel: "family",
        externalIds: [
          { provider: "telegram-user", externalId: rawUser, linkedAt: "2026-01-01T00:00:00.000Z" },
          { provider: "telegram-user", externalId: subject, linkedAt: "2026-01-01T00:00:00.000Z" },
          { provider: "local", externalId: "unrelated", linkedAt: "2026-01-01T00:00:00.000Z" },
        ], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
      }))
      await migrateTelegramFriendIdentity(friendRoot, rawUser, subject)
      expect(fs.readFileSync(friendPath, "utf8")).not.toContain(rawUser)

      const legacySessionDir = path.join(sessionFileRoot, "state", "sessions", `telegram-user:${rawUser}`, "telegram")
      fs.mkdirSync(legacySessionDir, { recursive: true })
      fs.writeFileSync(path.join(legacySessionDir, `telegram_${rawChat}.json`), "{}")
      fs.writeFileSync(path.join(legacySessionDir, `telegram_${subject}.json`), "{}")
      expect(() => migrateTelegramSessionIdentity(sessionFileRoot, rawUser, rawChat, subject)).toThrow("session file migration is ambiguous")

      const legacyPendingDir = path.join(pendingRoot, "state", "pending", `telegram-user:${rawUser}`, "telegram")
      fs.mkdirSync(path.join(legacyPendingDir, `telegram:${rawChat}`), { recursive: true })
      fs.mkdirSync(path.join(legacyPendingDir, `telegram:${subject}`), { recursive: true })
      expect(() => migrateTelegramSessionIdentity(pendingRoot, rawUser, rawChat, subject)).toThrow("pending identity migration is ambiguous")
    } finally {
      fs.rmSync(friendRoot, { recursive: true, force: true })
      fs.rmSync(sessionFileRoot, { recursive: true, force: true })
      fs.rmSync(pendingRoot, { recursive: true, force: true })
    }
  })

  it("parses trimmed credentials and rejects missing or non-canonical values without echoing secrets", () => {
    expect(parseTelegramSenseCredentials({
      telegramBotToken: ` ${credentials.botToken} `,
      telegramAuthorizedUserId: " 42 ",
      telegramAuthorizedChatId: "43",
    })).toEqual(credentials)
    for (const value of [undefined, null, "", "   "]) {
      expect(() => parseTelegramSenseCredentials({ telegramBotToken: value, telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "43" })).toThrow("bot token is missing")
    }
    for (const id of ["0", "01", "-1", "1.5", "abc"]) {
      expect(() => parseTelegramSenseCredentials({ telegramBotToken: credentials.botToken, telegramAuthorizedUserId: id, telegramAuthorizedChatId: "43" })).toThrow("canonical positive decimal")
    }
    expect(() => createTelegramSenseApp({ agentName: "butler", credentials, identityKey: "invalid" }))
      .toThrow("identity key is invalid")
  })

  it("constructs default API, stores, turn runner, tool context, approval runtime, and poll paths", async () => {
    const f = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "sanctuary", credentials })
    expect(mocks.createTelegramBotApi).toHaveBeenCalledWith({ token: credentials.botToken })
    expect(mocks.createSanctuaryToolContext).toHaveBeenCalledWith("sanctuary")
    expect(mocks.createTelegramApprovalRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "sanctuary", api: f.api, authorizedUserId: "42", authorizedChatId: "43", toolContext: { sanctuary: true },
    }))
    expect(mocks.createTelegramLongPoll).toHaveBeenCalledWith(expect.objectContaining({
      api: f.api, expectedUserId: "42", expectedChatId: "43",
    }))
    await app.run()
    expect(f.runtime.recover).toHaveBeenCalledBefore(f.transport.reconcileExpired)
    expect(f.transport.reconcileExpired).toHaveBeenCalledBefore(f.poll.run)
    await app.stop()
    expect(f.runtime.close).toHaveBeenCalledOnce()
  })

  it("keeps unrelated global log volume out of the dedicated scenario-bound Telegram ledger", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-filter-"))
    mocks.getAgentRoot.mockReturnValueOnce(root)
    const f = defaultFixture()
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials,
      identityKey: "k".repeat(43),
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }),
    })
    const ledgerPath = path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)
    try {
      for (let index = 0; index < 1_000; index += 1) emitGlobal({ ...acceptanceEvent("daemon.unrelated_noise"), meta: { index } })
      expect(fs.readFileSync(ledgerPath, "utf8")).toBe("")
      const requiredEvents = [
        "approval.acceptance_continuation_transition", "approval.acceptance_transition", "senses.sanctuary_health_delivered", "senses.sanctuary_read_receipt",
        "senses.telegram_approved_restart_end", "senses.telegram_approved_restart_error", "senses.telegram_approved_restart_start",
        "senses.telegram_turn_end", "senses.telegram_turn_error", "senses.telegram_turn_start",
        "telegram.approval_prompt_terminalized", "telegram.callback_settled", "telegram.update_dropped",
      ]
      emitGlobal(acceptanceEvent())
      expect(fs.readFileSync(ledgerPath, "utf8")).toBe("")
      const owner = telegramAcceptanceAuditOwnerDigest("k".repeat(43), "sanctuary", root)
      for (const name of requiredEvents) emitGlobal({ ...acceptanceEvent(name), meta: { scenarioHandleDigest: "a".repeat(64), acceptanceAuditOwnerDigest: owner } })
      expect(fs.readFileSync(ledgerPath, "utf8").trim().split("\n")).toHaveLength(requiredEvents.length)
      await app.stop()
      expect(f.api.stop).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rolls back the audit lease after a corrupt-offset constructor failure and retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-constructor-"))
    mocks.getAgentRoot.mockReturnValue(root)
    defaultFixture()
    mocks.createTelegramLongPoll.mockImplementationOnce(() => { throw new Error("Telegram offset state is corrupt") })
    expect(() => createTelegramSenseApp({ agentName: "sanctuary", credentials, identityKey: "k".repeat(43) })).toThrow("Telegram offset state is corrupt")
    const ledgerPath = path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)
    emitGlobal(acceptanceEvent())
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe("")

    const retry = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "sanctuary", credentials, identityKey: "k".repeat(43) })
    await app.stop()
    const stopped = fs.readFileSync(ledgerPath, "utf8")
    emitGlobal(acceptanceEvent())
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(stopped)
    expect(retry.api.stop).toHaveBeenCalledOnce()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("releases the audit sink in finally while preserving a primary stop failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-stop-"))
    mocks.getAgentRoot.mockReturnValueOnce(root)
    const f = defaultFixture()
    const primary = new Error("approval runtime close failed")
    f.runtime.close.mockImplementationOnce(() => { throw primary })
    const app = createTelegramSenseApp({ agentName: "sanctuary", credentials, identityKey: "k".repeat(43) })
    await expect(app.stop()).rejects.toBe(primary)
    const ledgerPath = path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)
    const stopped = fs.readFileSync(ledgerPath, "utf8")
    emitGlobal(acceptanceEvent())
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(stopped)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("unregisters a failed-integrity audit lease so a repaired retry can start cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-integrity-"))
    mocks.getAgentRoot.mockReturnValue(root)
    defaultFixture()
    const app = createTelegramSenseApp({ agentName: "sanctuary", credentials, identityKey: "k".repeat(43) })
    const ledgerPath = path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)
    const headPath = path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH)
    fs.writeFileSync(headPath, "{}\n")
    await expect(app.stop()).rejects.toThrow("audit head")
    fs.rmSync(ledgerPath, { force: true })
    fs.rmSync(headPath, { force: true })

    defaultFixture()
    const repaired = createTelegramSenseApp({ agentName: "sanctuary", credentials, identityKey: "k".repeat(43) })
    await expect(repaired.stop()).resolves.toBeUndefined()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("supplies an empty tool context if context construction yields no value", () => {
    const f = defaultFixture()
    mocks.createSanctuaryToolContext.mockReturnValueOnce(undefined as any)
    createTelegramSenseApp({ agentName: "sanctuary", credentials })
    expect(mocks.createTelegramApprovalRuntime).toHaveBeenCalledWith(expect.objectContaining({ api: f.api, toolContext: {} }))
  })

  it("starts a non-Sanctuary Telegram agent without constructing Sanctuary runtime state", async () => {
    const f = defaultFixture()
    createTelegramSenseApp({ agentName: "slugger", credentials })

    expect(mocks.createSanctuaryToolContext).not.toHaveBeenCalled()
    expect(mocks.createTelegramApprovalRuntime).not.toHaveBeenCalled()
    await f.getOnMessage()({ updateId: 1, messageId: "2", text: "hello" })
    const turnOptions = mocks.runSenseTurn.mock.calls[0]![0]
    expect(turnOptions).not.toHaveProperty("toolContext")
    expect(turnOptions).not.toHaveProperty("approvalCoordinatorFactory")
    expect(mocks.sendTelegramText).toHaveBeenCalledExactlyOnceWith(f.api, "43", "fallback", undefined, expect.any(Function))
  })

  it("emits scenario-bound hashed turn lifecycle coordinates without raw transport identity", async () => {
    const f = defaultFixture()
    createTelegramSenseApp({
      agentName: "butler",
      credentials,
      identityKey: "k".repeat(43),
      acceptanceMarker: () => ({ schemaVersion: "sanctuary-acceptance-marker-v1", label: "unit-16d-whats-up", scenarioHandleDigest: "a".repeat(64), startedAt: "2026-08-20T00:00:00.000Z" }),
    })
    await f.getOnMessage()({ updateId: 918273645, messageId: "817263540", userId: "42", chatId: "43", text: "restart calibre-web" })
    const lifecycle = mocks.emitNervesEvent.mock.calls.map(([entry]) => entry).filter((entry) => entry.event === "senses.telegram_turn_start" || entry.event === "senses.telegram_turn_end")
    expect(lifecycle).toHaveLength(2)
    const [start, end] = lifecycle
    const coordinates = ["scenarioHandleDigest", "turnDigest", "updateDigest", "subject", "identityDigest", "sessionDigest", "argumentDigest"]
    for (const key of coordinates) expect(end.meta[key]).toBe(start.meta[key])
    expect(start.meta).toMatchObject({ scenarioHandleDigest: "a".repeat(64), subject: expect.stringMatching(/^tg_[A-Za-z0-9_-]{43}$/u) })
    expect(start.meta.lifecycleAt).toEqual(expect.any(Number))
    expect(end.meta.lifecycleAt).toEqual(expect.any(Number))
    expect(end.meta.lifecycleAt).toBeGreaterThan(start.meta.lifecycleAt)
    for (const key of ["turnDigest", "updateDigest", "identityDigest", "sessionDigest", "argumentDigest"]) expect(start.meta[key]).toMatch(/^[0-9a-f]{64}$/u)
    expect(end.meta).toMatchObject({ outcome: "success", errorDigest: null, deliveryCount: 1 })
    expect(JSON.stringify(lifecycle)).not.toMatch(/918273645|817263540|"42"|"43"/u)
    const longPollOptions = mocks.createTelegramLongPoll.mock.calls.at(-1)![0]
    const droppedMeta = longPollOptions.acceptanceEventMeta({ update_id: 123456789, message: { message_id: 987654321, from: { id: 99 }, chat: { id: 99, type: "private" }, text: "unauthorized" } }, true)
    expect(droppedMeta).toEqual({
      scenarioHandleDigest: "a".repeat(64),
      updateDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      senderIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      authorizedIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      senderDistinct: true,
      nextOffsetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      dropMac: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(droppedMeta.senderIdentityDigest).not.toBe(droppedMeta.authorizedIdentityDigest)
    expect(JSON.stringify(droppedMeta)).not.toMatch(/123456789|987654321|"99"/u)
    const authorizedWrongChat = longPollOptions.acceptanceEventMeta({ update_id: 123456790, message: { message_id: 987654322, from: { id: 42 }, chat: { id: 99, type: "private" }, text: "wrong chat" } }, false)
    expect(authorizedWrongChat).toMatchObject({ senderDistinct: false })
    expect(authorizedWrongChat.senderIdentityDigest).toBe(authorizedWrongChat.authorizedIdentityDigest)
  })

  it("uses one deterministic domain-safe opaque subject for turn, friend, identity, and log surfaces", async () => {
    const privateCredentials = {
      botToken: "privacy-test-bot-token",
      authorizedUserId: "918273645012345678",
      authorizedChatId: "817263540123456789",
    }
    const capture = async (input: typeof privateCredentials) => {
      const f = defaultFixture()
      createTelegramSenseApp({ agentName: "butler", credentials: input })
      await f.getOnMessage()({
        updateId: 716253401234567891,
        messageId: "615243019876543219",
        userId: input.authorizedUserId,
        chatId: input.authorizedChatId,
        text: "privacy check",
      })
      return mocks.runSenseTurn.mock.calls.at(-1)![0]
    }

    const first = await capture(privateCredentials)
    const repeated = await capture(privateCredentials)
    const otherToken = await capture({ ...privateCredentials, botToken: "different-privacy-test-bot-token" })
    const otherUser = await capture({ ...privateCredentials, authorizedUserId: "918273645012345679" })
    const otherChat = await capture({ ...privateCredentials, authorizedChatId: "817263540123456790" })
    const subject = first.identity.externalId as string

    expect(subject).toMatch(/^tg_[A-Za-z0-9_-]{43}$/u)
    expect(repeated.identity.externalId).toBe(subject)
    expect(otherToken.identity.externalId).not.toBe(subject)
    expect(otherUser.identity.externalId).not.toBe(subject)
    expect(otherChat.identity.externalId).not.toBe(subject)
    expect(first).toMatchObject({
      sessionKey: `telegram:${subject}`,
      friendId: `telegram-user:${subject}`,
      identity: {
        provider: "telegram-user",
        externalId: subject,
        displayName: `Telegram user ${subject}`,
      },
    })
    expect(mocks.createTelegramLongPoll).toHaveBeenCalledWith(expect.objectContaining({
      expectedUserId: privateCredentials.authorizedUserId,
      expectedChatId: privateCredentials.authorizedChatId,
    }))
    expect(mocks.sendTelegramText).toHaveBeenCalledWith(
      expect.anything(),
      privateCredentials.authorizedChatId,
      "fallback",
      undefined,
      expect.any(Function),
    )

    const privateSurfaces = JSON.stringify({ turn: first, logs: mocks.emitNervesEvent.mock.calls })
    for (const rawId of [
      privateCredentials.authorizedUserId,
      privateCredentials.authorizedChatId,
      "716253401234567891",
      "615243019876543219",
    ]) {
      expect(privateSurfaces).not.toContain(rawId)
    }
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ subject }),
    }))
  })

  it("fails closed before a turn or delivery when the acceptance audit becomes corrupt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-effect-fence-"))
    mocks.getAgentRoot.mockReturnValueOnce(root)
    const f = defaultFixture()
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials,
      identityKey: "k".repeat(43),
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }),
    })
    fs.writeFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH), "{}\n")

    await expect(f.getOnMessage()({ updateId: 1, messageId: "2", userId: "42", chatId: "43", text: "status" }))
      .rejects.toThrow("audit head")
    expect(mocks.runSenseTurn).not.toHaveBeenCalled()
    expect(mocks.sendTelegramText).not.toHaveBeenCalled()
    await expect(app.stop()).rejects.toThrow("audit head")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("fails closed before a turn or delivery when the acceptance audit has no reserved capacity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-exhausted-"))
    mocks.getAgentRoot.mockReturnValueOnce(root)
    const f = defaultFixture()
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials,
      identityKey: "k".repeat(43),
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }),
      _acceptanceAuditMaxBytes: 1,
    })

    await expect(f.getOnMessage()({ updateId: 1, messageId: "2", userId: "42", chatId: "43", text: "status" }))
      .rejects.toThrow(/exceeds its bound|reserved capacity/u)
    expect(mocks.runSenseTurn).not.toHaveBeenCalled()
    expect(mocks.sendTelegramText).not.toHaveBeenCalled()
    await app.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("routes scenario audit events only to the exact owning app root", async () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-root-a-"))
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-audit-root-b-"))
    const identityKey = "k".repeat(43)
    mocks.getAgentRoot.mockReturnValueOnce(firstRoot).mockReturnValueOnce(secondRoot)
    defaultFixture()
    const first = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials,
      identityKey,
      acceptanceMarker: () => ({ scenarioHandleDigest: "a".repeat(64) }),
    })
    defaultFixture()
    let secondScenario = "a".repeat(64)
    const second = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials,
      identityKey,
      acceptanceMarker: () => ({ scenarioHandleDigest: secondScenario }),
    })
    const firstOwner = telegramAcceptanceAuditOwnerDigest(identityKey, "sanctuary", firstRoot)
    emitGlobal({ ...acceptanceEvent(), meta: { scenarioHandleDigest: "a".repeat(64), acceptanceAuditOwnerDigest: firstOwner } })

    const firstLedger = fs.readFileSync(path.join(firstRoot, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8").trim().split("\n").filter(Boolean)
    const secondLedger = fs.readFileSync(path.join(secondRoot, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8").trim().split("\n").filter(Boolean)
    expect(firstLedger).toHaveLength(1)
    expect(secondLedger).toHaveLength(0)
    secondScenario = "b".repeat(64)
    const secondOwner = telegramAcceptanceAuditOwnerDigest(identityKey, "sanctuary", secondRoot)
    emitGlobal({ ...acceptanceEvent(), meta: { scenarioHandleDigest: secondScenario, acceptanceAuditOwnerDigest: secondOwner } })
    expect(fs.readFileSync(path.join(firstRoot, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1)
    expect(fs.readFileSync(path.join(secondRoot, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1)
    await first.stop()
    await second.stop()
    fs.rmSync(firstRoot, { recursive: true, force: true })
    fs.rmSync(secondRoot, { recursive: true, force: true })
  })

  it("attempts every stop cleanup and aggregates failures in deterministic order", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-stop-aggregate-"))
    mocks.getAgentRoot.mockReturnValueOnce(root)
    const f = defaultFixture()
    const stopFailure = new Error("poll stop failed")
    const apiFailure = new Error("api stop failed")
    const runtimeFailure = new Error("runtime close failed")
    f.poll.stop.mockImplementationOnce(() => { throw stopFailure })
    f.api.stop.mockImplementationOnce(() => { throw apiFailure })
    f.runtime.close.mockImplementationOnce(() => { throw runtimeFailure })
    const app = createTelegramSenseApp({ agentName: "sanctuary", credentials, identityKey: "k".repeat(43) })

    const error = await app.stop().catch((caught) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([stopFailure, apiFailure, runtimeFailure])
    expect(f.api.stop).toHaveBeenCalledOnce()
    expect(f.runtime.close).toHaveBeenCalledOnce()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("aggregates constructor and audit-release failures without leaving the sink registered", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-constructor-aggregate-"))
    mocks.getAgentRoot.mockReturnValueOnce(root)
    defaultFixture()
    const primary = new Error("poll constructor failed")
    const release = new Error("audit release failed")
    mocks.createTelegramLongPoll.mockImplementationOnce(() => { throw primary })

    let caught: unknown
    try {
      createTelegramSenseApp({
        agentName: "sanctuary",
        credentials,
        identityKey: "k".repeat(43),
        _acceptanceAuditReleaseHook: () => { throw release },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([primary, release])
    const before = fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8")
    emitGlobal(acceptanceEvent())
    expect(fs.readFileSync(path.join(root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH), "utf8")).toBe(before)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("passes default tool and approval context, then sends a response only when no streamed delivery occurred", async () => {
    const f = defaultFixture()
    createTelegramSenseApp({ agentName: "sanctuary", credentials })
    await f.getOnMessage()({ updateId: 1, messageId: "2", text: "hello" })
    expect(mocks.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: { sanctuary: true }, approvalCoordinatorFactory: f.runtime.coordinator,
    }))
    expect(mocks.sendTelegramText).toHaveBeenCalledExactlyOnceWith(f.api, "43", "fallback", undefined, expect.any(Function))

    mocks.sendTelegramText.mockClear()
    mocks.runSenseTurn.mockImplementationOnce(async (options: any) => {
      await options.deliverySink.onDelivery({ text: "streamed" })
      return { response: "also returned", deliveries: [], deliveryFailures: [], ponderDeferred: false }
    })
    await f.getOnMessage()({ updateId: 2, messageId: "3", text: "again" })
    expect(mocks.sendTelegramText).toHaveBeenCalledExactlyOnceWith(f.api, "43", "streamed", undefined, expect.any(Function))

    mocks.sendTelegramText.mockClear()
    mocks.runSenseTurn.mockResolvedValueOnce({ response: "   ", deliveries: [], deliveryFailures: [], ponderDeferred: false })
    await f.getOnMessage()({ updateId: 3, messageId: "4", text: "quiet" })
    expect(mocks.sendTelegramText).not.toHaveBeenCalled()
  })

  it.each([new Error("turn failed"), "primitive failure"])("records turn failure and sends one fixed safe response", async (failure) => {
    const f = defaultFixture()
    mocks.runSenseTurn.mockRejectedValueOnce(failure)
    createTelegramSenseApp({ agentName: "butler", credentials })
    await f.getOnMessage()({ updateId: 1, messageId: "2", text: "hello" })
    expect(mocks.sendTelegramText).toHaveBeenCalledWith(f.api, "43", "I couldn't complete that turn. The failure was recorded; please try again.", undefined, expect.any(Function))
  })

  it("redacts transport secrets and raw Telegram identifiers from logged failures", async () => {
    const privateCredentials = {
      botToken: "private-error-bot-token",
      authorizedUserId: "908172635401234567",
      authorizedChatId: "807162534012345678",
    }
    const updateId = 7061524301
    const messageId = "605142309876543210"
    const f = defaultFixture()
    mocks.runSenseTurn.mockRejectedValueOnce(new Error([
      privateCredentials.botToken,
      privateCredentials.authorizedUserId,
      privateCredentials.authorizedChatId,
      updateId,
      messageId,
    ].join("/")))
    createTelegramSenseApp({ agentName: "butler", credentials: privateCredentials })

    await f.getOnMessage()({ updateId, messageId, text: "fail privately" })

    const logged = JSON.stringify(mocks.emitNervesEvent.mock.calls)
    for (const privateValue of [
      privateCredentials.botToken,
      privateCredentials.authorizedUserId,
      privateCredentials.authorizedChatId,
      String(updateId),
      messageId,
    ]) {
      expect(logged).not.toContain(privateValue)
    }
    expect(logged).toContain("[redacted]")
  })

  it("declines non-callback updates and callbacks when no approval transport exists", async () => {
    const f = defaultFixture()
    mocks.createTelegramApprovalRuntime.mockReturnValue(undefined)
    createTelegramSenseApp({
      agentName: "butler", credentials, api: f.api, offsetStore: { load: () => 0, save: vi.fn() },
      runTurn: mocks.runSenseTurn,
    })
    await expect(f.getOnUpdate()({ update_id: 1 })).resolves.toBe(false)
    await expect(f.getOnUpdate()({ update_id: 2, callback_query: { id: "q", from: { id: 42 } } })).resolves.toBe(false)
  })

  it("runs every health sweep result branch and receipts exact message ids", async () => {
    for (const result of [
      {},
      { message: "health" },
      { message: "health", deliveryId: "delivery-1" },
    ]) {
      const f = defaultFixture()
      const healthSweep = Object.assign(vi.fn(async () => result), { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() })
      const app = createTelegramSenseApp({ agentName: "butler", credentials, healthSweep })
      await app.run()
      if ("deliveryId" in result) {
        expect(healthSweep.markDeliveryAttempting).toHaveBeenCalledWith("delivery-1")
        expect(healthSweep.markDelivered).toHaveBeenCalledWith("delivery-1", [71])
      }
      expect(f.poll.run).toHaveBeenCalledOnce()
    }
  })

  it.each([new Error("health failed"), "primitive health failure"])("contains health sweep failures", async (failure) => {
    const f = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "butler", credentials, healthSweep: vi.fn(async () => { throw failure }) })
    await expect(app.run()).resolves.toBeUndefined()
    expect(f.poll.run).toHaveBeenCalledOnce()
  })

  it("validates proactive messages and forwards the exact caller signal", async () => {
    const f = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "butler", credentials })
    const controller = new AbortController()
    await app.sendProactive("  hello  ", controller.signal)
    expect(mocks.sendTelegramText).toHaveBeenCalledWith(f.api, "43", "hello", controller.signal, undefined)
    await expect(app.sendProactive("   ")).rejects.toThrow("proactive message is missing")
  })

  it("loads credentials, explains missing runtime config, and starts the default app", async () => {
    expect(loadTelegramSenseCredentials("butler")).toEqual(credentials)
    mocks.readRuntimeCredentialConfig.mockReturnValueOnce({ ok: false, reason: "missing" })
    expect(() => loadTelegramSenseCredentials("butler")).toThrow("actor: agent-runnable")
    const f = defaultFixture()
    await expect(startTelegramSenseApp("butler")).resolves.toMatchObject({ run: expect.any(Function), stop: expect.any(Function) })
    expect(mocks.createTelegramBotApi).toHaveBeenCalledWith({ token: credentials.botToken })
    expect(f.api.stop).not.toHaveBeenCalled()
  })
})
