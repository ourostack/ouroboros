import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { channelToFacing, getChannelCapabilities } from "@ouro.bot/friends"

import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "./approval-files"
import { openApprovalStore, type ApprovalStore } from "./approval-store"
import {
  commitApprovalProposal,
  executeApprovalDecision,
  type ApprovalSuspensionCheckpointStore,
  type ApprovalTokenStore,
} from "./tool-approval"
import {
  resumeApprovalContinuation,
  getProviderRuntime,
  runAgent,
  type ApprovalProposalRequest,
  type ChannelCallbacks,
  type RunAgentOptions,
} from "./core"
import { getAgentRoot, setAgentName } from "./identity"
import type {
  FrontendAuthorityRuntime,
  FrontendPermissionRequest,
  FrontendSessionRef,
  FrontendTurnRequest,
} from "./frontend-session-service"
import type { FrontendJournalEventType } from "./frontend-journal"
import type { FrontendTurnEventSink, RunSenseTurnResult } from "../senses/shared-turn"
import { withTurnExecutionLease } from "./turn-execution-lease"
import { loadSession, postTurnPersist, postTurnTrim } from "../mind/context"
import { readSessionTransaction, withSessionTurnLease } from "../mind/session-transaction"
import { approvalPolicyForInvocation, executeTool, preflightToolCall, resolveToolDefinition, selectToolsForChannel } from "../repertoire/tools"
import type { ToolContext, ToolDefinition } from "../repertoire/tools-base"
import { getSharedMcpManager, type McpOwner } from "../repertoire/mcp-manager"
import { emitNervesEvent } from "../nerves/runtime"

type PermissionOptionId = "allow-once" | "reject-once" | "cancelled" | "expired"

interface ApprovalState {
  approvalStore: ApprovalStore
  checkpointStore: ApprovalSuspensionCheckpointStore
  tokenStore: ApprovalTokenStore
}

interface PendingApproval {
  requestId: string
  toolCallId: string
  title: string
  request: FrontendTurnRequest
  approvalRequest: ApprovalProposalRequest
  expiresAt: number
  publish(type: string, data: Record<string, unknown>, journalType?: FrontendJournalEventType): void
  decision: Promise<PermissionOptionId>
  resolve(optionId: PermissionOptionId): void
  settled: boolean
}

export interface SettleFrontendApprovalInput {
  request: FrontendTurnRequest
  approvalRequest: ApprovalProposalRequest
  suspension: NonNullable<RunSenseTurnResult["suspension"]>
  optionId: PermissionOptionId
  signal: AbortSignal
  frontendEventSink: FrontendTurnEventSink
  publish(type: string, data: Record<string, unknown>, journalType?: FrontendJournalEventType): void
  agentRoot: string
  approvalStore: ApprovalStore
  checkpointStore: ApprovalSuspensionCheckpointStore
  tokenStore: ApprovalTokenStore
  approvalCoordinatorFactory: FrontendAuthorityRuntime["approvalCoordinatorFactory"]
}

export type SettleFrontendApproval = (input: SettleFrontendApprovalInput) => Promise<RunSenseTurnResult>

export interface SettleFrontendApprovalDependencies {
  withTurnExecutionLease: typeof withTurnExecutionLease
  setAgentName: typeof setAgentName
  withSessionTurnLease: typeof withSessionTurnLease
  readSessionTransaction: typeof readSessionTransaction
  executeApprovalDecision: typeof executeApprovalDecision
  resolveToolDefinition: typeof resolveToolDefinition
  approvalPolicyForInvocation: typeof approvalPolicyForInvocation
  executeTool: typeof executeTool
  preflightToolCall: typeof preflightToolCall
  selectToolsForChannel: typeof selectToolsForChannel
  getProviderRuntime: typeof getProviderRuntime
  getSharedMcpManager: typeof getSharedMcpManager
  releaseRuntimeMcpServers: (owner: McpOwner) => Promise<void>
  loadSession: typeof loadSession
  postTurnTrim: typeof postTurnTrim
  postTurnPersist: typeof postTurnPersist
  resumeApprovalContinuation: typeof resumeApprovalContinuation
  runAgent: typeof runAgent
  randomUUID: typeof randomUUID
}

export interface FrontendApprovalRuntime extends FrontendAuthorityRuntime {
  close(): void
}

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
] as const

async function defaultReleaseRuntimeMcpServers(owner: McpOwner): Promise<void> {
  const manager = await import("../repertoire/mcp-manager")
  await manager.releaseRuntimeMcpServers(owner)
}

const DEFAULT_SETTLEMENT_DEPENDENCIES: SettleFrontendApprovalDependencies = {
  withTurnExecutionLease,
  setAgentName,
  withSessionTurnLease,
  readSessionTransaction,
  executeApprovalDecision,
  resolveToolDefinition,
  approvalPolicyForInvocation,
  executeTool,
  preflightToolCall,
  selectToolsForChannel,
  getProviderRuntime,
  getSharedMcpManager,
  releaseRuntimeMcpServers: defaultReleaseRuntimeMcpServers,
  loadSession,
  postTurnTrim,
  postTurnPersist,
  resumeApprovalContinuation,
  runAgent,
  randomUUID,
}

export async function settleFrontendApproval(
  input: SettleFrontendApprovalInput,
  dependencies: SettleFrontendApprovalDependencies = DEFAULT_SETTLEMENT_DEPENDENCIES,
): Promise<RunSenseTurnResult> {
  const token = input.tokenStore.get(input.suspension.approvalId)
  if (!token) throw new Error(`frontend approval decision token is unavailable: ${input.suspension.approvalId}`)
  const checkpoint = input.checkpointStore.read(input.suspension.approvalId)
  if (!checkpoint) throw new Error(`frontend approval checkpoint is unavailable: ${input.suspension.approvalId}`)
  const record = input.approvalStore.read(input.suspension.approvalId)
  if (!record) throw new Error(`frontend approval record is unavailable: ${input.suspension.approvalId}`)

  const owner = Object.freeze({ agentName: input.request.agent, agentRoot: input.agentRoot })
  const toolsDisabled = input.request.disableTools === true
  const runtimeServers = input.request.runtimeMcpServers
  return dependencies.withTurnExecutionLease(async () => {
    dependencies.setAgentName(owner.agentName)
    try {
      return await dependencies.withSessionTurnLease(record.sessionPath, async (lease) => {
      const currentRevision = dependencies.readSessionTransaction(record.sessionPath, lease).revision
      const continuationSignal = input.optionId === "cancelled" ? AbortSignal.abort() : input.signal
      const liveToolContext = input.approvalRequest.liveToolContext ?? {
        signin: async () => undefined,
        agentName: owner.agentName,
        agentRoot: input.agentRoot,
        currentSession: {
          friendId: input.request.friendId,
          channel: input.request.channel,
          key: input.request.sessionKey,
          sessionPath: record.sessionPath,
        },
        currentUserMessage: input.request.message,
      }
      const currentOptions = async (): Promise<(RunAgentOptions & { toolContext: ToolContext }) | null> => {
        try {
          if ((liveToolContext.agentName !== undefined && liveToolContext.agentName !== owner.agentName)
            || (liveToolContext.agentRoot !== undefined && liveToolContext.agentRoot !== owner.agentRoot)) {
            throw new Error("approval context owner coordinates changed")
          }
          let context: ToolContext = { ...liveToolContext, ...owner }
          const original = liveToolContext.relationshipAuthorization
          if (original) {
            if (liveToolContext.agentName !== owner.agentName || liveToolContext.agentRoot !== owner.agentRoot) {
              throw new Error("approval context owner coordinates changed")
            }
            const current = await original.resolveCurrent?.()
            if (!current?.actor || current.actor.friendId !== input.request.friendId
              || current.actor.trustLevel !== original.actor?.trustLevel || current.profileId !== original.profileId
              || original.authorizedContextScopes.some((scope) => !current.authorizedContextScopes.includes(scope))) {
              throw new Error("current approval relationship authority is unavailable")
            }
            context = { ...context, relationshipAuthorization: current }
          }
          const providerRuntime = await dependencies.getProviderRuntime(channelToFacing(input.request.channel), owner)
          const mcpManager = toolsDisabled ? undefined : await dependencies.getSharedMcpManager({ ...owner, runtimeServers }) ?? undefined
          const selectCurrentTools = () => toolsDisabled
            ? Object.freeze({ ordinary: Object.freeze([]), engine: Object.freeze([]) })
            : dependencies.selectToolsForChannel(
              getChannelCapabilities(input.request.channel), context.context?.friend.toolPreferences, context.context,
              providerRuntime.capabilities, mcpManager, providerRuntime.model, context,
            )
          return {
            providerRuntimeOverride: providerRuntime, mcpManager,
            ...(toolsDisabled ? { tools: [], hardDisableTools: true } : {}),
            toolContext: { ...context, toolSelection: selectCurrentTools(), selectCurrentTools },
          }
        } catch (error) {
          emitNervesEvent({
            level: "warn", component: "heart", event: "heart.frontend_approval_authority_unavailable",
            message: "current approval authority could not be reconstructed; execution remains disabled",
            meta: { approvalId: record.approvalId, category: error instanceof Error ? error.name : "unknown" },
          })
          return null
        }
      }
      let definition: ToolDefinition | undefined
      const terminal = await dependencies.executeApprovalDecision({
        approvalStore: input.approvalStore,
        checkpointStore: input.checkpointStore,
        decision: {
          approvalId: record.approvalId,
          decisionToken: token,
          decision: input.optionId === "allow-once" ? "approve" : "deny",
          requesterId: input.request.friendId,
          transport: "frontend",
          transportUserId: input.request.friendId,
          transportChatId: input.request.sessionKey,
          transportMessageId: record.approvalId,
          sessionKey: input.request.sessionKey,
          ...(input.optionId === "expired" ? { decisionAt: Date.parse(record.expiresAt) } : {}),
        },
        ownerId: `frontend-decision-${dependencies.randomUUID()}`,
        currentSessionRevision: currentRevision,
        resolveTool: async (name) => {
          const current = await currentOptions()
          definition = current ? dependencies.resolveToolDefinition(name, current.toolContext.toolSelection) : undefined
          return definition
        },
        resolveApprovalPolicy: async (name, args) => {
          const current = await currentOptions()
          return current ? dependencies.approvalPolicyForInvocation(name, args, current.toolContext) : { kind: "not_required" }
        },
        liveGuard: async () => ({ ok: true }),
        liveRisk: async () => ({ ok: true }),
        preflight: async (context) => {
          const current = await currentOptions()
          if (!current) return { ok: false, reason: "current tool authority is unavailable" }
          const result = await dependencies.preflightToolCall(context.record.toolName, context.arguments as Record<string, string>, {
            ...current.toolContext,
            toolSelection: Object.freeze({ ordinary: Object.freeze([context.definition]), engine: Object.freeze([]) }),
          })
          return result.kind === "ready" ? { ok: true } : { ok: false, reason: result.text }
        },
        execute: async (name, args) => {
          const current = await currentOptions()
          if (!current || !definition) return { kind: "rejected_before_handler", text: "current approved tool authority is unavailable" }
          return dependencies.executeTool(name, args as Record<string, string>, {
            ...current.toolContext,
            toolSelection: Object.freeze({ ordinary: Object.freeze([definition]), engine: Object.freeze([]) }),
          })
        },
      })
      input.tokenStore.remove(record.approvalId)

      const existing = dependencies.loadSession(record.sessionPath)
      const existingStructuredOutputIds = new Set(existing?.structuredOutputs.map((output) => output.id) ?? [])
      const deliveries: Array<{ kind: "text"; text: string }> = []
      let response = ""
      const emit = input.frontendEventSink.onEvent
      const callbacks: ChannelCallbacks = {
        settleOutputMode: "retractable_buffer",
        onModelStart: () => emit({ type: "model_started", data: {} }),
        onModelStreamStart: () => emit({ type: "model_stream_started", data: {} }),
        onTextChunk: (text) => {
          response += text
          emit({ type: "text_delta", data: { text } })
        },
        onReasoningChunk: (text) => emit({ type: "reasoning_delta", data: { text } }),
        onToolStart: (name, args) => emit({ type: "tool_started", data: { name, args } }),
        onToolEnd: (name, summary, success) => emit({ type: "tool_completed", data: { name, summary, success } }),
        onError: (error, severity) => emit({ type: "error", data: { message: error.message, severity } }),
        onClearText: () => {
          response = ""
          emit({ type: "text_cleared", data: {} })
        },
      }
      let continuationEpoch = 0
      const continuationOwnerId = `frontend-continuation-${dependencies.randomUUID()}`
      const nestedCoordinator = {
        propose: (request: ApprovalProposalRequest) => input.approvalCoordinatorFactory({
          request: input.request,
          publish: input.publish,
        })({
          sessionPath: record.sessionPath,
          baseSessionRevision: dependencies.readSessionTransaction(record.sessionPath, lease).revision,
        }).propose(request),
      }
      const persist: Parameters<typeof resumeApprovalContinuation>[0]["persist"] = (messages, result) => {
        const expectedRevision = dependencies.readSessionTransaction(record.sessionPath, lease).revision
        const prepared = dependencies.postTurnTrim(messages, result?.usage)
        dependencies.postTurnPersist(record.sessionPath, prepared, result?.usage, existing?.state, lease, expectedRevision)
      }
      const continuation = await dependencies.resumeApprovalContinuation({
        record: terminal,
        checkpoint,
        currentSessionRevision: dependencies.readSessionTransaction(record.sessionPath, lease).revision,
        sessionMessages: checkpoint.preCallMessages,
        callbacks,
        channel: input.request.channel,
        claimContinuation: () => {
          const claim = input.approvalStore.claimContinuation({
            approvalId: record.approvalId,
            ownerId: continuationOwnerId,
          })
          continuationEpoch = claim.record.continuationEpoch
          return claim
        },
        markContinuationMaterialized: () => {
          input.approvalStore.markContinuationMaterialized({
            approvalId: record.approvalId,
            ownerId: continuationOwnerId,
            epoch: continuationEpoch,
          })
        },
        markContinuationAttempted: () => {
          input.approvalStore.markContinuationAttempted({
            approvalId: record.approvalId,
            ownerId: continuationOwnerId,
            epoch: continuationEpoch,
          })
        },
        completeContinuation: () => {
          input.approvalStore.completeContinuation({
            approvalId: record.approvalId,
            ownerId: continuationOwnerId,
            epoch: continuationEpoch,
          })
        },
        runAgent: dependencies.runAgent,
        runAgentOptions: {
          toolContext: liveToolContext,
          approvalCoordinator: nestedCoordinator,
        },
        revalidate: async () => {
          const current = await currentOptions()
          return current ? { ...current, approvalCoordinator: nestedCoordinator } : null
        },
        persist,
        deliver: async (text) => {
          response = text
          deliveries.push({ kind: "text", text })
          emit({ type: "assistant_delivery", data: { kind: "text", text } })
        },
        signal: continuationSignal,
      })
      const persisted = dependencies.loadSession(record.sessionPath)
      for (const output of persisted?.structuredOutputs ?? []) {
        if (!existingStructuredOutputIds.has(output.id)) {
          emit({ type: "structured_output", data: { output } })
        }
      }
      const turnOutcome = continuation.outcome === "terminal_notice"
        ? "settled"
        : continuation.outcome === "already_continued"
          ? "superseded"
          : continuation.outcome
      if (turnOutcome === "suspended" && !continuation.suspension) {
        throw new Error("frontend approval continuation omitted its nested suspension")
      }
      return {
        response,
        ponderDeferred: false,
        deliveries,
        deliveryFailures: [],
        sessionPath: record.sessionPath,
        turnOutcome,
        ...(continuation.suspension ? { suspension: continuation.suspension } : {}),
      }
      })
    } finally {
      if (runtimeServers && !toolsDisabled) {
        await dependencies.releaseRuntimeMcpServers(owner)
      }
    }
  })
}

export function createFrontendApprovalRuntime(options: {
  settleApproval?: SettleFrontendApproval
  agentRoot?: (agent: string) => string
  now?: () => number
  approvalTimeoutMs?: number
}): FrontendApprovalRuntime {
  const agentRoot = options.agentRoot ?? getAgentRoot
  const now = options.now ?? Date.now
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000
  const settleApproval = options.settleApproval ?? settleFrontendApproval
  if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 1) {
    throw new Error("approvalTimeoutMs must be a positive integer")
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.frontend_approval_runtime_ready",
    message: "frontend approval runtime ready",
  })
  const states = new Map<string, ApprovalState>()
  const pending = new Map<string, PendingApproval>()
  let closed = false

  function closeStatesWhenIdle(): void {
    if (!closed || pending.size > 0) return
    for (const state of states.values()) state.approvalStore.close()
    states.clear()
  }

  function stateFor(agent: string): ApprovalState {
    let state = states.get(agent)
    if (state) return state
    const stateRoot = path.join(agentRoot(agent), "state", "approvals")
    state = {
      approvalStore: openApprovalStore({ databasePath: path.join(stateRoot, "approvals.sqlite") }),
      checkpointStore: new FileApprovalCheckpointStore(path.join(stateRoot, "checkpoints.json")),
      tokenStore: new FileApprovalTokenStore(path.join(stateRoot, "tokens.json")),
    }
    states.set(agent, state)
    return state
  }

  function settlePending(item: PendingApproval, optionId: PermissionOptionId): boolean {
    if (item.settled) return false
    item.settled = true
    item.resolve(optionId)
    item.publish("permission_resolved", { requestId: item.requestId, optionId }, "permission_resolved")
    return true
  }

  const runtime: FrontendApprovalRuntime = {
    approvalCoordinatorFactory(input) {
      return (context) => ({
        propose: async (request) => {
          if (closed) throw new Error("frontend approval runtime is closed")
          if (request.toolCall.type !== "function") throw new Error("frontend approval requires a function tool call")
          const state = stateFor(input.request.agent)
          const committed = commitApprovalProposal({
            approvalStore: state.approvalStore,
            checkpointStore: state.checkpointStore,
            tokenStore: state.tokenStore,
            proposal: {
              toolCallId: request.toolCall.id,
              toolName: request.toolCall.function.name,
              arguments: request.arguments,
              schemaDigest: request.schemaDigest,
              toolDigest: request.toolDigest,
              policyDigest: request.policyDigest,
              policyId: request.policyId,
              sessionKey: input.request.sessionKey,
              sessionPath: context.sessionPath,
              baseSessionRevision: context.baseSessionRevision,
              checkpointDigest: "0".repeat(64),
              requesterId: input.request.friendId,
              transport: "frontend",
              transportUserId: input.request.friendId,
              transportChatId: input.request.sessionKey,
              expiresAt: new Date(now() + approvalTimeoutMs).toISOString(),
              frozenAssistantMessage: request.frozenAssistantMessage as never,
            },
            preCallMessages: request.preCallMessages,
          })
          const decision = Promise.withResolvers<PermissionOptionId>()
          state.approvalStore.bindPrompt({
            approvalId: committed.record.approvalId,
            transport: "frontend",
            transportChatId: input.request.sessionKey,
            transportMessageId: committed.record.approvalId,
          })
          const item: PendingApproval = {
            requestId: committed.record.approvalId,
            toolCallId: request.toolCall.id,
            title: `Approve ${request.toolCall.function.name}`,
            request: input.request,
            approvalRequest: request,
            expiresAt: Date.parse(committed.record.expiresAt),
            publish: input.publish,
            decision: decision.promise,
            resolve: decision.resolve,
            settled: false,
          }
          pending.set(committed.record.approvalId, item)
          input.publish("permission_requested", {
            requestId: committed.record.approvalId,
            toolCallId: request.toolCall.id,
            title: `Approve ${request.toolCall.function.name}`,
            options: PERMISSION_OPTIONS,
          }, "permission_requested")
          return {
            approvalId: committed.record.approvalId,
            checkpointDigest: committed.record.checkpointDigest,
            suspendedSessionRevision: committed.record.suspendedSessionRevision!,
          }
        },
      })
    },

    async resumeApproval(input) {
      const item = pending.get(input.suspension.approvalId)
      if (!item || item.request.turnId !== input.request.turnId) {
        throw new Error(`frontend approval ${input.suspension.approvalId} does not own turn ${input.request.turnId}`)
      }
      const abort = () => settlePending(item, "cancelled")
      if (input.signal.aborted) abort()
      else input.signal.addEventListener("abort", abort, { once: true })
      const timeout = setTimeout(() => settlePending(item, "expired"), Math.max(0, item.expiresAt - now()))
      try {
        const optionId = await item.decision
        const state = stateFor(input.request.agent)
        return await settleApproval({
          ...input,
          approvalRequest: item.approvalRequest,
          optionId,
          publish: item.publish,
          agentRoot: agentRoot(input.request.agent),
          ...state,
          approvalCoordinatorFactory: runtime.approvalCoordinatorFactory,
        })
      } finally {
        clearTimeout(timeout)
        input.signal.removeEventListener("abort", abort)
        pending.delete(input.suspension.approvalId)
        closeStatesWhenIdle()
      }
    },

    resolvePermission(requestId, optionId) {
      if (closed || (optionId !== "allow-once" && optionId !== "reject-once" && optionId !== "cancelled")) return false
      const item = pending.get(requestId)
      return item ? settlePending(item, optionId) : false
    },

    cancelTurn(turnId) {
      for (const item of pending.values()) {
        if (item.request.turnId === turnId) settlePending(item, "cancelled")
      }
    },

    pendingPermissions(ref: FrontendSessionRef): FrontendPermissionRequest[] {
      return [...pending.values()].flatMap((item) => {
        if (
          item.settled
          || item.request.agent !== ref.agent
          || item.request.friendId !== ref.friendId
          || item.request.sessionKey !== ref.sessionKey
        ) return []
        return [{
          requestId: item.requestId,
          turnId: item.request.turnId,
          toolCallId: item.toolCallId,
          title: item.title,
          options: [...PERMISSION_OPTIONS],
        }]
      })
    },

    close() {
      if (closed) return
      for (const item of pending.values()) settlePending(item, "cancelled")
      closed = true
      closeStatesWhenIdle()
    },
  }

  return runtime
}
