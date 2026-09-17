import * as path from "node:path"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type OpenAI from "openai"
import type { JsonValue } from "../heart/approval-store"
import { getChannelCapabilities } from "@ouro.bot/friends"
import { getProviderRuntime, resumeApprovalContinuation, runAgent, type ApprovalCoordinator, type RunAgentOptions, type ResumeApprovalContinuationOptions } from "../heart/core"
import { digestApprovalSuspensionCheckpointPayload, digestApprovalToolDefinition, type ApprovalSuspensionCheckpoint } from "../heart/tool-approval"
import { loadSession, saveSession } from "../mind/context"
import { readSessionTransaction, withImmediateSessionTurnLease, withSessionTurnLease, writeSessionTransaction } from "../mind/session-transaction"
import { emitNervesEvent } from "../nerves/runtime"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { digestJson } from "../repertoire/tool-arguments"
import { preflightToolCall, selectToolsForChannel } from "../repertoire/tools"
import type { ToolContext, ToolDefinition } from "../repertoire/tools-base"
import { authorizeRootHostContext, RootHostAuthorizationError, validateRootHostToolArguments, type RootHostBinding } from "../repertoire/tools-sanctuary-host"
import type { RootHostApprovalPort, RootHostCorrelation, RootHostRegistration, RootHostStatus } from "./root-host-approval-port"
import type { TelegramUpdate } from "./telegram-client"
import { getSenseSessionPath } from "./shared-turn"

export interface RootHostPendingApprovalV1 {
  schemaVersion: 1
  approvalId: string
  registration: RootHostRegistration
  binding: RootHostBinding
  checkpoint: ApprovalSuspensionCheckpoint
  executionRequested: boolean
  continuationState: "pending" | "materialized" | "attempted" | "complete"
  materializedSessionRevision: string | null
  rootStatusDigest: string | null
  reconciliationRequired: boolean
}

class RootHostPendingApprovalError extends Error {}
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new RootHostPendingApprovalError("Root host pending approval is invalid")
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value))
  requireValid(isDeepStrictEqual(Object.keys(value).sort(), keys.sort()))
}
function validate(value: unknown): asserts value is RootHostPendingApprovalV1 {
  exact(value, ["schemaVersion", "approvalId", "registration", "binding", "checkpoint", "executionRequested", "continuationState", "materializedSessionRevision", "rootStatusDigest", "reconciliationRequired"])
  requireValid(value.schemaVersion === 1 && typeof value.approvalId === "string" && /^root-host-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.approvalId))
  requireValid(typeof value.executionRequested === "boolean" && typeof value.reconciliationRequired === "boolean"
    && typeof value.continuationState === "string" && ["pending", "materialized", "attempted", "complete"].includes(value.continuationState))
  requireValid(value.rootStatusDigest === null || (typeof value.rootStatusDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.rootStatusDigest)))
  requireValid(value.materializedSessionRevision === null || (typeof value.materializedSessionRevision === "string" && /^[a-f0-9]{64}$/u.test(value.materializedSessionRevision)))
  requireValid((value.continuationState !== "materialized" && value.continuationState !== "attempted") || value.materializedSessionRevision !== null)
  requireValid(value.continuationState !== "pending" || value.materializedSessionRevision === null)
  exact(value.registration, ["registration", "registrationId", "telegramMessageId", "expiresAt"])
  requireValid(typeof value.registration.registrationId === "string" && /^hostreg-[A-Za-z0-9_-]{43}$/u.test(value.registration.registrationId)
    && Number.isSafeInteger(value.registration.telegramMessageId) && (value.registration.telegramMessageId as number) > 0
    && typeof value.registration.expiresAt === "string" && Number.isFinite(Date.parse(value.registration.expiresAt)))
  exact(value.registration.registration, ["schemaVersion", "domain", "keyId", "payload", "signature"])
  const artifact = value.registration.registration
  requireValid(artifact.schemaVersion === 1 && artifact.domain === "ouro.sanctuary.host-registration.v1"
    && typeof artifact.keyId === "string" && artifact.keyId.length > 0 && typeof artifact.signature === "string" && artifact.signature.length > 0
    && artifact.payload !== null && typeof artifact.payload === "object" && !Array.isArray(artifact.payload))
  exact(value.binding, ["agentRoot", "friendId", "requestId", "sessionKey", "sessionPath", "sessionEventId", "profileId", "profileVersion", "keyId", "publicKeyDigest", "targetHost"])
  const binding = value.binding
  requireValid(binding.profileId === "sanctuary-owner" && Number.isSafeInteger(binding.profileVersion) && (binding.profileVersion as number) >= 9)
  requireValid(Object.entries(binding).every(([key, item]) => key === "profileVersion" || (typeof item === "string" && item.length > 0 && item.length <= 4096)))
  requireValid(/^sha256:[a-f0-9]{64}$/u.test(binding.publicKeyDigest as string))
  validateCheckpoint(value.checkpoint, value.approvalId as string, binding.targetHost as string)
}
function validateCheckpoint(value: unknown, approvalId: string, targetHost: string): asserts value is ApprovalSuspensionCheckpoint {
  exact(value, ["approvalId", "checkpointDigest", "baseSessionRevision", "suspendedSessionRevision", "argumentDigest", "schemaDigest", "toolDigest", "policyDigest", "preCallDigest", "preCallMessages", "frozenAssistantMessage"])
  const c = value as unknown as ApprovalSuspensionCheckpoint
  requireValid(c.approvalId === approvalId && Array.isArray(c.preCallMessages))
  requireValid(c.preCallMessages.every((message) => message !== null && typeof message === "object"
    && ["system", "developer", "user", "assistant", "tool", "function"].includes(message.role)))
  requireValid(["checkpointDigest", "baseSessionRevision", "suspendedSessionRevision", "argumentDigest", "schemaDigest", "toolDigest", "policyDigest", "preCallDigest"]
    .every((key) => typeof c[key as keyof ApprovalSuspensionCheckpoint] === "string" && /^[a-f0-9]{64}$/u.test(String(c[key as keyof ApprovalSuspensionCheckpoint]))))
  requireValid(c.preCallDigest === digestJson(c.preCallMessages as unknown as JsonValue) && c.checkpointDigest === digestApprovalSuspensionCheckpointPayload(c))
  requireValid(c.suspendedSessionRevision === c.baseSessionRevision)
  requireValid(c.frozenAssistantMessage !== null && typeof c.frozenAssistantMessage === "object" && !Array.isArray(c.frozenAssistantMessage))
  const calls = c.frozenAssistantMessage.tool_calls
  requireValid(Array.isArray(calls) && calls.length === 1)
  exact(calls[0], ["id", "type", "function"])
  requireValid(c.frozenAssistantMessage.role === "assistant" && calls[0].type === "function" && typeof calls[0].id === "string" && calls[0].id.length > 0)
  exact(calls[0].function, ["name", "arguments"])
  requireValid(calls[0].function.name === "sanctuary_host_execute" && typeof calls[0].function.arguments === "string")
  const args = JSON.parse(calls[0].function.arguments)
  requireValid(digestJson(args) === c.argumentDigest)
  validateRootHostToolArguments(args, targetHost)
}

function checkDefinition(checkpoint: ApprovalSuspensionCheckpoint, definition: ToolDefinition) {
  const args = JSON.parse((checkpoint.frozenAssistantMessage.tool_calls as unknown as OpenAI.ChatCompletionMessageFunctionToolCall[])[0]!.function.arguments)
  const policy = definition.approvalPolicy?.(args)
  requireValid(policy?.kind === "required")
  requireValid(checkpoint.schemaDigest === digestJson(definition.tool.function.parameters as JsonValue))
  requireValid(checkpoint.toolDigest === digestApprovalToolDefinition(definition, checkpoint.schemaDigest, policy.policyId))
  requireValid(checkpoint.policyDigest === digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" }))
  return policy
}

export function classifyRootHostPendingApproval(value: unknown): "pending" | "executing" | "reconciliation_required" | "materialized" | "attempted" | "complete" {
  validate(value)
  if (value.continuationState !== "pending") return value.continuationState
  if (value.reconciliationRequired) return "reconciliation_required"
  return value.executionRequested ? "executing" : "pending"
}

export class FileRootHostPendingApprovalStore {
  readonly filePath: string
  constructor(agentRoot: string) { this.filePath = path.join(agentRoot, "state", "root-host-approvals", "v1", "pending.json") }
  list(): RootHostPendingApprovalV1[] {
    return withImmediateSessionTurnLease(this.filePath, (lease) => {
      const transaction = readSessionTransaction(this.filePath, lease)
      if (!transaction.bytes) {
        requireValid(!existsSync(this.filePath))
        return []
      }
      exact(transaction.value, ["schemaVersion", "records"])
      requireValid(transaction.value.schemaVersion === 1 && Array.isArray(transaction.value.records))
      const records = transaction.value.records
      records.forEach(validate)
      requireValid(new Set(records.map((record) => record.approvalId)).size === records.length
        && new Set(records.map((record) => record.registration.registrationId)).size === records.length
        && new Set(records.map((record) => record.registration.telegramMessageId)).size === records.length)
      return structuredClone(records)
    })
  }
  put(record: RootHostPendingApprovalV1): void {
    validate(record)
    withImmediateSessionTurnLease(this.filePath, (lease) => {
      const revision = readSessionTransaction(this.filePath, lease).revision
      const records = this.list()
      const previous = records.find((item) => item.approvalId === record.approvalId)
      if (previous) {
        requireValid(isDeepStrictEqual(previous.binding, record.binding) && isDeepStrictEqual(previous.registration, record.registration)
          && isDeepStrictEqual(previous.checkpoint, record.checkpoint))
        const phases = ["pending", "materialized", "attempted", "complete"]
        requireValid(phases.indexOf(record.continuationState) >= phases.indexOf(previous.continuationState)
          && (!previous.executionRequested || record.executionRequested)
          && (previous.materializedSessionRevision === null || previous.materializedSessionRevision === record.materializedSessionRevision))
        Object.assign(previous, structuredClone(record))
      } else {
        requireValid(!records.some((item) => item.registration.registrationId === record.registration.registrationId
          || item.registration.telegramMessageId === record.registration.telegramMessageId))
        records.push(structuredClone(record))
      }
      writeSessionTransaction(this.filePath, { schemaVersion: 1, records }, { lease, expectedRevision: revision })
      emitNervesEvent({ component: "senses", event: "senses.root_host_pending_saved", message: "root host continuation checkpoint saved", meta: { approvalId: record.approvalId, state: classifyRootHostPendingApproval(record) } })
    })
  }
}

type Terminal = ResumeApprovalContinuationOptions["record"]
function terminalProjection(record: RootHostPendingApprovalV1, status: RootHostStatus): Terminal | null {
  const call = (record.checkpoint.frozenAssistantMessage.tool_calls as unknown as OpenAI.ChatCompletionMessageToolCall[])[0]!
  const common = { approvalId: record.approvalId, toolCallId: call.id }
  if (status.state === "denied" || status.state === "expired") return { ...common, state: status.state, result: null }
  if (status.state !== "executed") return null
  requireValid(status.receipt && status.permit)
  const state = status.receipt.payload.state
  requireValid(state === "verified" || state === "failed" || state === "ambiguous")
  requireValid(status.receipt.payload.cleanup === "cgroup_empty")
  return { ...common, state: state === "verified" ? "succeeded" : state === "failed" ? "failed" : "attempted_indeterminate", result: JSON.stringify(status.receipt) }
}
function correlation(record: RootHostPendingApprovalV1): RootHostCorrelation {
  const b = record.binding
  return {
    registrationId: record.registration.registrationId, residentFriendId: b.friendId,
    relationshipProfileId: b.profileId, relationshipProfileVersion: b.profileVersion, requestId: b.requestId,
    sessionKey: b.sessionKey, sessionEventId: b.sessionEventId, residentApprovalId: record.approvalId, stewardPolicy: null,
  }
}

export function createRootHostApprovalRuntime(options: {
  agentRoot: string
  port: RootHostApprovalPort
  resolveContext(binding: RootHostBinding): Promise<ToolContext>
  deliver(text: string, approvalId: string): Promise<void>
  effectBarrier?: () => void
  approvalCoordinatorFactory?: (context: { sessionPath: string; baseSessionRevision: string }) => ApprovalCoordinator
  dependencies?: { runProvider?: typeof runAgent; getProviderRuntime?: typeof getProviderRuntime; getMcp?: typeof getSharedMcpManager }
}) {
  const store = new FileRootHostPendingApprovalStore(options.agentRoot)
  const port = options.port
  const barrier = options.effectBarrier ?? (() => undefined)
  const readStatus = async (record: RootHostPendingApprovalV1): Promise<RootHostStatus> => {
    const status = await port.status(record.registration)
    if (status.permit) requireValid(Object.entries(correlation(record)).every(([key, value]) => isDeepStrictEqual(status.permit!.payload[key], value)))
    return status
  }
  const current = async (record: RootHostPendingApprovalV1): Promise<RunAgentOptions & { toolContext: ToolContext }> => {
    requireValid(record.binding.agentRoot === options.agentRoot)
    if (!await port.refresh()) throw new Error("Root host authority is unavailable")
    const context = await options.resolveContext(record.binding)
    requireValid(context.rootHost?.port === port)
    await authorizeRootHostContext(context, record.binding)
    const owner = { agentName: "sanctuary", agentRoot: options.agentRoot }
    const runtime = await (options.dependencies?.getProviderRuntime ?? getProviderRuntime)("human", owner)
    const mcp = await (options.dependencies?.getMcp ?? getSharedMcpManager)(owner) ?? undefined
    if (!port.isHealthy() && !await port.refresh()) throw new Error("Root host authority is unavailable")
    const select = () => selectToolsForChannel(getChannelCapabilities("telegram"), context.context?.friend.toolPreferences, context.context, runtime.capabilities, mcp, runtime.model, context)
    const toolContext: ToolContext = { ...context, toolSelection: select(), selectCurrentTools: select }
    const call = (record.checkpoint.frozenAssistantMessage.tool_calls as unknown as OpenAI.ChatCompletionMessageToolCall[])[0]!
    requireValid(call.type === "function")
    const args = JSON.parse(call.function.arguments)
    const preflight = await preflightToolCall("sanctuary_host_execute", args, toolContext)
    if (preflight.kind === "rejected_before_handler" && preflight.error && !(preflight.error instanceof RootHostAuthorizationError)) throw preflight.error
    requireValid(preflight.kind === "ready" && preflight.definition)
    checkDefinition(record.checkpoint, preflight.definition)
    const proposed = validateRootHostToolArguments(args, record.binding.targetHost)
    for (const [key, value] of Object.entries(proposed)) requireValid(isDeepStrictEqual(record.registration.registration.payload[key], value))
    return { toolContext, providerRuntimeOverride: runtime, mcpManager: mcp }
  }
  const coordinator = (context: { sessionPath: string; baseSessionRevision: string }): ApprovalCoordinator => ({
    async propose(request) {
      barrier()
      const live = request.liveToolContext
      const { liveToolContext: _live, ...proposal } = request
      request = structuredClone(proposal)
      requireValid(live?.rootHost?.port === port && request.toolCall.type === "function" && request.toolCall.function.name === "sanctuary_host_execute")
      requireValid(live.currentSession?.sessionPath === context.sessionPath && live.agentRoot === options.agentRoot)
      const binding = await authorizeRootHostContext(live)
      const preflight = await preflightToolCall("sanctuary_host_execute", request.arguments as Record<string, string>, live)
      requireValid(preflight.kind === "ready" && preflight.definition)
      requireValid(withImmediateSessionTurnLease(context.sessionPath, (lease) => readSessionTransaction(context.sessionPath, lease).revision) === context.baseSessionRevision)
      const args = validateRootHostToolArguments(request.arguments, binding.targetHost)
      const approvalId = `root-host-${randomUUID()}`
      const draft = {
        approvalId, baseSessionRevision: context.baseSessionRevision, argumentDigest: digestJson(request.arguments),
        schemaDigest: request.schemaDigest, toolDigest: request.toolDigest, policyDigest: request.policyDigest,
        preCallDigest: digestJson(request.preCallMessages as unknown as JsonValue), preCallMessages: structuredClone(request.preCallMessages),
        frozenAssistantMessage: structuredClone(request.frozenAssistantMessage) as unknown as ApprovalSuspensionCheckpoint["frozenAssistantMessage"],
      }
      const checkpoint = { ...draft, suspendedSessionRevision: context.baseSessionRevision, checkpointDigest: digestApprovalSuspensionCheckpointPayload(draft) }
      validateCheckpoint(checkpoint, approvalId, binding.targetHost)
      requireValid(isDeepStrictEqual(request.frozenAssistantMessage.tool_calls![0], request.toolCall))
      const policy = checkDefinition(checkpoint, preflight.definition)
      requireValid(request.policyId === policy.policyId && request.actionClass === policy.actionClass)
      const observation = live.rootHost.observation!
      barrier()
      const registration = await port.register({ ...args, ownerObservation: {
        digest: observation.observationDigest, updateId: observation.updateId, userId: observation.userId, chatId: observation.chatId, messageId: observation.messageId!,
      } })
      await authorizeRootHostContext(live)
      requireValid(withImmediateSessionTurnLease(context.sessionPath, (lease) => readSessionTransaction(context.sessionPath, lease).revision) === context.baseSessionRevision)
      barrier()
      store.put({ schemaVersion: 1, approvalId, registration, binding, checkpoint, executionRequested: false, continuationState: "pending", materializedSessionRevision: null, rootStatusDigest: null, reconciliationRequired: false })
      return { approvalId, checkpointDigest: checkpoint.checkpointDigest, suspendedSessionRevision: checkpoint.suspendedSessionRevision }
    },
  })
  const reconcile = async (initial: RootHostPendingApprovalV1): Promise<void> => {
    // Never choose a filesystem path from an unvalidated persisted binding.
    requireValid(initial.binding.agentRoot === options.agentRoot
      && initial.binding.sessionPath === getSenseSessionPath("sanctuary", initial.binding.friendId, "telegram", initial.binding.sessionKey, options.agentRoot))
    await withSessionTurnLease(initial.binding.sessionPath, async (lease) => {
      const record = store.list().find((item) => item.approvalId === initial.approvalId)!
      if (record.continuationState === "complete") return
      barrier()
      let status = await readStatus(record)
      record.rootStatusDigest = status.statusDigest
      if (status.state === "approved" && !record.executionRequested) {
        await current(record)
        requireValid(readSessionTransaction(record.binding.sessionPath, lease).revision === record.checkpoint.suspendedSessionRevision)
        record.executionRequested = true
        barrier()
        store.put(record)
        try { await port.execute(correlation(record)) }
        catch {
          record.reconciliationRequired = true
          store.put(record)
          return
        }
        status = await readStatus(record)
        record.rootStatusDigest = status.statusDigest
      }
      record.reconciliationRequired = status.execution === "reconciliation_required" || (record.executionRequested && status.state === "approved")
      barrier()
      store.put(record)
      const terminal = terminalProjection(record, status)
      if (!terminal) return
      const expectedRevision = record.materializedSessionRevision ?? record.checkpoint.suspendedSessionRevision
      if (record.continuationState === "attempted"
        || readSessionTransaction(record.binding.sessionPath, lease).revision !== expectedRevision) {
        record.continuationState = "complete"
        barrier()
        store.put(record)
        emitNervesEvent({ component: "senses", event: "senses.root_host_terminal_control", message: "root outcome retained without retrying an attempted or superseded continuation", meta: { approvalId: record.approvalId } })
        return
      }
      try {
        await current(record)
        requireValid(readSessionTransaction(record.binding.sessionPath, lease).revision === expectedRevision)
      }
      catch (error) {
        if (!(error instanceof RootHostAuthorizationError) && !(error instanceof RootHostPendingApprovalError)) throw error
        record.continuationState = "complete"
        barrier()
        store.put(record)
        emitNervesEvent({ component: "senses", event: "senses.root_host_authority_control", message: "root terminal outcome retained without a continuation because current owner authority changed", meta: { approvalId: record.approvalId, state: terminal.state } })
        return
      }
      let authorized = false
      const continuationCoordinator: ApprovalCoordinator = {
        propose: (request) => (options.approvalCoordinatorFactory ?? coordinator)({
          sessionPath: record.binding.sessionPath, baseSessionRevision: readSessionTransaction(record.binding.sessionPath, lease).revision,
        }).propose(request),
      }
      await resumeApprovalContinuation({
        record: terminal, checkpoint: record.checkpoint, currentSessionRevision: readSessionTransaction(record.binding.sessionPath, lease).revision,
        sessionMessages: record.continuationState === "pending" ? record.checkpoint.preCallMessages : loadSession(record.binding.sessionPath)!.messages,
        callbacks: {}, channel: "telegram",
        claimContinuation: () => ({ claimed: true, interruptedAfterAttempt: false, record: { continuationState: record.continuationState === "materialized" ? "materialized" : "claimed" } }),
        markContinuationMaterialized: () => { barrier(); record.materializedSessionRevision = readSessionTransaction(record.binding.sessionPath, lease).revision; record.continuationState = "materialized"; store.put(record) },
        markContinuationAttempted: () => { barrier(); record.continuationState = "attempted"; store.put(record) },
        completeContinuation: () => { barrier(); record.continuationState = "complete"; store.put(record) },
        runAgent: options.dependencies?.runProvider ?? runAgent,
        revalidate: async () => {
          try {
            const live = await current(record)
            requireValid(readSessionTransaction(record.binding.sessionPath, lease).revision === record.materializedSessionRevision)
            authorized = true
            return { ...live, approvalCoordinator: continuationCoordinator }
          } catch (error) {
            if (!(error instanceof RootHostAuthorizationError) && !(error instanceof RootHostPendingApprovalError)) throw error
            return null
          }
        },
        persist: (messages, result) => { barrier(); saveSession(record.binding.sessionPath, messages, result?.usage, undefined, lease) },
        deliver: async (text) => {
          barrier()
          if (authorized) await options.deliver(text, record.approvalId)
          else emitNervesEvent({ component: "senses", event: "senses.root_host_terminal_control", message: "root owns the terminal host approval card; no unauthorized resident message was sent", meta: { approvalId: record.approvalId, state: terminal.state } })
        },
      })
    })
  }
  const recover = async (registrationId?: string): Promise<void> => {
    for (const record of store.list()) {
      if (record.continuationState === "complete" || (registrationId && registrationId !== record.registration.registrationId)) continue
      try { await reconcile(record) }
      catch (error) {
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.root_host_reconciliation_required", message: "root host continuation remains pending reconciliation", meta: { approvalId: record.approvalId, category: error instanceof Error ? error.name : "unknown" } })
      }
    }
  }
  return {
    coordinator,
    recover: () => recover(),
    async handleUpdate(update: TelegramUpdate): Promise<boolean> {
      const callback = port.callbackForUpdate(update)
      if (!callback.handled) return false
      if (callback.registrationId) {
        try { await recover(callback.registrationId) }
        catch {
          emitNervesEvent({ level: "warn", component: "senses", event: "senses.root_host_reconciliation_required", message: "claimed root callback retained despite unavailable local pending state", meta: { registrationId: callback.registrationId } })
        }
      }
      return true
    },
  }
}
