import { createHash, createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"
import Database from "better-sqlite3"

import { canonicalApprovalArguments, openApprovalStore, type ApprovalOwnerBinding } from "../../heart/approval-store"
import type { ApprovalProposalRequest, runAgent } from "../../heart/core"
import { loadSessionEnvelopeFile, projectProviderMessages } from "../../heart/session-events"
import { readStewardPolicy, updateStewardPolicy } from "../../heart/steward-policy"
import { readSessionTransaction, withSessionTurnLease } from "../../mind/session-transaction"
import { createLogger, createNdjsonFileSink, type LogEvent } from "../../nerves"
import { setRuntimeLogger } from "../../nerves/runtime"
import { digestJson, validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
import { execTool, resolveToolDefinition } from "../../repertoire/tools"
import { routineActionRequester } from "../../repertoire/relationship-authorization"
import { stewardPolicyToolDefinition } from "../../repertoire/tools-steward-policy"
import { createTelegramApprovalRuntime } from "../../senses/telegram-approval-runtime"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp, opaqueTelegramSubject, readOrCreateTelegramIdentityKey, sanctuaryTelegramApprovalEvidenceMac } from "../../senses/telegram"
import { TelegramApiError, type TelegramBotApi, type TelegramUpdate } from "../../senses/telegram-client"
import { createTelegramApprovalEffectPort, createTelegramAuthorizedEffectExecutor, FileTelegramEffectJournal, recordTelegramEffectsInSession, type TelegramApprovalEffectPort } from "../../senses/telegram-effect-adapter"
import { getSenseSessionPath } from "../../senses/shared-turn"
import type { ToolContext } from "../../repertoire/tools-base"

const scenarioHandleDigest = "a".repeat(64)
const roots: string[] = []
const effectStores: FileTelegramEffectJournal[] = []
const invalidInventories: Record<string, unknown> = {
  "absent inventory": undefined,
  "null inventory": null,
  "scalar inventory": true,
  "missing inventory status": {},
  "failed inventory": { ok: false },
  "missing inventory data": { ok: true },
  "null inventory data": { ok: true, data: null },
  "scalar inventory data": { ok: true, data: 1 },
  "missing truncation status": { ok: true, data: { containers: [] } },
  "missing container list": { ok: true, data: { truncated: false } },
  "invalid container list": { ok: true, data: { truncated: false, containers: {} } },
  "null container": { ok: true, data: { truncated: false, containers: [null] } },
  "missing target id": { ok: true, data: { truncated: false, containers: [{ name: "calibre-web", degraded: false }] } },
  "numeric target id": { ok: true, data: { truncated: false, containers: [{ id: 42, name: "calibre-web", degraded: false }] } },
}

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-production-"))
  roots.push(value)
  return value
}

function proposalRequest(liveToolContext: ToolContext, name = "unraid_restart_container", args: Record<string, string> = { container: "calibre-web" }): ApprovalProposalRequest {
  const definition = resolveToolDefinition(name)!
  const validated = validateAdvertisedToolArguments(JSON.stringify(args), definition.tool.function.parameters!)
  if (!validated.ok) throw new Error(validated.reason)
  const policy = definition.approvalPolicy!(args)
  if (policy.kind !== "required") throw new Error("restart policy is not protected")
  return {
    toolCall: { id: "call-restart", type: "function", function: { name, arguments: JSON.stringify(args) } },
    arguments: args,
    schemaDigest: validated.value.schemaDigest,
    toolDigest: digestJson({ name, schemaDigest: validated.value.schemaDigest, policyId: policy.policyId }),
    policyDigest: digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" }),
    policyId: policy.policyId,
    actionClass: policy.actionClass,
    frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-restart", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    preCallMessages: projectProviderMessages(loadSessionEnvelopeFile(liveToolContext.currentSession!.sessionPath!)!),
    liveToolContext,
  }
}

function callback(data: string, queryId = "query-1"): TelegramUpdate {
  return { update_id: 1, callback_query: { id: queryId, from: { id: 42 }, data, message: { message_id: 101, chat: { id: 42 } } } }
}

async function ownerFixture(agentRoot: string, restartContainer: () => Promise<unknown>) {
  const credentials = { botToken: "777:fixture", botId: "777", authorizedUserId: "42", authorizedChatId: "42" }
  const friends = new FileFriendStore(path.join(agentRoot, "friends"))
  const now = new Date().toISOString()
  await friends.put("friend-ari", {
    id: "friend-ari", name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner",
    externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1,
  })
  fs.writeFileSync(path.join(agentRoot, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: {
    "sanctuary-owner": { version: 3, contextScopes: ["household.private"], toolNames: ["unraid_restart_container", "steward_policy_manage"], effectScopes: ["telegram.owner_event", "telegram.proactive"] },
    "sanctuary-household": { version: 1, contextScopes: ["own_requests"], toolNames: ["unraid_restart_container"], effectScopes: ["telegram.request_return"] },
  } }))
  const composition = await createProductionTelegramRelationshipComposition("sanctuary", credentials, agentRoot)
  const identityKey = readOrCreateTelegramIdentityKey(agentRoot)
  const subject = opaqueTelegramSubject(identityKey, "777", "42", "42")
  const sessionKey = `telegram:${subject}`
  const sessionPath = getSenseSessionPath("sanctuary", "friend-ari", "telegram", sessionKey, agentRoot)
  const effects = new FileTelegramEffectJournal(path.join(agentRoot, "state", "telegram", "ingress"))
  effectStores.push(effects)
  const ingress = await recordTelegramEffectsInSession({
    store: effects, sessionPath, artifacts: [], inbound: { text: "restart calibre-web", reference: "telegram-inbound:owner-request" },
  })
  const binding: ApprovalOwnerBinding = { friendId: "friend-ari", requestId: ingress.reference, sessionEventId: ingress.eventId, sessionKey, profileVersion: 3 }
  const resolveOwnerRelationship = (current: ApprovalOwnerBinding) => composition.resolveRelationshipAuthorization!({
    friendId: current.friendId, requestId: current.requestId, sessionEventId: current.sessionEventId, sessionKey: current.sessionKey,
    botId: "777", userId: "42", chatId: "42",
  })
  const runtimeContext: ToolContext = {
    signin: async () => undefined,
    agentRoot,
    sanctuary: {
      listContainers: vi.fn(async () => ({ ok: true, data: { containers: [{ id: "container-1", name: "calibre-web", state: "running", status: "Up", degraded: false }], truncated: false } })),
      restartContainer: vi.fn(restartContainer),
      getContainerLogs: vi.fn(), getStorage: vi.fn(), getDisks: vi.fn(), getNotifications: vi.fn(), getSystem: vi.fn(), getInstallState: vi.fn(),
      checkServices: vi.fn(), getDownloadQueue: vi.fn(), getMediaOptimization: vi.fn(), searchMediaCatalog: vi.fn(), resumeDownloadQueue: vi.fn(),
    },
  }
  const relationship = await resolveOwnerRelationship(binding)
  const requestContext: ToolContext = {
    ...runtimeContext,
    currentSession: { friendId: binding.friendId, channel: "telegram", key: sessionKey, sessionPath },
    relationshipAuthorization: {
      ...relationship, requestId: binding.requestId,
      authorizeTool: async (name, args) => (await resolveOwnerRelationship(binding)).authorizeTool(name, args),
    },
  }
  return {
    friends, binding, sessionPath, requestContext, runtimeContext, composition, credentials,
    baseSessionRevision: await withSessionTurnLease(sessionPath, async (lease) => readSessionTransaction(sessionPath, lease).revision),
    runtimeOptions: { toolContext: runtimeContext, resolveOwnerRelationship, subject, identityKey },
  }
}

async function grantFixture(owner: Awaited<ReturnType<typeof ownerFixture>>, provenance: "stated" | "installed_explicit_policy", expiresAt?: string) {
  const relationship = await owner.runtimeOptions.resolveOwnerRelationship(owner.binding)
  const authorization = relationship.authorizeTool("steward_policy_manage")
  if (!authorization.allowed || authorization.authorizationKind !== "relationship"
    || authorization.profileId !== "sanctuary-owner" || !authorization.requestId) throw new Error("fixture owner grant is not authorized")
  return updateStewardPolicy(owner.runtimeContext.agentRoot!, {
    expectedVersion: readStewardPolicy(owner.runtimeContext.agentRoot!).version,
    actor: {
      friendId: authorization.friendId, trustLevel: relationship.subject.trustLevel, sessionEventId: owner.binding.sessionEventId,
      authorization: { profileId: authorization.profileId, requestId: authorization.requestId, sessionKey: owner.binding.sessionKey, receiptId: authorization.receiptId, profileVersion: authorization.profileVersion },
    },
    mutation: {
      kind: "grant_routine_action", key: "unraid.restart:calibre-web", action: "unraid.container.restart", targets: ["calibre-web"],
      maxCount: 2, windowMs: 1800000, verificationRequired: true, exclusions: [], provenance, ...(expiresAt ? { expiresAt } : {}),
    },
  })
}

function pending(agentRoot: string): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "approvals", "telegram-pending.json"), "utf8")) as Array<Record<string, unknown>>
}

function approvalEffects(agentRoot: string, api: TelegramBotApi, owner: Awaited<ReturnType<typeof ownerFixture>>): TelegramApprovalEffectPort {
  const store = new FileTelegramEffectJournal(path.join(agentRoot, "state", "telegram", "effects"))
  effectStores.push(store)
  const target = { kind: "approved_relationship" as const, friendId: owner.binding.friendId, sessionKey: owner.binding.sessionKey }
  const execute = createTelegramAuthorizedEffectExecutor({
    store,
    api,
    authorize: owner.composition.authorizeRelationshipEffect!,
  })
  return createTelegramApprovalEffectPort({
    target,
    chatId: "42",
    execute,
    record: (artifact) => recordTelegramEffectsInSession({
      store,
      sessionPath: owner.sessionPath,
      artifacts: [artifact],
    }),
  })
}

afterEach(() => {
  setRuntimeLogger(null)
  for (const store of effectStores.splice(0)) store.close()
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("production-composed Telegram approval lifecycle", () => {
  it.each(["approve", "deny"] as const)("recovers a MAC-fenced pre-deadline %s through the real store after transport TTL with signed settlement evidence", async (decision) => {
    const agentRoot = root()
    const clock = { value: 1_000_000 }
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => events.push(event), createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))], now: () => new Date(clock.value) }))
    let messageId = 100
    let mutationCount = 0
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async (method) => method === "sendMessage" ? { message_id: ++messageId } : true),
    }
    const owner = await ownerFixture(agentRoot, async () => {
      mutationCount += 1
      return { ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }
    })
    const { sessionPath, baseSessionRevision, runtimeOptions: { identityKey } } = owner
    const dependencies = {
      agentRoot,
      now: () => clock.value,
      acceptanceMarker: () => ({ scenarioHandleDigest }),
      runProvider: async (_messages: unknown, callbacks: { onTextChunk(text: string): void }) => {
        callbacks.onTextChunk("Restart observed complete")
        return { outcome: "settled" as const }
      },
    }
    const first = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner), dependencies,
    })
    const suspension = await first.coordinator({ sessionPath, baseSessionRevision }).propose(proposalRequest(owner.requestContext))
    const approvalStateRoot = path.join(agentRoot, "state", "approvals")
    const pendingPath = path.join(approvalStateRoot, "telegram-pending.json")
    const records = pending(agentRoot)
    const record = records[0]!
    const decisionToken = JSON.parse(fs.readFileSync(path.join(approvalStateRoot, "tokens.json"), "utf8"))[suspension.approvalId] as string
    const attemptedAt = Number(record.expiresAt) - 1
    const unsigned = {
      schemaVersion: "telegram-approval-decision-attempt-v1" as const,
      decision,
      queryIdDigest: createHash("sha256").update("query-observed-before-deadline").digest("hex"),
      attemptedAt,
    }
    const macPayload = {
      approvalId: record.approvalId,
      messageId: record.messageId,
      expiresAt: record.expiresAt,
      approveCallbackData: record.approveCallbackData,
      denyCallbackData: record.denyCallbackData,
      acceptanceBinding: record.acceptanceBinding,
      ...unsigned,
    }
    records[0] = { ...record, decisionAttempt: { ...unsigned, evidenceMac: createHmac("sha256", decisionToken).update(JSON.stringify(macPayload)).digest("hex") } }
    fs.writeFileSync(pendingPath, `${JSON.stringify(records)}\n`)
    first.close()

    clock.value = Number(record.expiresAt) + 1
    const restarted = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner), dependencies,
    })
    await restarted.recover()

    expect(mutationCount).toBe(decision === "approve" ? 1 : 0)
    expect(pending(agentRoot)).toEqual([])
    expect(api.request).not.toHaveBeenCalledWith("answerCallbackQuery", expect.anything())
    const settled = events.find((event) => event.event === "telegram.callback_recovery_settled")
    expect(settled?.meta).toMatchObject({
      approvalId: suspension.approvalId,
      callbackAt: attemptedAt,
      acknowledgementState: "indeterminate_after_restart",
      recoveredAt: expect.any(Number),
      decisionAttemptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      accepted: decision === "approve",
      reason: decision === "approve" ? "accepted" : "decision_refused",
      evidenceMac: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(settled?.meta.evidenceMac).toBe(sanctuaryTelegramApprovalEvidenceMac(identityKey, "telegram.callback_recovery_settled", settled!.meta))
    restarted.close()
  })

  it("binds a delayed approval through real durable stores, executes once, resumes, delivers, and terminalizes causally", async () => {
    const agentRoot = root()
    const clock = { value: 1_000_000 }
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => events.push(event), createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))], now: () => new Date(clock.value) }))
    let messageId = 100
    let mutationCount = 0
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async (method) => {
        if (method === "sendMessage") { clock.value += 1; messageId += 1; return { message_id: messageId } }
        clock.value += 1
        return true
      }),
    }
    const owner = await ownerFixture(agentRoot, async () => {
      mutationCount += 1
      clock.value += 1
      return { ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }
    })
    const { sessionPath, baseSessionRevision, runtimeOptions: { identityKey } } = owner
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: {
        agentRoot,
        now: () => clock.value,
        acceptanceMarker: () => ({ scenarioHandleDigest }),
        executeTool: async (name, args, context) => {
          expect(context?.relationshipAuthorization).not.toBe(owner.requestContext.relationshipAuthorization)
          expect(context?.relationshipAuthorization).toMatchObject({
            requestId: owner.binding.requestId, profileId: "sanctuary-owner",
            actor: { friendId: owner.binding.friendId, trustLevel: "family", sessionEventId: owner.binding.sessionEventId },
          })
          expect(context).toHaveProperty("restartApproval", {
            approvalId: suspension.approvalId, agentRoot, ownerBinding: owner.binding,
            argumentDigest: canonicalApprovalArguments({ container: "calibre-web" }).digest,
            target: { id: "container-1", name: "calibre-web" },
          })
          return execTool(name, args, context)
        },
        runProvider: async (_messages, callbacks) => {
          clock.value += 1
          callbacks.onTextChunk("Restart observed complete")
          return { outcome: "settled" }
        },
      },
    })
    const suspension = await runtime.coordinator({ sessionPath, baseSessionRevision }).propose(proposalRequest(owner.requestContext))
    const bound = pending(agentRoot)[0]!
    expect(bound).toMatchObject({ approvalId: suspension.approvalId, deliveryState: "bound", messageId: "101" })
    const approvalStateRoot = path.join(agentRoot, "state", "approvals")
    expect(JSON.parse(fs.readFileSync(path.join(approvalStateRoot, "checkpoints.json"), "utf8"))[suspension.approvalId]).toMatchObject({
      checkpointDigest: suspension.checkpointDigest,
      suspendedSessionRevision: suspension.suspendedSessionRevision,
    })
    expect(JSON.parse(fs.readFileSync(path.join(approvalStateRoot, "tokens.json"), "utf8"))).toHaveProperty(suspension.approvalId)

    clock.value = Number(bound.expiresAt) - 120_000
    const result = await runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))
    expect(result).toMatchObject({ accepted: true, reason: "accepted" })
    expect(mutationCount).toBe(1)
    expect(pending(agentRoot)).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(approvalStateRoot, "tokens.json"), "utf8"))).not.toHaveProperty(suspension.approvalId)

    const byName = (name: string) => events.find((event) => event.event === name)!
    const prompt = byName("senses.telegram_approval_prompt_bound")
    const continuation = byName("senses.telegram_approval_continuation_delivered")
    const terminal = byName("telegram.approval_prompt_terminalized")
    const settled = byName("telegram.callback_settled")
    for (const event of [prompt, continuation, terminal, settled]) {
      expect(event.meta.checkpointDigest).toBe(suspension.checkpointDigest)
      expect(event.meta.suspendedSessionRevisionDigest).toBe(createHash("sha256").update(suspension.suspendedSessionRevision).digest("hex"))
      expect(event.meta.evidenceMac).toBe(sanctuaryTelegramApprovalEvidenceMac(identityKey, event.event, event.meta))
    }
    expect(Number(settled.meta.callbackAt)).toBeLessThanOrEqual(Number(continuation.meta.deliveredAt))
    expect(Number(continuation.meta.deliveredAt)).toBeLessThanOrEqual(Number(terminal.meta.terminalEditStartedAt))
    expect(Number(terminal.meta.terminalEditStartedAt)).toBeLessThanOrEqual(Number(terminal.meta.terminalizedAt))
    expect([prompt, continuation, terminal, settled].map((event) => events.indexOf(event))).toEqual([...[prompt, continuation, terminal, settled].map((event) => events.indexOf(event))].sort((left, right) => left - right))
    await runtime.transport.handleUpdate(callback(String(bound.approveCallbackData), "query-duplicate"))
    expect(mutationCount).toBe(1)
    runtime.close()
  })

  it("recovers an expired prompt after restart, retries primary and fallback edits, and consumes one authenticated stale tap", async () => {
    const agentRoot = root()
    const clock = { value: 2_000_000 }
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => events.push(event)], now: () => new Date(clock.value) }))
    let firstEditAttempt = true
    let mutationCount = 0
    const api = (recovering: boolean): TelegramBotApi => ({
      stop: vi.fn(),
      request: vi.fn(async (method, body) => {
        if (method === "sendMessage") return { message_id: 101 }
        if (method === "editMessageText" && body.parse_mode === "HTML") throw new TelegramApiError("HTML rejected", { status: 400 })
        if (method === "editMessageText" && !recovering && firstEditAttempt) {
          firstEditAttempt = false
          throw new TelegramApiError("fallback unavailable", { status: 503 })
        }
        return true
      }),
    })
    const dependencies = {
      agentRoot,
      now: () => clock.value,
      acceptanceMarker: () => ({ scenarioHandleDigest }),
      runProvider: async () => { throw new Error("expired approval resumed provider work") },
    }
    const owner = await ownerFixture(agentRoot, async () => { mutationCount += 1; throw new Error("expired approval executed") })
    const { sessionPath, baseSessionRevision, runtimeOptions: { identityKey } } = owner
    const firstApi = api(false)
    const first = createTelegramApprovalRuntime({ agentName: "sanctuary", api: firstApi, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, firstApi, owner), dependencies })
    await first.coordinator({ sessionPath, baseSessionRevision }).propose(proposalRequest(owner.requestContext))
    const bound = pending(agentRoot)[0]!
    clock.value = Number(bound.expiresAt)
    await expect(first.transport.reconcileExpired()).rejects.toThrow("fallback unavailable")
    expect(pending(agentRoot)[0]).toMatchObject({ deliveryState: "bound", expiryObservation: {
      schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: Number(bound.expiresAt), observedAt: Number(bound.expiresAt),
      evidenceMac: expect.stringMatching(/^[0-9a-f]{64}$/u),
    } })
    first.close()

    const secondApi = api(true)
    const second = createTelegramApprovalRuntime({ agentName: "sanctuary", api: secondApi, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, secondApi, owner), dependencies })
    await second.recover()
    expect(pending(agentRoot)).toEqual([expect.objectContaining({ deliveryState: "terminal_tombstone", messageId: "101" })])
    await second.transport.handleUpdate(callback(String(bound.approveCallbackData), "query-stale"))
    const stale = events.filter((event) => event.event === "telegram.approval_stale_callback_settled")
    expect(stale).toHaveLength(1)
    expect(stale[0]!.meta.evidenceMac).toBe(sanctuaryTelegramApprovalEvidenceMac(identityKey, stale[0]!.event, stale[0]!.meta))
    expect(pending(agentRoot)).toEqual([expect.objectContaining({ deliveryState: "terminal_tombstone", staleTap: expect.objectContaining({
      schemaVersion: "telegram-approval-stale-tap-v1", state: "consumed", consumedAt: clock.value,
    }) })])
    await second.transport.handleUpdate(callback(String(bound.approveCallbackData), "query-stale-again"))
    expect(events.filter((event) => event.event === "telegram.approval_stale_callback_settled")).toHaveLength(1)
    expect(mutationCount).toBe(0)
    second.close()
  })

  it("A006 persists the production owner's exact ingress binding without copying authority into startup context", async () => {
    const agentRoot = root()
    const owner = await ownerFixture(agentRoot, vi.fn())
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: { agentRoot, acceptanceMarker: () => null },
    })
    try {
      const suspension = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
      const store = openApprovalStore({ databasePath: path.join(agentRoot, "state", "approvals", "approvals.sqlite") })
      try {
        expect(store.read(suspension.approvalId)).toHaveProperty("ownerBinding", owner.binding)
        expect(owner.runtimeContext.relationshipAuthorization).toBeUndefined()
        expect(loadSessionEnvelopeFile(owner.sessionPath)?.events.find((event) => event.id === owner.binding.sessionEventId))
          .toMatchObject({ role: "user", relations: { references: [owner.binding.requestId] } })
      } finally { store.close() }
    } finally { runtime.close() }
  })

  it.each([
    "missing context", "missing request", "missing session", "different root", "different session path", "different session key",
    "different Friend", "missing session event", "revoked owner", "household role", "removed capability", "unavailable registry",
    "missing stored session", "empty stored session", "corrupt stored session", "missing stored ingress",
  ])("A006 rejects %s before persisting or sending an owner restart proposal", async (change) => {
    const agentRoot = root()
    const owner = await ownerFixture(agentRoot, vi.fn())
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: { agentRoot, acceptanceMarker: () => null },
    })
    const request = proposalRequest(owner.requestContext)
    const current = (await owner.friends.get(owner.binding.friendId))!
    if (change === "missing context") delete request.liveToolContext
    if (change === "missing request") owner.requestContext.relationshipAuthorization = { ...owner.requestContext.relationshipAuthorization!, requestId: undefined }
    if (change === "missing session") delete owner.requestContext.currentSession
    if (change === "different root") owner.requestContext.agentRoot = path.join(agentRoot, "other")
    if (change === "different session path") owner.requestContext.currentSession!.sessionPath = path.join(agentRoot, "other.json")
    if (change === "different session key") owner.requestContext.currentSession!.key = "telegram:other"
    if (change === "different Friend") owner.requestContext.currentSession!.friendId = "other-friend"
    if (change === "missing session event") owner.requestContext.relationshipAuthorization = {
      ...owner.requestContext.relationshipAuthorization!, actor: { ...owner.requestContext.relationshipAuthorization!.actor!, sessionEventId: "evt-999999" },
    }
    if (change === "revoked owner") await owner.friends.put(current.id, { ...current, admissionState: "revoked" })
    if (change === "household role") await owner.friends.put(current.id, { ...current, trustLevel: "friend", initiativePolicy: "request_follow_up_only", capabilityProfileId: "sanctuary-household" })
    if (change === "removed capability") {
      const registryPath = path.join(agentRoot, "tool-profiles.json")
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"))
      registry.profiles["sanctuary-owner"].toolNames = []
      fs.writeFileSync(registryPath, JSON.stringify(registry))
    }
    if (change === "unavailable registry") fs.unlinkSync(path.join(agentRoot, "tool-profiles.json"))
    if (change === "missing stored session") fs.unlinkSync(owner.sessionPath)
    if (change === "empty stored session") fs.writeFileSync(owner.sessionPath, "")
    if (change === "corrupt stored session") fs.writeFileSync(owner.sessionPath, "{")
    if (change === "missing stored ingress") {
      const session = JSON.parse(fs.readFileSync(owner.sessionPath, "utf8"))
      session.events = session.events.filter((event: { role: string }) => event.role !== "user")
      fs.writeFileSync(owner.sessionPath, JSON.stringify(session))
    }
    try {
      await expect(runtime.coordinator(owner).propose(request)).rejects.toThrow()
      expect(fs.existsSync(path.join(agentRoot, "state", "approvals", "tokens.json"))).toBe(false)
      expect(api.request).not.toHaveBeenCalled()
    } finally { runtime.close() }
  })

  it.each([
    "legacy binding", "different bound Friend", "different bound request", "different bound event", "different bound session",
    "advanced profile", "removed capability", "missing target", "ambiguous target", "renamed target", "degraded target",
    "truncated inventory", "unavailable inventory", "negative desired state", "standing grant", "installed grant",
    "revoked owner", "downgraded trust", "changed initiative", "missing callback resolver", "different runtime root",
    "different record session", "changed frozen arguments", "new request", "empty target id", "padded target id", "missing runtime", "late capability removal",
    ...Object.keys(invalidInventories),
  ])("A006 terminalizes %s before a real owner callback reaches the restart handler", async (change) => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    const restart = vi.fn(async () => ({ ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }))
    const owner = await ownerFixture(agentRoot, restart)
    if (change === "different runtime root") owner.runtimeContext.agentRoot = path.join(agentRoot, "other")
    if (change === "missing runtime") delete owner.runtimeContext.sanctuary
    let ownerReads = 0
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      ...(change === "missing callback resolver" ? { resolveOwnerRelationship: undefined } : {}),
      ...(change === "late capability removal" ? { resolveOwnerRelationship: async (binding: ApprovalOwnerBinding) => {
        const relationship = await owner.runtimeOptions.resolveOwnerRelationship(binding)
        if (++ownerReads === 3) {
          const registryPath = path.join(agentRoot, "tool-profiles.json")
          const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"))
          registry.profiles["sanctuary-owner"].toolNames = []
          fs.writeFileSync(registryPath, JSON.stringify(registry))
        }
        return relationship
      } } : {}),
      dependencies: { agentRoot, acceptanceMarker: () => null, runProvider: async () => ({ outcome: "settled" }) },
    })
    const suspension = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
    const databasePath = path.join(agentRoot, "state", "approvals", "approvals.sqlite")
    const store = openApprovalStore({ databasePath })
    try {
      if (change.startsWith("different bound") || change === "legacy binding" || change === "different record session" || change === "changed frozen arguments") {
        const database = new Database(databasePath)
        try {
          const record = store.read(suspension.approvalId)!
          if (change === "legacy binding") delete record.ownerBinding
          if (change === "different bound Friend") record.ownerBinding!.friendId = "another-friend"
          if (change === "different bound request") record.ownerBinding!.requestId = "telegram-inbound:another-request"
          if (change === "different bound event") record.ownerBinding!.sessionEventId = "evt-999999"
          if (change === "different bound session") record.ownerBinding!.sessionKey = "telegram:another-session"
          if (change === "different record session") record.sessionKey = "telegram:another-session"
          if (change === "changed frozen arguments") {
            record.arguments.container = "calibre"
            record.argumentDigest = canonicalApprovalArguments(record.arguments).digest
          }
          database.prepare("UPDATE approval_actions SET record_json = ? WHERE approval_id = ?").run(JSON.stringify(record), record.approvalId)
        } finally { database.close() }
      }
      const roleChanged = ["revoked owner", "downgraded trust", "changed initiative"].includes(change)
      if (roleChanged) {
        const current = (await owner.friends.get(owner.binding.friendId))!
        if (change === "revoked owner") await owner.friends.put(current.id, { ...current, admissionState: "revoked" })
        if (change === "downgraded trust") await owner.friends.put(current.id, { ...current, trustLevel: "friend" })
        if (change === "changed initiative") await owner.friends.put(current.id, { ...current, initiativePolicy: "reactive_only" })
      }
      if (change === "new request") {
        const ingress = new FileTelegramEffectJournal(path.join(agentRoot, "state", "telegram", "new-ingress"))
        effectStores.push(ingress)
        await recordTelegramEffectsInSession({ store: ingress, sessionPath: owner.sessionPath, artifacts: [], inbound: { text: "A new request", reference: "telegram-inbound:new-request" } })
      }
      if (change === "advanced profile" || change === "removed capability") {
        const registryPath = path.join(agentRoot, "tool-profiles.json")
        const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"))
        if (change === "advanced profile") registry.profiles["sanctuary-owner"].version += 1
        else registry.profiles["sanctuary-owner"].toolNames = []
        fs.writeFileSync(registryPath, JSON.stringify(registry))
      }
      const container = { id: "container-1", name: "calibre-web", state: "running", status: "Up", degraded: false }
      const list = vi.mocked(owner.requestContext.sanctuary!.listContainers)
      if (Object.hasOwn(invalidInventories, change)) list.mockResolvedValue(invalidInventories[change])
      if (change === "missing target") list.mockResolvedValue({ ok: true, data: { containers: [], truncated: false } })
      if (change === "ambiguous target") list.mockResolvedValue({ ok: true, data: { containers: [container, { ...container, id: "container-2" }], truncated: false } })
      if (change === "renamed target") list.mockResolvedValue({ ok: true, data: { containers: [{ ...container, name: "calibre" }], truncated: false } })
      if (change === "degraded target") list.mockResolvedValue({ ok: true, data: { containers: [{ ...container, degraded: true }], truncated: false } })
      if (change === "truncated inventory") list.mockResolvedValue({ ok: true, data: { containers: [container], truncated: true } })
      if (change === "unavailable inventory") list.mockRejectedValue(new Error("inventory unavailable"))
      if (change === "empty target id" || change === "padded target id") list.mockResolvedValue({ ok: true, data: { containers: [{ ...container, id: change === "empty target id" ? "" : " container-1 " }], truncated: false } })
      if (change === "negative desired state" || change === "standing grant") await stewardPolicyToolDefinition.handler({
        action: "set_desired_state", key: "container:calibre-web", value: change === "negative desired state" ? "off" : "on",
        provenance: "stated", source: "current authenticated fixture owner",
      }, owner.requestContext)
      if (change === "standing grant" || change === "installed grant") await grantFixture(owner, change === "standing grant" ? "stated" : "installed_explicit_policy")
      const bound = pending(agentRoot)[0]!
      if (roleChanged) await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).rejects.toThrow("Telegram effect authorization denied")
      else {
        const decision = await runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))
        expect(decision.accepted).toBe(false)
      }
      expect(store.read(suspension.approvalId)).toMatchObject({ state: change === "new request" ? "session_head_changed" : "drifted", attemptedAt: null })
      if (change === "late capability removal") expect(ownerReads).toBeGreaterThanOrEqual(4)
      expect(restart).not.toHaveBeenCalled()
    } finally { store.close(); runtime.close() }
  })

  it.each(["missing", "empty", "corrupt", "without ingress"])("A006 records no attempt when the stored callback session is %s", async (change) => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    const restart = vi.fn()
    const owner = await ownerFixture(agentRoot, restart)
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: { agentRoot, acceptanceMarker: () => null, runProvider: async () => { throw new Error("invalid session resumed provider work") } },
    })
    try {
      const suspension = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
      const bound = pending(agentRoot)[0]!
      if (change === "missing") fs.unlinkSync(owner.sessionPath)
      if (change === "empty") fs.writeFileSync(owner.sessionPath, "")
      if (change === "corrupt") fs.writeFileSync(owner.sessionPath, "{")
      if (change === "without ingress") {
        const session = JSON.parse(fs.readFileSync(owner.sessionPath, "utf8"))
        session.events = session.events.filter((event: { role: string }) => event.role !== "user")
        fs.writeFileSync(owner.sessionPath, JSON.stringify(session))
      }
      if (change === "corrupt") {
        await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).rejects.toThrow()
        expect(fs.readFileSync(owner.sessionPath, "utf8")).toBe("{")
      } else await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).resolves.toMatchObject({ accepted: false })
      const store = openApprovalStore({ databasePath: path.join(agentRoot, "state", "approvals", "approvals.sqlite") })
      try { expect(store.read(suspension.approvalId)).toMatchObject({ state: change === "corrupt" ? "drifted" : "session_head_changed", attemptedAt: null }) }
      finally { store.close() }
      expect(restart).not.toHaveBeenCalled()
    } finally { runtime.close() }
  })

  it.each(["lost marker", "mixed standing", "mixed event", "different root", "missing binding", "missing target", "different target", "different owner", "different request", "different profile", "different digest"])("A006 refuses %s in the real handler after callback admission", async (change) => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    const restart = vi.fn(async () => ({ ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }))
    const owner = await ownerFixture(agentRoot, restart)
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: {
        agentRoot, acceptanceMarker: () => null, runProvider: async () => ({ outcome: "settled" }),
        executeTool: async (name, args, context) => {
          if (!context?.restartApproval) throw new Error("callback did not supply the frozen owner binding")
          const marker = { ...context.restartApproval }
          const changedContext: ToolContext = { ...context, restartApproval: marker }
          if (change === "lost marker") delete changedContext.restartApproval
          if (change === "mixed standing") changedContext.routineActionSelection = {
            kind: "standing", agentRoot, key: "unraid.restart:calibre-web", target: "calibre-web",
            expectedPolicyVersion: 1, expectedDesiredStateVersion: 1, expectedGrantVersion: 1,
            requester: routineActionRequester(context)!, authorizationVersion: 3,
          }
          if (change === "mixed event") Object.defineProperty(changedContext, "currentExternalEvent", { value: { schemaVersion: 1, source: "sanctuary-health" } })
          if (change === "different root") changedContext.agentRoot = path.join(agentRoot, "other")
          if (change === "missing binding") Reflect.deleteProperty(marker, "ownerBinding")
          if (change === "missing target") Reflect.deleteProperty(marker, "target")
          if (change === "different target") marker.target = { ...marker.target, name: "calibre" }
          if (change === "different owner") marker.ownerBinding = { ...marker.ownerBinding, friendId: "another-friend" }
          if (change === "different request") marker.ownerBinding = { ...marker.ownerBinding, requestId: "telegram-inbound:another-request" }
          if (change === "different profile") marker.ownerBinding = { ...marker.ownerBinding, profileVersion: 4 }
          if (change === "different digest") marker.argumentDigest = "0".repeat(64)
          return execTool(name, args, changedContext)
        },
      },
    })
    try {
      const suspension = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
      const bound = pending(agentRoot)[0]!
      await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).resolves.toMatchObject({ accepted: false })
      expect(restart).not.toHaveBeenCalled()
      const store = openApprovalStore({ databasePath: path.join(agentRoot, "state", "approvals", "approvals.sqlite") })
      try { expect(store.read(suspension.approvalId)).toMatchObject({ state: "failed", attemptedAt: expect.any(String) }) }
      finally { store.close() }
    } finally { runtime.close() }
  })

  it("A006 preserves an ordinary protected non-restart approval without an owner restart binding", async () => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    const owner = await ownerFixture(agentRoot, vi.fn())
    const registryPath = path.join(agentRoot, "tool-profiles.json")
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"))
    registry.profiles["sanctuary-owner"].toolNames.push("sanctuary_resume_download_queue")
    fs.writeFileSync(registryPath, JSON.stringify(registry))
    vi.mocked(owner.runtimeContext.sanctuary!.resumeDownloadQueue).mockResolvedValue({ ok: true, data: { verified: true, after: { paused: false } } })
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: { agentRoot, acceptanceMarker: () => null, runProvider: async () => ({ outcome: "settled" }) },
    })
    try {
      const suspension = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext, "sanctuary_resume_download_queue", {}))
      const bound = pending(agentRoot)[0]!
      await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).resolves.toMatchObject({ accepted: true })
      expect(owner.runtimeContext.sanctuary!.resumeDownloadQueue).toHaveBeenCalledOnce()
      expect(owner.runtimeContext.sanctuary!.restartContainer).not.toHaveBeenCalled()
      const store = openApprovalStore({ databasePath: path.join(agentRoot, "state", "approvals", "approvals.sqlite") })
      try {
        expect(store.read(suspension.approvalId)).toMatchObject({ state: "succeeded", toolName: "sanctuary_resume_download_queue" })
        expect(store.read(suspension.approvalId)?.ownerBinding).toBeUndefined()
      } finally { store.close() }
    } finally { runtime.close() }
  })

  it.each(["legacy denial", "unavailable after success"])("A006 gives %s continuation explicit denial instead of ambient startup authority", async (change) => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    let ownerAvailable = true
    const restart = vi.fn(async () => {
      ownerAvailable = false
      return { ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }
    })
    const owner = await ownerFixture(agentRoot, restart)
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const provider = vi.fn<typeof runAgent>(async (_messages, _callbacks, _channel, _signal, options) => {
      const context = options?.toolContext
      if (!context || !options?.approvalCoordinator) throw new Error("continuation context is unavailable")
      expect(context.restartApproval).toBeUndefined()
      expect(context.relationshipAuthorization?.advertisedToolNames).toEqual([])
      expect(context.relationshipAuthorization?.authorizedContextScopes).toEqual([])
      expect(await context.relationshipAuthorization!.authorizeTool("unraid_restart_container", { container: "calibre-web" })).toMatchObject({ allowed: false })
      await expect(options.approvalCoordinator.propose(proposalRequest(context))).rejects.toThrow("current owner request")
      return { outcome: "settled" as const }
    })
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions,
      toolContext: owner.requestContext,
      resolveOwnerRelationship: async (binding) => {
        if (!ownerAvailable) throw new Error("current owner producer unavailable")
        return owner.runtimeOptions.resolveOwnerRelationship(binding)
      },
      effects: approvalEffects(agentRoot, api, owner),
      dependencies: { agentRoot, acceptanceMarker: () => null, runProvider: provider },
    })
    try {
      const suspension = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
      if (change === "legacy denial") {
        const database = new Database(path.join(agentRoot, "state", "approvals", "approvals.sqlite"))
        try {
          const row = database.prepare("SELECT record_json FROM approval_actions WHERE approval_id = ?").get(suspension.approvalId) as { record_json: string }
          const record = JSON.parse(row.record_json)
          delete record.ownerBinding
          database.prepare("UPDATE approval_actions SET record_json = ? WHERE approval_id = ?").run(JSON.stringify(record), suspension.approvalId)
        } finally { database.close() }
      }
      const bound = pending(agentRoot)[0]!
      await runtime.transport.handleUpdate(callback(String(change === "legacy denial" ? bound.denyCallbackData : bound.approveCallbackData)))
      expect(provider).toHaveBeenCalledOnce()
      expect(restart).toHaveBeenCalledTimes(change === "legacy denial" ? 0 : 1)
      expect(pending(agentRoot)).toEqual([])
    } finally { runtime.close() }
  })

  it("A006 wires the app callback resolver to the current canonical owner producer", async () => {
    const agentRoot = root()
    const owner = await ownerFixture(agentRoot, vi.fn())
    let runtimeInput: Parameters<typeof createTelegramApprovalRuntime>[0] | undefined
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: owner.credentials, ...owner.composition,
      _agentRoot: agentRoot, _toolContext: owner.runtimeContext, identityKey: owner.runtimeOptions.identityKey,
      api: { request: vi.fn(), stop: vi.fn() }, offsetStore: { load: () => 0, save: vi.fn() },
      acceptanceMarker: () => null, migrateIdentity: async () => undefined,
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      _createApprovalRuntime: (input) => {
        runtimeInput = input
        return createTelegramApprovalRuntime({ ...input, dependencies: { ...input.dependencies, agentRoot } })
      },
    })
    try {
      expect(runtimeInput?.resolveOwnerRelationship).toBeTypeOf("function")
      const resolve = runtimeInput!.resolveOwnerRelationship!
      const resolved = await resolve(owner.binding)
      expect(resolved.authorizeTool("unraid_restart_container", { container: "calibre-web" })).toMatchObject({
        allowed: true, friendId: owner.binding.friendId, profileId: "sanctuary-owner", profileVersion: 3, requestId: owner.binding.requestId,
      })
      await expect(resolve({ ...owner.binding, sessionKey: "telegram:other" })).rejects.toThrow("identity binding")
      const current = (await owner.friends.get(owner.binding.friendId))!
      await owner.friends.put(current.id, { ...current, trustLevel: "friend" })
      await expect(resolve(owner.binding)).rejects.toThrow("identity binding")
    } finally { await app.stop() }
  })

  it.each(["negative desired state", "standing grant", "installed grant"])("A006 refuses to propose when %s has removed owner fallback", async (change) => {
    const agentRoot = root()
    const owner = await ownerFixture(agentRoot, vi.fn())
    if (change !== "installed grant") await stewardPolicyToolDefinition.handler({
      action: "set_desired_state", key: "container:calibre-web", value: change === "negative desired state" ? "off" : "on",
      provenance: "stated", source: "current authenticated fixture owner",
    }, owner.requestContext)
    if (change !== "negative desired state") await grantFixture(owner, change === "standing grant" ? "stated" : "installed_explicit_policy")
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: { agentRoot, acceptanceMarker: () => null },
    })
    try {
      await expect(runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))).rejects.toThrow()
      expect(api.request).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(agentRoot, "state", "approvals", "tokens.json"))).toBe(false)
    } finally { runtime.close() }
  })

  it("A006 preserves the real owner approval fallback for an expired stated grant", async () => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    const restart = vi.fn(async () => ({ ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }))
    const owner = await ownerFixture(agentRoot, restart)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const expiry = Date.now() + 1000
      await grantFixture(owner, "stated", new Date(expiry).toISOString())
      vi.setSystemTime(expiry)
      const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: 101 })) }
      const runtime = createTelegramApprovalRuntime({
        agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
        dependencies: { agentRoot, acceptanceMarker: () => null, runProvider: async () => ({ outcome: "settled" }) },
      })
      try {
        await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
        const bound = pending(agentRoot)[0]!
        await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).resolves.toMatchObject({ accepted: true })
        expect(restart).toHaveBeenCalledOnce()
      } finally { runtime.close() }
    } finally { vi.useRealTimers() }
  })

  it("A006 resumes with fresh owner context and creates a separately bound approval without reusing the first effect authority", async () => {
    const agentRoot = root()
    setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(agentRoot, "telegram-audit.ndjson"))] }))
    const restart = vi.fn(async () => ({ ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }))
    const owner = await ownerFixture(agentRoot, restart)
    let messageId = 100
    let nextApprovalId: string | undefined
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: ++messageId })) }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "42", ...owner.runtimeOptions, effects: approvalEffects(agentRoot, api, owner),
      dependencies: {
        agentRoot, acceptanceMarker: () => null,
        runProvider: async (messages, _callbacks, _channel, _signal, options) => {
          expect(options?.toolContext?.relationshipAuthorization).toMatchObject({ requestId: owner.binding.requestId, profileId: "sanctuary-owner" })
          expect(options?.toolContext?.restartApproval).toBeUndefined()
          if (!options?.toolContext || !options.approvalCoordinator) throw new Error("continuation owner context is unavailable")
          const next = proposalRequest(options.toolContext)
          next.toolCall.id = "call-next"
          next.frozenAssistantMessage.tool_calls![0]!.id = "call-next"
          next.preCallMessages = structuredClone(messages)
          messages.push(next.frozenAssistantMessage)
          const suspended = await options.approvalCoordinator.propose(next)
          nextApprovalId = suspended.approvalId
          return { outcome: "suspended", suspension: { ...suspended, toolCallId: next.toolCall.id } }
        },
      },
    })
    try {
      const first = await runtime.coordinator(owner).propose(proposalRequest(owner.requestContext))
      const bound = pending(agentRoot)[0]!
      await expect(runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))).resolves.toMatchObject({ accepted: true })
      expect(restart).toHaveBeenCalledOnce()
      expect(nextApprovalId).toBeTypeOf("string")
      expect(nextApprovalId).not.toBe(first.approvalId)
      const store = openApprovalStore({ databasePath: path.join(agentRoot, "state", "approvals", "approvals.sqlite") })
      try {
        expect(store.read(nextApprovalId!)).toMatchObject({ state: "proposed", ownerBinding: owner.binding, toolCallId: "call-next", attemptedAt: null })
      } finally { store.close() }
    } finally { runtime.close() }
  })
})
