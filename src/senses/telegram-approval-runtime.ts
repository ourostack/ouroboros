import * as path from "node:path"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { getChannelCapabilities } from "@ouro.bot/friends"

import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "../heart/approval-files"
import { openApprovalStore, type ApprovalRecord } from "../heart/approval-store"
import { ApprovalExecutionFailedError, commitApprovalProposal, executeApprovalDecision, recoverAttemptedApproval, recoverClaimedApproval } from "../heart/tool-approval"
import { getProviderRuntime, resumeApprovalContinuation, runAgent, type ApprovalCoordinator, type RunAgentOptions } from "../heart/core"
import { getAgentRoot } from "../heart/identity"
import { loadSessionEnvelopeFile } from "../heart/session-events"
import { readSanctuaryAcceptanceMarker, runWithSanctuaryAcceptanceApproval } from "../heart/daemon/sanctuary-acceptance-marker"
import { sanctuaryTelegramApprovalEvidenceMac } from "./telegram"
import { saveSession } from "../mind/context"
import { readSessionTransaction, withSessionTurnLease } from "../mind/session-transaction"
import { approvalPolicyForInvocation, executeTool, preflightToolCall, resolveToolDefinition, selectToolsForChannel } from "../repertoire/tools"
import type { execTool } from "../repertoire/tools"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import type { ToolContext, ToolDefinition, ToolExecutionOutcome } from "../repertoire/tools-base"
import type { TelegramEffectAuthorizationInput } from "./telegram-effect-adapter"
import { emitNervesEvent, emitNervesEventDurable } from "../nerves/runtime"
import {
  createTelegramApprovalTransport,
  classifyTelegramPersistedApprovalState,
  FileTelegramPendingApprovalStore,
  TELEGRAM_APPROVAL_EXPIRED_TEXT,
  type TelegramApprovalTransport,
  type TelegramApprovalTransportOptions,
  type TelegramBotApi,
} from "./telegram-client"

export interface TelegramApprovalRuntime {
  transport: TelegramApprovalTransport
  coordinator(context: { sessionPath: string; baseSessionRevision: string }): ApprovalCoordinator
  legacySubjects(): string[]
  migrateIdentity(legacySubjects: readonly string[]): void
  recover(): Promise<void>
  isPendingTerminalControl?(input: Pick<TelegramEffectAuthorizationInput, "authorClass" | "effect" | "idempotencyKey">): Promise<boolean>
  close(): void
}

export function telegramApprovalCommitBarrierHooks(effectBarrier: () => void): NonNullable<Parameters<typeof commitApprovalProposal>[0]["hooks"]> {
  return {
    afterJournalPrepare: effectBarrier,
    afterTokenPersist: effectBarrier,
    afterCheckpointWrite: effectBarrier,
  }
}

export function telegramApprovalDecisionBarrierHooks(effectBarrier: () => void): NonNullable<Parameters<typeof executeApprovalDecision>[0]["hooks"]> {
  return {
    afterClaim: effectBarrier,
    afterAttempt: effectBarrier,
    afterHandler: effectBarrier,
  }
}

export function approvalContinuationRunAgentOptions(
  toolContext: Partial<ToolContext>,
  approvalCoordinator: ApprovalCoordinator,
): RunAgentOptions {
  return { toolContext: toolContext as ToolContext, approvalCoordinator }
}

export function formatTelegramApprovalPrompt(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "sanctuary_resume_download_queue") return "Resume household downloads? This can spend prepaid download credit. I’ll verify the queue actually resumed."
  const container = args.container
  if (toolName === "unraid_restart_container" && typeof container === "string" && container.length > 0 && container.length <= 128 && !container.includes("\n")) return `Restart ${container}?`
  return `Approve ${toolName} with exact arguments ${JSON.stringify(args)}?`
}

export async function executeApprovedTelegramTool(
  name: string,
  args: Record<string, unknown>,
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionOutcome>,
  scenarioHandleDigest?: string,
  approvalId?: string,
  effectBarrier: () => void = () => undefined,
): Promise<ToolExecutionOutcome> {
  if (name === "unraid_restart_container") emitNervesEvent({
    component: "senses",
    event: "senses.telegram_approved_restart_start",
    message: "approved Sanctuary restart execution started",
    meta: { ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}), ...(approvalId ? { approvalId } : {}) },
  })
  try {
  effectBarrier()
  const outcome = await execute(name, args)
  if (outcome.kind !== "handler_succeeded") {
    if (name === "unraid_restart_container") emitNervesEvent({
      level: "error", component: "senses", event: "senses.telegram_approved_restart_error",
      message: "approved Sanctuary restart did not complete",
      meta: { ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}), ...(approvalId ? { approvalId } : {}), outcome: outcome.kind },
    })
    return outcome
  }
  const result = outcome.text
  if (name === "sanctuary_resume_download_queue") {
    let parsed: unknown
    try { parsed = JSON.parse(result) } catch { throw new ApprovalExecutionFailedError("approved download resume returned an invalid result") }
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { ok?: unknown; data?: unknown }) : null
    const verification = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data as { verified?: unknown; after?: unknown } : null
    const after = verification?.after && typeof verification.after === "object" && !Array.isArray(verification.after) ? verification.after as { paused?: unknown } : null
    if (data?.ok !== true || verification?.verified !== true || after?.paused !== false) throw new ApprovalExecutionFailedError("approved download resume was not independently verified")
    return outcome
  }
  if (name !== "unraid_restart_container") return outcome
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    throw new ApprovalExecutionFailedError("approved restart returned an invalid result")
  }
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new ApprovalExecutionFailedError("approved restart returned an invalid result")
  }
  if ((parsed as { ok?: unknown }).ok !== true) {
    const error = (parsed as { error?: unknown }).error
    const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message.slice(0, 240)
      : "approved restart failed"
    throw new ApprovalExecutionFailedError(message)
  }
  const data = (parsed as { data?: unknown }).data
  const container = data && typeof data === "object" ? (data as { container?: unknown }).container : null
  const validSuccess = data !== null
    && typeof data === "object"
    && container !== null
    && typeof container === "object"
    && typeof (container as { id?: unknown }).id === "string"
    && (container as { id: string }).id.length > 0
    && typeof (container as { name?: unknown }).name === "string"
    && (container as { name: string }).name.length > 0
    && typeof (data as { beforeState?: unknown }).beforeState === "string"
    && typeof (data as { afterState?: unknown }).afterState === "string"
    && (data as { observedRestart?: unknown }).observedRestart === true
    && (data as { degraded?: unknown }).degraded === false
  if (!validSuccess) {
    throw new ApprovalExecutionFailedError("approved restart returned an invalid result")
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_approved_restart_end",
    message: "approved Sanctuary restart execution completed",
    meta: { ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}), ...(approvalId ? { approvalId } : {}), observedRestart: true },
  })
  return outcome
  } catch (error) {
    if (name === "unraid_restart_container") emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.telegram_approved_restart_error",
      message: "approved Sanctuary restart execution failed",
      meta: { ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}), ...(approvalId ? { approvalId } : {}), reason: error instanceof Error ? error.message.slice(0, 240) : "unknown" },
    })
    throw error
  }
}

function opaqueTelegramMessageBinding(subject: string, messageId: string): string {
  return `tgm_${createHmac("sha256", subject).update(`message:${messageId}`, "utf8").digest("base64url")}`
}

export function createTelegramApprovalRuntime(options: {
  agentName: string
  api: TelegramBotApi
  authorizedUserId: string
  authorizedChatId: string
  subject: string
  identityKey: string
  toolContext: Partial<ToolContext>
  resolveLiveToolContext?: (record: ApprovalRecord) => Promise<ToolContext>
  effects: TelegramApprovalTransportOptions["effects"]
  effectBarrier?: () => void
  dependencies?: {
    agentRoot?: string
    now?: () => number
    acceptanceMarker?: () => { scenarioHandleDigest: string } | null
    runProvider?: typeof runAgent
    resolveTool?: typeof resolveToolDefinition
    executeTool?: typeof execTool
    getProviderRuntime?: typeof getProviderRuntime
    getSharedMcpManager?: typeof getSharedMcpManager
    commitAcceptanceEvidence?: (event: string, meta: Record<string, unknown>) => void | Promise<void>
  }
}): TelegramApprovalRuntime {
  const effectBarrier = options.effectBarrier ?? (() => undefined)
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_approval_runtime_create",
    message: "creating durable Telegram approval runtime",
    meta: { agentName: options.agentName },
  })
  const now = options.dependencies?.now ?? Date.now
  const acceptanceMarker = options.dependencies?.acceptanceMarker ?? (() => readSanctuaryAcceptanceMarker(options.agentName))
  const provider = options.dependencies?.runProvider ?? runAgent
  const resolveTool = options.dependencies?.resolveTool ?? resolveToolDefinition
  const agentRoot = options.dependencies?.agentRoot ?? getAgentRoot(options.agentName)
  const owner = Object.freeze({ agentName: options.agentName, agentRoot })
  const currentOptions = async (record: ApprovalRecord): Promise<(RunAgentOptions & { toolContext: ToolContext }) | null> => {
    try {
      if (!options.resolveLiveToolContext) throw new Error("current owner authority producer is unavailable")
      const context = await options.resolveLiveToolContext(record)
      const relationship = context.relationshipAuthorization
      if (context.agentName !== owner.agentName || context.agentRoot !== owner.agentRoot
        || relationship?.profileId !== "sanctuary-owner" || relationship.actor?.trustLevel !== "family"
        || context.context?.friend.trustLevel !== "family" || context.context.friend.id !== relationship.actor.friendId
        || context.currentSession?.friendId !== relationship.actor.friendId
        || context.currentSession.key !== record.sessionKey || context.currentSession.sessionPath !== record.sessionPath) {
        throw new Error("current approval owner coordinates are not exact")
      }
      const runtime = await (options.dependencies?.getProviderRuntime ?? getProviderRuntime)("human", owner)
      const mcpManager = await (options.dependencies?.getSharedMcpManager ?? getSharedMcpManager)(owner) ?? undefined
      const selectCurrentTools = () => selectToolsForChannel(
        getChannelCapabilities("telegram"), context.context?.friend.toolPreferences, context.context,
        runtime.capabilities, mcpManager, runtime.model, context,
      )
      return {
        providerRuntimeOverride: runtime, mcpManager,
        toolContext: { ...context, toolSelection: selectCurrentTools(), selectCurrentTools },
      }
    } catch (error) {
      emitNervesEvent({
        level: "warn", component: "senses", event: "senses.telegram_approval_authority_unavailable",
        message: "current approval authority could not be reconstructed; execution remains disabled",
        meta: { approvalId: record.approvalId, category: error instanceof Error ? error.name : "unknown" },
      })
      return null
    }
  }
  const invocationContext = (current: RunAgentOptions & { toolContext: ToolContext }, definition: ToolDefinition): ToolContext => ({
    ...current.toolContext,
    toolSelection: Object.freeze({ ordinary: Object.freeze([definition]), engine: Object.freeze([]) }),
  })
  const stateRoot = path.join(agentRoot, "state", "approvals")
  const store = openApprovalStore({ databasePath: path.join(stateRoot, "approvals.sqlite"), now: () => new Date(now()) })
  const checkpoints = new FileApprovalCheckpointStore(path.join(stateRoot, "checkpoints.json"))
  const tokens = new FileApprovalTokenStore(path.join(stateRoot, "tokens.json"))
  const pendingStore = new FileTelegramPendingApprovalStore(path.join(stateRoot, "telegram-pending.json"))
  let transport!: TelegramApprovalTransport
  const commitAcceptanceEvidence = options.dependencies?.commitAcceptanceEvidence ?? (async (event: string, meta: Record<string, unknown>): Promise<void> => {
    if (event === "telegram.callback_settled") {
      await emitNervesEventDurable({
        component: "senses",
        event: "telegram.callback_settled",
        message: "Telegram approval acceptance evidence durably recorded",
        meta,
      })
    } else if (event === "telegram.callback_recovery_settled") {
      await emitNervesEventDurable({
        component: "senses",
        event: "telegram.callback_recovery_settled",
        message: "Telegram approval acceptance evidence durably recorded",
        meta,
      })
    } else {
      throw new Error("Telegram durable acceptance settlement event is unsupported")
    }
  })

  const coordinator = (context: { sessionPath: string; baseSessionRevision: string }): ApprovalCoordinator => ({
    propose: async (request) => {
      if (request.toolCall.type !== "function") throw new Error("approval requires a function tool call")
      effectBarrier()
      const scenarioHandleDigest = acceptanceMarker()?.scenarioHandleDigest
      const committed = commitApprovalProposal({
        approvalStore: store,
        checkpointStore: checkpoints,
        tokenStore: tokens,
        proposal: {
          toolCallId: request.toolCall.id,
          toolName: request.toolCall.function.name,
          arguments: request.arguments,
          schemaDigest: request.schemaDigest,
          toolDigest: request.toolDigest,
          policyDigest: request.policyDigest,
          policyId: request.policyId,
          sessionKey: `telegram:${options.subject}`,
          sessionPath: context.sessionPath,
          baseSessionRevision: context.baseSessionRevision,
          checkpointDigest: "0".repeat(64),
          requesterId: options.subject,
          transport: "telegram",
          transportUserId: options.subject,
          transportChatId: options.subject,
          expiresAt: new Date(now() + 300_000).toISOString(),
          frozenAssistantMessage: request.frozenAssistantMessage as never,
          ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}),
        },
        preCallMessages: request.preCallMessages,
        hooks: telegramApprovalCommitBarrierHooks(effectBarrier),
      })
      const prompt = formatTelegramApprovalPrompt(request.toolCall.function.name, request.arguments)
      effectBarrier()
      const actionDigest = createHash("sha256").update(JSON.stringify({ toolName: committed.record.toolName, argumentDigest: committed.record.argumentDigest })).digest("hex")
      const targetDigest = createHash("sha256").update(JSON.stringify({ container: committed.record.arguments.container })).digest("hex")
      const sent = await transport.sendApproval({
        approvalId: committed.record.approvalId,
        decisionToken: committed.decisionToken,
        prompt,
        ...(scenarioHandleDigest ? { acceptanceBinding: {
          scenarioHandleDigest,
          actionDigest,
          targetDigest,
          checkpointDigest: committed.record.checkpointDigest,
          suspendedSessionRevisionDigest: createHash("sha256").update(committed.record.suspendedSessionRevision!, "utf8").digest("hex"),
        } } : {}),
      })
      effectBarrier()
      store.bindPrompt({
        approvalId: committed.record.approvalId,
        transport: "telegram",
        transportChatId: options.subject,
        transportMessageId: opaqueTelegramMessageBinding(options.subject, sent.messageId),
        expiresAt: new Date(sent.expiresAt).toISOString(),
      })
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_approval_proposed",
        message: "Telegram approval proposal was durably bound",
        meta: { ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}), toolName: request.toolCall.function.name },
      })
      return {
        approvalId: committed.record.approvalId,
        checkpointDigest: committed.record.checkpointDigest,
        suspendedSessionRevision: committed.record.suspendedSessionRevision!,
      }
    },
  })

  const terminalOutcome = (record: ApprovalRecord): { accepted: boolean; terminalText: string } => {
    const accepted = record.state === "succeeded"
    return {
      accepted,
      terminalText: accepted
        ? "✅ Approved — action completed"
        : record.state === "denied"
          ? "❌ Denied — no action taken"
          : record.state === "attempted_indeterminate"
            ? "⚠️ Action outcome is indeterminate after restart — it was not retried"
            : "⚠️ Approval did not complete",
    }
  }

  const continueTerminalRecord = (record: ApprovalRecord, acceptanceBinding?: {
    scenarioHandleDigest: string; actionDigest: string; targetDigest: string; checkpointDigest: string; suspendedSessionRevisionDigest: string; messageIdDigest: string; boundAt: number
  }): Promise<{ accepted: boolean; terminalText: string }> => {
    return withSessionTurnLease(record.sessionPath, async (lease) => {
      const checkpoint = checkpoints.read(record.approvalId)
      if (!checkpoint) return { accepted: false, terminalText: "⚠️ Approval checkpoint is unavailable" }
      const continuationOwnerId = `telegram-continuation-${randomUUID()}`
      let continuationEpoch = 0
      let continuationCausalEventId: string | undefined
      let continuationAuthorized = false
      let controlNotice: string | undefined
      const continuationCoordinator: ApprovalCoordinator = {
        propose: (request) => coordinator({
          sessionPath: record.sessionPath,
          baseSessionRevision: readSessionTransaction(record.sessionPath, lease).revision,
        }).propose(request),
      }
      effectBarrier()
      await resumeApprovalContinuation({
        record,
        checkpoint,
        currentSessionRevision: readSessionTransaction(record.sessionPath, lease).revision,
        sessionMessages: checkpoint.preCallMessages,
        callbacks: {},
        channel: "telegram",
        claimContinuation: () => {
          effectBarrier()
          const claim = store.claimContinuation({ approvalId: record.approvalId, ownerId: continuationOwnerId })
          continuationEpoch = claim.record.continuationEpoch
          return claim
        },
        markContinuationMaterialized: () => { effectBarrier(); store.markContinuationMaterialized({ approvalId: record.approvalId, ownerId: continuationOwnerId, epoch: continuationEpoch }) },
        markContinuationAttempted: () => { effectBarrier(); store.markContinuationAttempted({ approvalId: record.approvalId, ownerId: continuationOwnerId, epoch: continuationEpoch }) },
        completeContinuation: () => { effectBarrier(); store.completeContinuation({ approvalId: record.approvalId, ownerId: continuationOwnerId, epoch: continuationEpoch }) },
        runAgent: provider,
        revalidate: async () => {
          const current = await currentOptions(record)
          continuationAuthorized = current !== null
          return current ? { ...current, ...approvalContinuationRunAgentOptions(current.toolContext, continuationCoordinator) } : null
        },
        persist: (messages, result) => {
          effectBarrier()
          const existingEventIds = new Set(loadSessionEnvelopeFile(record.sessionPath)?.events.map((event) => event.id) ?? [])
          const events = saveSession(record.sessionPath, messages, result?.usage, undefined, lease)
          continuationCausalEventId = result
            ? [...events].reverse().find((event) => event.role === "assistant" && !existingEventIds.has(event.id))?.id
            : undefined
        },
        deliver: async (text) => {
          effectBarrier()
          if (!continuationAuthorized) {
            controlNotice = text
            emitNervesEvent({
              component: "senses", event: "senses.telegram_approval_control_only",
              message: "approval result will use its existing terminal control instead of an unauthorized Butler message",
              meta: { approvalId: record.approvalId, state: record.state },
            })
            return
          }
          const messageIds = await options.effects.sendText({ idempotencyKey: `approval:${record.approvalId}:continuation:${createHash("sha256").update(text).digest("hex")}`, chatId: options.authorizedChatId, text, authorClass: "butler", ...(continuationCausalEventId ? { causalEventId: continuationCausalEventId } : {}) })
          effectBarrier()
          if (acceptanceBinding) {
            const unsigned = {
              approvalId: record.approvalId,
              ...acceptanceBinding,
              deliveredAt: now(),
              resultDigest: createHash("sha256").update(JSON.stringify({ state: record.state, result: record.result })).digest("hex"),
              deliveryDigest: createHash("sha256").update(text, "utf8").digest("hex"),
              deliveryMessageIdDigest: createHash("sha256").update(JSON.stringify(messageIds ?? [])).digest("hex"),
            }
            emitNervesEvent({
              component: "senses",
              event: "senses.telegram_approval_continuation_delivered",
              message: "Telegram approval continuation result was delivered",
              meta: { ...unsigned, evidenceMac: sanctuaryTelegramApprovalEvidenceMac(options.identityKey, "senses.telegram_approval_continuation_delivered", unsigned) },
            })
          }
        },
      })
      return { ...terminalOutcome(record), ...(controlNotice ? { terminalText: controlNotice } : {}) }
    })
  }

  transport = createTelegramApprovalTransport({
    api: options.api,
    effects: options.effects,
    expectedUserId: options.authorizedUserId,
    expectedChatId: options.authorizedChatId,
    pendingStore,
    createOpaqueHandle: () => randomBytes(12).toString("base64url"),
    acceptanceEventMeta: () => {
      const scenarioHandleDigest = acceptanceMarker()?.scenarioHandleDigest
      const meta: Record<string, string> = scenarioHandleDigest ? { scenarioHandleDigest } : {}
      return meta
    },
    effectBarrier,
    signAcceptanceEvidence: (event, meta) => sanctuaryTelegramApprovalEvidenceMac(options.identityKey, event, meta),
    commitAcceptanceEvidence,
    onSettlementComplete: async (approvalId) => { tokens.remove(approvalId) },
    acceptanceMessageIdDigest: (messageId) => createHash("sha256").update(opaqueTelegramMessageBinding(options.subject, messageId), "utf8").digest("hex"),
    now,
    resolveDecisionToken: async (approvalId) => tokens.get(approvalId) ?? "",
    onExpire: async (approvalId) => {
      effectBarrier()
      store.expire({ approvalId })
      effectBarrier()
      tokens.remove(approvalId)
    },
    onDecision: async (decision) => {
      effectBarrier()
      const decisionScenarioDigest = acceptanceMarker()?.scenarioHandleDigest
      const existing = store.read(decision.approvalId)
      if (!existing) return { accepted: false, terminalText: "⚠️ Approval is no longer valid" }
      let record: ApprovalRecord
      if (existing.state === "claimed") {
        effectBarrier()
        record = recoverClaimedApproval({ approvalStore: store, approvalId: existing.approvalId, reason: "decision interrupted before action attempt; action was not executed" })
      } else if (existing.state === "attempted") {
        effectBarrier()
        record = recoverAttemptedApproval({ approvalStore: store, approvalId: existing.approvalId })
      } else if (existing.state === "proposed") {
        const ownerId = `telegram-decision-${randomUUID()}`
        let definition: ToolDefinition | undefined
        record = await withSessionTurnLease(existing.sessionPath, async (lease) => executeApprovalDecision({
            approvalStore: store,
            checkpointStore: checkpoints,
            decision: {
              ...decision,
              requesterId: options.subject,
              transportUserId: options.subject,
              transportChatId: options.subject,
              transportMessageId: opaqueTelegramMessageBinding(options.subject, decision.transportMessageId),
              sessionKey: existing.sessionKey,
            },
            ownerId,
            currentSessionRevision: readSessionTransaction(existing.sessionPath, lease).revision,
            resolveTool: async (name) => {
              const current = await currentOptions(existing)
              definition = current ? resolveTool(name, current.toolContext.toolSelection) : undefined
              return definition
            },
            resolveApprovalPolicy: async (name, args) => {
              const current = await currentOptions(existing)
              return current ? approvalPolicyForInvocation(name, args, current.toolContext) : { kind: "not_required" }
            },
            liveGuard: async () => ({ ok: true }),
            liveRisk: async () => ({ ok: true }),
            preflight: async (context) => {
              const current = await currentOptions(existing)
              if (!current) return { ok: false, reason: "current tool authority is unavailable" }
              const result = await preflightToolCall(context.record.toolName, context.arguments as Record<string, string>, invocationContext(current, context.definition))
              return result.kind === "ready" ? { ok: true } : { ok: false, reason: result.text }
            },
            hooks: telegramApprovalDecisionBarrierHooks(effectBarrier),
            execute: async (name, args) => {
              const current = await currentOptions(existing)
              if (!current || !definition) return { kind: "rejected_before_handler", text: "current approved tool authority is unavailable" }
              const approvedToolContext = invocationContext(current, definition)
              const execute = () => executeApprovedTelegramTool(
                name,
                args,
                (toolName, toolArgs) => executeTool(toolName, toolArgs as Record<string, string>, approvedToolContext, options.dependencies?.executeTool),
                decisionScenarioDigest,
                existing.approvalId,
                effectBarrier,
              )
              return decisionScenarioDigest
                ? runWithSanctuaryAcceptanceApproval(
                  { approvalId: existing.approvalId, argumentDigest: existing.argumentDigest },
                  execute,
                )
                : execute()
            },
          }))
      } else if (["succeeded", "failed", "attempted_indeterminate", "denied", "expired", "drifted", "session_head_changed", "abandoned_before_attempt"].includes(existing.state)) {
        record = existing
      } else {
        return { accepted: false, terminalText: "⚠️ Approval is not recoverable" }
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_approval_terminal",
        message: "Telegram approval reached a terminal decision state",
        meta: { state: record.state, ...(decisionScenarioDigest ? { scenarioHandleDigest: decisionScenarioDigest } : {}) },
      })
      return continueTerminalRecord(record, decision.acceptanceBinding)
    },
  })

  const recover = async (): Promise<void> => {
    let failureCount = 0
    let fencedFailure: unknown
    for (const pending of transport.listPendingDeliveries()) {
      let persistedState: ReturnType<typeof classifyTelegramPersistedApprovalState>
      try {
        persistedState = classifyTelegramPersistedApprovalState(pending)
      } catch (error) {
        failureCount += 1
        fencedFailure ??= error
        continue
      }
      const mustFailClosed = persistedState === "decision_attempt" || persistedState === "action_terminal"
      try {
        const existing = store.read(pending.approvalId)
        if (!existing) {
          if (mustFailClosed) throw new Error("Telegram fenced approval journal is unavailable")
          const orphanRecovery = await transport.terminalizeOrphaned(
            pending.approvalId,
            "⚠️ Approval record is unavailable — the action outcome is unknown and will not be retried",
          )
          emitNervesEvent({
            component: "senses",
            event: "senses.telegram_approval_orphan_recovered",
            message: "orphaned Telegram approval transport state was removed",
            meta: {
              agentName: options.agentName,
              recovery: "missing_journal",
              terminalEditSucceeded: orphanRecovery.terminalEditSucceeded,
            },
          })
          continue
        }
        if (mustFailClosed) {
          await transport.recoverDecisionAttempt(pending.approvalId)
          continue
        }
        if (persistedState === "expiry_observed") {
          await transport.reconcileExpired()
          continue
        }
        if (persistedState === "delivery_interruption") {
          await transport.terminalizeRecovered(pending.approvalId, pending.terminal!.terminalText)
          continue
        }
        const deliveryState = pending.deliveryState ?? "bound"
        if (existing.state === "awaiting_prompt_binding" && deliveryState !== "bound") {
          effectBarrier()
          const record = store.abandonPromptBinding({
            approvalId: existing.approvalId,
            reason: deliveryState === "pending"
              ? "approval prompt was interrupted before delivery; action was not executed"
              : "approval prompt delivery was indeterminate; action was not executed",
          })
          const outcome = await continueTerminalRecord(record)
          await transport.terminalizeRecovered(record.approvalId, outcome.terminalText)
          continue
        }
        if (existing.state === "awaiting_prompt_binding" && deliveryState === "bound" && pending.messageId) {
          effectBarrier()
          store.bindPrompt({
            approvalId: existing.approvalId,
            transport: "telegram",
            transportChatId: options.subject,
            transportMessageId: opaqueTelegramMessageBinding(options.subject, pending.messageId),
          })
          continue
        }
        if (existing.state === "proposed" || existing.state === "preparing" || existing.state === "awaiting_prompt_binding") continue
        if (existing.state === "expired" && !pending.terminal) {
          await transport.reconcileExpired()
          continue
        }
        let record = existing
        if (record.state === "claimed") {
          effectBarrier()
          record = recoverClaimedApproval({ approvalStore: store, approvalId: record.approvalId, reason: "decision interrupted before action attempt; action was not executed" })
        } else if (record.state === "attempted") {
          effectBarrier()
          record = recoverAttemptedApproval({ approvalStore: store, approvalId: record.approvalId })
        }
        const outcome = await continueTerminalRecord(record)
        await transport.terminalizeRecovered(record.approvalId, outcome.terminalText)
      } catch (error) {
        failureCount += 1
        if (mustFailClosed) fencedFailure ??= error
      }
    }
    if (failureCount > 0) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.telegram_approval_recovery_error",
        message: "Telegram approval startup recovery completed with isolated failures",
        meta: { failureCount },
      })
    }
    if (fencedFailure !== undefined) throw fencedFailure
  }

  const legacySubjects = (): string[] => (store.listTelegramIdentitySubjects?.() ?? [])
    .filter((candidate) => candidate !== options.subject)

  const migrateIdentity = (subjects: readonly string[]): void => {
    for (const legacySubject of subjects) {
      effectBarrier()
      store.migrateTelegramIdentity?.({
        legacyUserId: legacySubject,
        legacyChatId: legacySubject,
        subject: options.subject,
      })
    }
    effectBarrier()
    store.migrateTelegramIdentity?.({
      legacyUserId: options.authorizedUserId,
      legacyChatId: options.authorizedChatId,
      subject: options.subject,
    })
  }

  const isPendingTerminalControl: NonNullable<TelegramApprovalRuntime["isPendingTerminalControl"]> = async (input) => {
    if (input.authorClass !== "control") return false
    const effect = input.effect
    for (const pending of transport.listPendingDeliveries()) {
      const record = store.read(pending.approvalId)
      if (!record || !pending.messageId || record.transport !== "telegram"
        || record.requesterId !== options.subject || record.transportUserId !== options.subject
        || record.transportChatId !== options.subject || record.sessionKey !== `telegram:${options.subject}`
        || record.transportMessageId !== opaqueTelegramMessageBinding(options.subject, pending.messageId)
        || !["succeeded", "failed", "attempted_indeterminate", "denied", "expired", "drifted", "session_head_changed", "abandoned_before_attempt"].includes(record.state)
        || (pending.terminal && pending.terminal.accepted !== (record.state === "succeeded"))) continue
      let matches = false
      if (effect.kind === "callback_ack") {
        const digest = createHash("sha256").update(effect.callbackQueryId).digest("hex")
        matches = Boolean(pending.terminal && effect.text === undefined && effect.showAlert !== true
          && pending.decisionAttempt?.queryIdDigest === digest && input.idempotencyKey === `approval-callback:${digest}`)
      } else if (effect.kind === "edit") {
        const terminalText = pending.terminal?.terminalText
          ?? (record.state === "expired" && pending.expiryObservation?.deadlineAt === pending.expiresAt
            && pending.expiryObservation.observedAt >= pending.expiresAt ? TELEGRAM_APPROVAL_EXPIRED_TEXT : undefined)
        matches = terminalText !== undefined && effect.text === terminalText && effect.messageId === Number(pending.messageId)
          && input.idempotencyKey === `approval:${pending.approvalId}:edit:${createHash("sha256").update(terminalText).digest("hex")}`
      }
      if (!matches) continue
      await transport.validatePendingTerminalControl(pending.approvalId)
      return true
    }
    return false
  }

  return { transport, coordinator, legacySubjects, migrateIdentity, recover, isPendingTerminalControl, close: () => store.close() }
}
