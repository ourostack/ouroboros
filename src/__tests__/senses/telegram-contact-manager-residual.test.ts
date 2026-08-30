import { createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"

const approvalMock = vi.hoisted(() => ({ override: null as null | Record<string, unknown> }))

vi.mock("../../heart/approval-store", async (importActual) => {
  const actual = await importActual<typeof import("../../heart/approval-store")>()
  return {
    ...actual,
    openApprovalStore: (...args: Parameters<typeof actual.openApprovalStore>) => approvalMock.override ?? actual.openApprovalStore(...args),
  }
})

import { openApprovalStore } from "../../heart/approval-store"
import { createObligation, markObligationReturnReady, readObligation } from "../../arc/obligations"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp } from "../../senses/telegram"
import type { TelegramLongPollOptions } from "../../senses/telegram-client"
import { withSessionTurnLease } from "../../mind/session-transaction"
import { getSenseSessionPath } from "../../senses/shared-turn"

const roots: string[] = []

afterEach(() => {
  approvalMock.override = null
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function relationshipFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-contact-residual-"))
  roots.push(root)
  const friends = new FileFriendStore(path.join(root, "friends"))
  const now = "2026-08-29T00:00:00.000Z"
  await friends.put("ari", { id: "ari", name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner",
    externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 })
  fs.writeFileSync(path.join(root, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: {
    "sanctuary-owner": { version: 1, contextScopes: [], toolNames: ["telegram_contact_manage"], effectScopes: [] },
    "sanctuary-household": { version: 1, contextScopes: [], toolNames: [], effectScopes: [] },
  } }))
  const composition = await createProductionTelegramRelationshipComposition("sanctuary", { botToken: "777:secret", botId: "777", authorizedUserId: "42", authorizedChatId: "42" }, root)
  return { root, friends, manager: composition.telegramContactManager!, now }
}

async function putContact(friends: FileFriendStore, now: string, id: string, userId: string) {
  await friends.put(id, { id, name: id, trustLevel: "friend", admissionState: "active", initiativePolicy: "request_follow_up_only", capabilityProfileId: "sanctuary-household",
    externalIds: [{ provider: "telegram-user", externalId: userId, tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 })
}

describe("Telegram contact manager residual boundaries", () => {
  it("terminalizes each safe pre-attempt approval state and preserves attempted action evidence", async () => {
    const { root, friends, manager, now } = await relationshipFixture()
    const approvalRoot = path.join(root, "state", "approvals")
    const store = openApprovalStore({ databasePath: path.join(approvalRoot, "approvals.sqlite") })
    const records: Array<{ id: string; state: string }> = []
    const checkpointRecords: Record<string, { approvalId: string }> = {}

    for (const [index, state] of ["preparing", "awaiting_prompt_binding", "claimed", "attempted"].entries()) {
      const friendId = `contact-${state}`
      const userId = String(900 + index)
      await putContact(friends, now, friendId, userId)
      const sessionKey = `telegram:777:${userId}`
      const sessionPath = getSenseSessionPath("sanctuary", friendId, "telegram", sessionKey, root)
      const prepared = store.prepare({
        toolCallId: `call-${state}`, toolName: "unraid_restart_container", arguments: { container: "books" },
        schemaDigest: "a".repeat(64), toolDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyId: "sanctuary.unraid.restart.v1",
        sessionKey, sessionPath, baseSessionRevision: "d".repeat(64), checkpointDigest: "e".repeat(64), requesterId: friendId,
        transport: "telegram", transportUserId: userId, transportChatId: userId, expiresAt: "2099-01-01T00:00:00.000Z",
        frozenAssistantMessage: { role: "assistant", content: "approval" },
      })
      let record = prepared.record
      if (state !== "preparing") record = store.activate({ approvalId: record.approvalId, checkpointDigest: record.checkpointDigest, suspendedSessionRevision: "f".repeat(64) })
      if (state === "claimed" || state === "attempted") {
        record = store.bindPrompt({ approvalId: record.approvalId, transport: "telegram", transportChatId: userId, transportMessageId: `message-${index}` })
        record = store.decide({ approvalId: record.approvalId, decisionToken: prepared.decisionToken, decision: "approve", requesterId: friendId,
          transport: "telegram", transportUserId: userId, transportChatId: userId, transportMessageId: `message-${index}`, sessionKey, ownerId: `worker-${index}` })
      }
      if (state === "attempted") record = store.markAttempted({ approvalId: record.approvalId, ownerId: record.ownerId!, epoch: record.epoch })
      checkpointRecords[record.approvalId] = { approvalId: record.approvalId }
      records.push({ id: record.approvalId, state })
    }
    checkpointRecords["orphan-checkpoint"] = { approvalId: "orphan-checkpoint" }
    fs.mkdirSync(approvalRoot, { recursive: true })
    fs.writeFileSync(path.join(approvalRoot, "checkpoints.json"), JSON.stringify(checkpointRecords))
    store.close()

    for (const record of records) await expect(manager.revoke({ actorFriendId: "ari", friendId: `contact-${record.state}` })).resolves.toMatchObject({ revoked: true })

    const reopened = openApprovalStore({ databasePath: path.join(approvalRoot, "approvals.sqlite") })
    expect(reopened.read(records[0]!.id)?.state).toBe("abandoned_before_attempt")
    expect(reopened.read(records[1]!.id)?.state).toBe("abandoned_before_attempt")
    expect(reopened.read(records[2]!.id)?.state).toBe("abandoned_before_attempt")
    expect(reopened.read(records[3]!.id)?.state).toBe("attempted")
    reopened.close()
    const remaining = JSON.parse(fs.readFileSync(path.join(approvalRoot, "checkpoints.json"), "utf8"))
    expect(remaining).toHaveProperty(records[3]!.id)
    expect(remaining).toHaveProperty("orphan-checkpoint")
  })

  it("fails closed when a claimed approval has lost its owner identity", async () => {
    const { root, friends, manager, now } = await relationshipFixture()
    await putContact(friends, now, "claimed-without-owner", "950")
    const sessionPath = getSenseSessionPath("sanctuary", "claimed-without-owner", "telegram", "telegram:777:950", root)
    const approvalRoot = path.join(root, "state", "approvals")
    fs.mkdirSync(approvalRoot, { recursive: true })
    fs.writeFileSync(path.join(approvalRoot, "checkpoints.json"), JSON.stringify({ broken: { approvalId: "broken" } }))
    approvalMock.override = {
      read: () => ({ approvalId: "broken", sessionPath, state: "claimed", ownerId: null }),
      close: vi.fn(),
    }

    await expect(manager.revoke({ actorFriendId: "ari", friendId: "claimed-without-owner" })).rejects.toThrow("missing its claim owner")
  })

  it("binds an already verified request obligation to the admitted turn's terminal return", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-terminal-return-"))
    roots.push(root)
    const identityKey = "k".repeat(43)
    const update = { updateId: 31, messageId: 41, botId: "777", userId: "888", chatId: "888", text: "is it ready?", displayLabel: "Household", hasAttachments: false }
    const requestId = `telegram-inbound:${createHmac("sha256", identityKey).update(`${update.botId}\0${update.userId}\0${update.updateId}\0${update.messageId}`).digest("hex")}`
    const obligation = createObligation(root, {
      origin: { friendId: "household", channel: "telegram", key: "telegram:777:888" },
      requestId,
      content: "Return the verified result",
    })
    markObligationReturnReady(root, obligation.id, "verified:result")
    let pollOptions!: TelegramLongPollOptions
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "777:secret", botId: "777", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey,
      _agentRoot: root,
      api: { request: vi.fn(async (method) => {
        if (method !== "sendMessage") return true
        fs.rmSync(path.join(root, "arc", "obligations", `${obligation.id}.json`))
        return { message_id: 100 }
      }), stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { pollOptions = options; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      runTurn: vi.fn(async () => ({ response: "It is ready.", deliveries: [], deliveryFailures: [], ponderDeferred: false })),
      migrateIdentity: async () => undefined,
      admission: {
        ownerFriendId: "ari",
        resolveOwner: vi.fn(async () => ({ friendId: "ari" })),
        resolveApprovedFriend: vi.fn(async () => ({ friendId: "household" })),
        claimFriend: vi.fn(),
        revokeFriend: vi.fn(),
      },
      authorizeRelationshipEffect: vi.fn(async () => ({ allowed: true, receiptId: "return", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "888" } })),
      resolveRelationshipAuthorization: vi.fn(async () => ({
        subject: { friendId: "household", trustLevel: "friend" as const, admissionState: "active" as const, initiativePolicy: "request_follow_up_only" as const },
        authorizedContextScopes: [], advertisedToolNames: [], authorizeContext: vi.fn(), authorizeTool: vi.fn(), authorizeEffect: vi.fn(),
      })),
    })

    await pollOptions.onUnknownMessage!(update)

    expect(readObligation(root, obligation.id)).toBeNull()
    await app.stop()
  })

  it("filters inexact contacts, renders legacy defaults, rejects inexact revocation, and detects identity drift under the session lease", async () => {
    const { root, friends, manager, now } = await relationshipFixture()
    await putContact(friends, now, "exact", "960")
    await friends.put("legacy", { id: "legacy", name: "Legacy", trustLevel: "friend", capabilityProfileId: "sanctuary-household",
      externalIds: [{ provider: "telegram-user", externalId: "961", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 } as never)
    const legacyPath = path.join(root, "friends", "legacy.json")
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"))
    delete legacy.admissionState
    delete legacy.initiativePolicy
    fs.writeFileSync(legacyPath, JSON.stringify(legacy))
    await friends.put("wrong-bot", { id: "wrong-bot", name: "Wrong bot", trustLevel: "friend", admissionState: "active", initiativePolicy: "request_follow_up_only", capabilityProfileId: "sanctuary-household",
      externalIds: [{ provider: "telegram-user", externalId: "962", tenantId: "778", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 })
    await friends.put("invalid-id", { id: "invalid-id", name: "Invalid", trustLevel: "friend", admissionState: "active", initiativePolicy: "request_follow_up_only", capabilityProfileId: "sanctuary-household",
      externalIds: [{ provider: "telegram-user", externalId: "not-numeric", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 })

    await expect(manager.list({ actorFriendId: "ari" })).resolves.toEqual(expect.objectContaining({ contacts: expect.arrayContaining([
      expect.objectContaining({ friendId: "legacy", admissionState: "unverified", initiativePolicy: "none" }),
    ]) }))
    await expect(manager.revoke({ actorFriendId: "ari", friendId: "wrong-bot" })).rejects.toThrow("identity is not exact")

    const sessionPath = getSenseSessionPath("sanctuary", "exact", "telegram", "telegram:777:960", root)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const lease = withSessionTurnLease(sessionPath, async () => { entered.resolve(); await release.promise })
    await entered.promise
    const revocation = manager.revoke({ actorFriendId: "ari", friendId: "exact" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const exact = await friends.get("exact")
    await friends.put("exact", { ...exact!, externalIds: [{ provider: "telegram-user", externalId: "999", tenantId: "777", linkedAt: now }], updatedAt: now })
    release.resolve()
    await lease
    await expect(revocation).rejects.toThrow("identity changed")
  })
})
