import * as path from "node:path"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"

import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "../heart/approval-files"
import { openApprovalStore, type ApprovalRecord } from "../heart/approval-store"
import { ApprovalExecutionFailedError, commitApprovalProposal, executeApprovalDecision, recoverAttemptedApproval, recoverClaimedApproval } from "../heart/tool-approval"
import { resumeApprovalContinuation, runAgent, type ApprovalCoordinator, type RunAgentOptions } from "../heart/core"
import { getAgentRoot } from "../heart/identity"
import { readSanctuaryAcceptanceMarker, runWithSanctuaryAcceptanceApproval } from "../heart/daemon/sanctuary-acceptance-marker"
import { sanctuaryTelegramApprovalEvidenceMac } from "./telegram"
import { saveSession } from "../mind/context"
import { readSessionTransaction, withSessionTurnLease } from "../mind/session-transaction"
import { execTool, resolveToolDefinition } from "../repertoire/tools"
import type { ToolContext } from "../repertoire/tools-base"
import { emitNervesEvent, emitNervesEventDurable } from "../nerves/runtime"
import {
  createTelegramApprovalTransport,
  classifyTelegramPersistedApprovalState,
  FileTelegramPendingApprovalStore,
  sendTelegramText,
  type TelegramApprovalTransport,
  type TelegramBotApi,
} from "./telegram-client"

export interface TelegramApprovalRuntime {
  transport: TelegramApprovalTransport
  coordinator(context: { sessionPath: string; baseSessionRevision: string }): ApprovalCoordinator
  legacySubjects(): string[]
  migrateIdentity(legacySubjects: readonly string[]): void
  recover(): Promise<void>
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

export async function executeApprovedTelegramTool(
  name: string,
  args: Record<string, unknown>,
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  scenarioHandleDigest?: string,
  approvalId?: string,
  effectBarrier: () => void = () => undefined,
): Promise<string> {
  if (name === "unraid_restart_container") emitNervesEvent({
    component: "senses",
    event: "senses.telegram_approved_restart_start",
    message: "approved Sanctuary restart execution started",
    meta: { ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}), ...(approvalId ? { approvalId } : {}) },
  })
  try {
  effectBarrier()
  const result = await execute(name, args)
  if (name !== "unraid_restart_container") return result
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
  return result
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
  effectBarrier?: () => void
  dependencies?: {
    agentRoot?: string
    now?: () => number
    acceptanceMarker?: () => { scenarioHandleDigest: string } | null
    runProvider?: typeof runAgent
    resolveTool?: typeof resolveToolDefinition
    executeTool?: typeof execTool
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
  const executeTool = options.dependencies?.executeTool ?? execTool
  const stateRoot = path.join(options.dependencies?.agentRoot ?? getAgentRoot(options.agentName), "state", "approvals")
  const store = openApprovalStore({ databasePath: path.join(stateRoot, "approvals.sqlite"), now: () => new Date(now()) })
  const checkpoints = new FileApprovalCheckpointStore(path.join(stateRoot, "checkpoints.json"))
  const tokens = new FileApprovalTokenStore(path.join(stateRoot, "tokens.json"))
  const pendingStore = new FileTelegramPendingApprovalStore(path.join(stateRoot, "telegram-pending.json"))
  let transport!: TelegramApprovalTransport

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
      const prompt = `Approve ${request.toolCall.function.name} with exact arguments ${JSON.stringify(request.arguments)}?`
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
        runAgentOptions: approvalContinuationRunAgentOptions(options.toolContext, continuationCoordinator),
        persist: (messages, result) => { effectBarrier(); saveSession(record.sessionPath, messages, result?.usage, undefined, lease) },
        deliver: async (text) => {
          effectBarrier()
          const messageIds = await sendTelegramText(options.api, options.authorizedChatId, text)
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
      return terminalOutcome(record)
    })
  }

  transport = createTelegramApprovalTransport({
    api: options.api,
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
    commitAcceptanceEvidence: options.dependencies?.commitAcceptanceEvidence ?? ((event, meta) => emitNervesEventDurable({
      component: "senses",
      event,
      message: "Telegram approval acceptance evidence durably recorded",
      meta,
    })),
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
            resolveTool,
            liveGuard: async () => ({ ok: true }),
            liveRisk: async () => ({ ok: true }),
            hooks: telegramApprovalDecisionBarrierHooks(effectBarrier),
            execute: (name, args) => {
              const execute = () => executeApprovedTelegramTool(
                name,
                args,
                (toolName, toolArgs) => executeTool(toolName, toolArgs as Record<string, string>, options.toolContext as ToolContext),
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
            "⚠️ Approval record is unavailable — no action was taken",
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

  return { transport, coordinator, legacySubjects, migrateIdentity, recover, close: () => store.close() }
}
