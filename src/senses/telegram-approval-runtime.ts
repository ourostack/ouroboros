import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"

import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "../heart/approval-files"
import { openApprovalStore, type ApprovalRecord } from "../heart/approval-store"
import { ApprovalExecutionFailedError, commitApprovalProposal, executeApprovalDecision, recoverAttemptedApproval, recoverClaimedApproval } from "../heart/tool-approval"
import { resumeApprovalContinuation, runAgent, type ApprovalCoordinator, type RunAgentOptions } from "../heart/core"
import { getAgentRoot } from "../heart/identity"
import { saveSession } from "../mind/context"
import { readSessionTransaction, withSessionTurnLease } from "../mind/session-transaction"
import { execTool, resolveToolDefinition } from "../repertoire/tools"
import type { ToolContext } from "../repertoire/tools-base"
import { emitNervesEvent } from "../nerves/runtime"
import {
  createTelegramApprovalTransport,
  FileTelegramPendingApprovalStore,
  sendTelegramText,
  type TelegramApprovalTransport,
  type TelegramBotApi,
} from "./telegram-client"

export interface TelegramApprovalRuntime {
  transport: TelegramApprovalTransport
  coordinator(context: { sessionPath: string; baseSessionRevision: string }): ApprovalCoordinator
  recover(): Promise<void>
  close(): void
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
): Promise<string> {
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
  return result
}

export function createTelegramApprovalRuntime(options: {
  agentName: string
  api: TelegramBotApi
  authorizedUserId: string
  authorizedChatId: string
  toolContext: Partial<ToolContext>
}): TelegramApprovalRuntime {
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_approval_runtime_create",
    message: "creating durable Telegram approval runtime",
    meta: { agentName: options.agentName },
  })
  const stateRoot = path.join(getAgentRoot(options.agentName), "state", "approvals")
  const store = openApprovalStore({ databasePath: path.join(stateRoot, "approvals.sqlite") })
  const checkpoints = new FileApprovalCheckpointStore(path.join(stateRoot, "checkpoints.json"))
  const tokens = new FileApprovalTokenStore(path.join(stateRoot, "tokens.json"))
  const pendingStore = new FileTelegramPendingApprovalStore(path.join(stateRoot, "telegram-pending.json"))
  let transport!: TelegramApprovalTransport

  const coordinator = (context: { sessionPath: string; baseSessionRevision: string }): ApprovalCoordinator => ({
    propose: async (request) => {
      if (request.toolCall.type !== "function") throw new Error("approval requires a function tool call")
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
          sessionKey: `telegram:${options.authorizedChatId}`,
          sessionPath: context.sessionPath,
          baseSessionRevision: context.baseSessionRevision,
          checkpointDigest: "0".repeat(64),
          requesterId: options.authorizedUserId,
          transport: "telegram",
          transportUserId: options.authorizedUserId,
          transportChatId: options.authorizedChatId,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          frozenAssistantMessage: request.frozenAssistantMessage as never,
        },
        preCallMessages: request.preCallMessages,
      })
      const prompt = `Approve ${request.toolCall.function.name} with exact arguments ${JSON.stringify(request.arguments)}?`
      const sent = await transport.sendApproval({ approvalId: committed.record.approvalId, decisionToken: committed.decisionToken, prompt })
      store.bindPrompt({
        approvalId: committed.record.approvalId,
        transport: "telegram",
        transportChatId: options.authorizedChatId,
        transportMessageId: sent.messageId,
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

  const continueTerminalRecord = (record: ApprovalRecord): Promise<{ accepted: boolean; terminalText: string }> => withSessionTurnLease(record.sessionPath, async (lease) => {
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
    await resumeApprovalContinuation({
      record,
      checkpoint,
      currentSessionRevision: readSessionTransaction(record.sessionPath, lease).revision,
      sessionMessages: checkpoint.preCallMessages,
      callbacks: {},
      channel: "telegram",
      claimContinuation: () => {
        const claim = store.claimContinuation({ approvalId: record.approvalId, ownerId: continuationOwnerId })
        continuationEpoch = claim.record.continuationEpoch
        return claim
      },
      markContinuationMaterialized: () => { store.markContinuationMaterialized({ approvalId: record.approvalId, ownerId: continuationOwnerId, epoch: continuationEpoch }) },
      markContinuationAttempted: () => { store.markContinuationAttempted({ approvalId: record.approvalId, ownerId: continuationOwnerId, epoch: continuationEpoch }) },
      completeContinuation: () => { store.completeContinuation({ approvalId: record.approvalId, ownerId: continuationOwnerId, epoch: continuationEpoch }) },
      runAgent,
      runAgentOptions: approvalContinuationRunAgentOptions(options.toolContext, continuationCoordinator),
      persist: (messages, result) => saveSession(record.sessionPath, messages, result?.usage, undefined, lease),
      deliver: async (text) => { await sendTelegramText(options.api, options.authorizedChatId, text) },
    })
    tokens.remove(record.approvalId)
    return terminalOutcome(record)
  })

  transport = createTelegramApprovalTransport({
    api: options.api,
    expectedUserId: options.authorizedUserId,
    expectedChatId: options.authorizedChatId,
    pendingStore,
    createOpaqueHandle: () => randomBytes(12).toString("base64url"),
    resolveDecisionToken: async (approvalId) => tokens.get(approvalId) ?? "",
    onExpire: async (approvalId) => {
      store.expire({ approvalId })
      tokens.remove(approvalId)
    },
    onDecision: async (decision) => {
      const existing = store.read(decision.approvalId)
      if (!existing) return { accepted: false, terminalText: "⚠️ Approval is no longer valid" }
      let record: ApprovalRecord
      if (existing.state === "claimed") {
        record = recoverClaimedApproval({ approvalStore: store, approvalId: existing.approvalId, reason: "decision interrupted before action attempt; action was not executed" })
      } else if (existing.state === "attempted") {
        record = recoverAttemptedApproval({ approvalStore: store, approvalId: existing.approvalId })
      } else if (existing.state === "proposed") {
        const ownerId = `telegram-decision-${randomUUID()}`
        record = await withSessionTurnLease(existing.sessionPath, async (lease) => executeApprovalDecision({
            approvalStore: store,
            checkpointStore: checkpoints,
            decision: {
              ...decision,
              transportUserId: options.authorizedUserId,
              sessionKey: existing.sessionKey,
            },
            ownerId,
            currentSessionRevision: readSessionTransaction(existing.sessionPath, lease).revision,
            resolveTool: resolveToolDefinition,
            liveGuard: async () => ({ ok: true }),
            liveRisk: async () => ({ ok: true }),
            execute: (name, args) => executeApprovedTelegramTool(
              name,
              args,
              (toolName, toolArgs) => execTool(toolName, toolArgs as Record<string, string>, options.toolContext as ToolContext),
            ),
          }))
      } else if (["succeeded", "failed", "attempted_indeterminate", "denied", "expired", "drifted", "session_head_changed", "abandoned_before_attempt"].includes(existing.state)) {
        record = existing
      } else {
        return { accepted: false, terminalText: "⚠️ Approval is not recoverable" }
      }
      return continueTerminalRecord(record)
    },
  })

  const recover = async (): Promise<void> => {
    for (const pending of transport.listPendingDeliveries()) {
      if (pending.terminal) {
        await transport.terminalizeRecovered(pending.approvalId, pending.terminal.terminalText)
        continue
      }
      const existing = store.read(pending.approvalId)
      if (!existing) continue
      const deliveryState = pending.deliveryState ?? "bound"
      if (existing.state === "awaiting_prompt_binding" && deliveryState !== "bound") {
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
        store.bindPrompt({
          approvalId: existing.approvalId,
          transport: "telegram",
          transportChatId: options.authorizedChatId,
          transportMessageId: pending.messageId,
        })
        continue
      }
      if (existing.state === "proposed" || existing.state === "preparing" || existing.state === "awaiting_prompt_binding") continue
      let record = existing
      if (record.state === "claimed") {
        record = recoverClaimedApproval({ approvalStore: store, approvalId: record.approvalId, reason: "decision interrupted before action attempt; action was not executed" })
      } else if (record.state === "attempted") {
        record = recoverAttemptedApproval({ approvalStore: store, approvalId: record.approvalId })
      }
      const outcome = await continueTerminalRecord(record)
      await transport.terminalizeRecovered(record.approvalId, outcome.terminalText)
    }
  }

  return { transport, coordinator, recover, close: () => store.close() }
}
