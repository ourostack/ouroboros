import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"

import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "../heart/approval-files"
import { openApprovalStore } from "../heart/approval-store"
import { ApprovalExecutionFailedError, commitApprovalProposal, executeApprovalDecision } from "../heart/tool-approval"
import { resumeApprovalContinuation, runAgent, type ApprovalCoordinator, type RunAgentOptions } from "../heart/core"
import { getAgentRoot } from "../heart/identity"
import { saveSession } from "../mind/context"
import { readSessionTransaction, withSessionTurnLease } from "../mind/session-transaction"
import { execTool, resolveToolDefinition } from "../repertoire/tools"
import type { ToolContext } from "../repertoire/tools-base"
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
  return result
}

export function createTelegramApprovalRuntime(options: {
  agentName: string
  api: TelegramBotApi
  authorizedUserId: string
  authorizedChatId: string
  toolContext: Partial<ToolContext>
}): TelegramApprovalRuntime {
  const stateRoot = path.join(getAgentRoot(options.agentName), "state", "approvals")
  const store = openApprovalStore({ databasePath: path.join(stateRoot, "approvals.sqlite") })
  const checkpoints = new FileApprovalCheckpointStore(path.join(stateRoot, "checkpoints.json"))
  const tokens = new FileApprovalTokenStore(path.join(stateRoot, "tokens.json"))
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

  transport = createTelegramApprovalTransport({
    api: options.api,
    expectedUserId: options.authorizedUserId,
    expectedChatId: options.authorizedChatId,
    pendingStore: new FileTelegramPendingApprovalStore(path.join(stateRoot, "telegram-pending.json")),
    createOpaqueHandle: () => randomBytes(12).toString("base64url"),
    resolveDecisionToken: async (approvalId) => tokens.get(approvalId) ?? "",
    onDecision: async (decision) => {
      const existing = store.read(decision.approvalId)
      if (!existing) return { accepted: false, terminalText: "⚠️ Approval is no longer valid" }
      const ownerId = `telegram-decision-${randomUUID()}`
      return withSessionTurnLease(existing.sessionPath, async (lease) => {
        const currentRevision = readSessionTransaction(existing.sessionPath, lease).revision
        const record = await executeApprovalDecision({
          approvalStore: store,
          checkpointStore: checkpoints,
          decision: {
            ...decision,
            transportUserId: options.authorizedUserId,
            sessionKey: existing.sessionKey,
          },
          ownerId,
          currentSessionRevision: currentRevision,
          resolveTool: resolveToolDefinition,
          liveGuard: async () => ({ ok: true }),
          liveRisk: async () => ({ ok: true }),
          execute: (name, args) => executeApprovedTelegramTool(
            name,
            args,
            (toolName, toolArgs) => execTool(toolName, toolArgs as Record<string, string>, options.toolContext as ToolContext),
          ),
        })
        const checkpoint = checkpoints.read(record.approvalId)
        if (!checkpoint) return { accepted: false, terminalText: "⚠️ Approval checkpoint is unavailable" }
        let continuationOwnerId = `telegram-continuation-${randomUUID()}`
        let continuationEpoch = 0
        const continuationCoordinator: ApprovalCoordinator = {
          propose: (request) => coordinator({
            sessionPath: existing.sessionPath,
            baseSessionRevision: readSessionTransaction(existing.sessionPath, lease).revision,
          }).propose(request),
        }
        await resumeApprovalContinuation({
          record,
          checkpoint,
          currentSessionRevision: readSessionTransaction(existing.sessionPath, lease).revision,
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
          persist: (messages, result) => saveSession(existing.sessionPath, messages, result?.usage, undefined, lease),
          deliver: async (text) => { await sendTelegramText(options.api, options.authorizedChatId, text) },
        })
        tokens.remove(record.approvalId)
        const accepted = record.state === "succeeded"
        return { accepted, terminalText: accepted ? "✅ Approved — action completed" : record.state === "denied" ? "❌ Denied — no action taken" : "⚠️ Approval did not complete" }
      })
    },
  })

  return { transport, coordinator, close: () => store.close() }
}
