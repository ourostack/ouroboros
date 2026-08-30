import { createHash } from "node:crypto"

import type OpenAI from "openai"

import {
  ApprovalStoreError,
  canonicalApprovalArguments,
  type ApprovalRecord,
  type ApprovalStore,
  type JsonObject,
  type PrepareApprovalInput,
} from "./approval-store"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "../repertoire/tools-base"
import { digestJson, validateAdvertisedToolArguments } from "../repertoire/tool-arguments"

export interface ApprovalSuspensionCheckpoint {
  approvalId: string
  checkpointDigest: string
  baseSessionRevision: string
  suspendedSessionRevision: string
  argumentDigest: string
  schemaDigest: string
  toolDigest: string
  policyDigest: string
  preCallDigest: string
  preCallMessages: OpenAI.ChatCompletionMessageParam[]
  frozenAssistantMessage: JsonObject
}

export type ApprovalSuspensionCheckpointDraft = Omit<
  ApprovalSuspensionCheckpoint,
  "checkpointDigest" | "suspendedSessionRevision"
>

export interface ApprovalSuspensionCheckpointStore {
  write(draft: ApprovalSuspensionCheckpointDraft): {
    checkpointDigest: string
    suspendedSessionRevision: string
  }
  read(approvalId: string): ApprovalSuspensionCheckpoint | null
  list(): ApprovalSuspensionCheckpoint[]
  remove(approvalId: string): void
}

export interface ApprovalTokenStore {
  put(approvalId: string, decisionToken: string): void
  has(approvalId: string): boolean
  get(approvalId: string): string | null
  remove(approvalId: string): void
}

export interface CommitApprovalProposalOptions {
  approvalStore: ApprovalStore
  checkpointStore: ApprovalSuspensionCheckpointStore
  tokenStore: ApprovalTokenStore
  proposal: PrepareApprovalInput
  preCallMessages: OpenAI.ChatCompletionMessageParam[]
  hooks?: {
    afterJournalPrepare?: () => void
    afterTokenPersist?: () => void
    afterCheckpointWrite?: () => void
  }
}

export interface CommittedApprovalProposal {
  record: ApprovalRecord
  decisionToken: string
}

export class ApprovalExecutionIndeterminateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalExecutionIndeterminateError"
  }
}

export class ApprovalExecutionFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalExecutionFailedError"
  }
}

export interface ApprovalLiveContext {
  record: ApprovalRecord
  checkpoint: ApprovalSuspensionCheckpoint
  definition: ToolDefinition
  arguments: JsonObject
}

export interface CoordinateApprovalDecisionOptions {
  withSessionLease<T>(work: (lease: { ownerId: string; ownerToken: string }) => Promise<T>): Promise<T>
  readCurrentRevision(): string
  suspendedSessionRevision?: string
  decideAndExecute(input: {
    currentSessionRevision: string
    lease: { ownerId: string; ownerToken: string }
    hooks: { afterClaim(): Promise<void> }
  }): Promise<ApprovalRecord>
  resume(record: ApprovalRecord): void | Promise<void>
  persist?: (record: ApprovalRecord) => void | Promise<void>
  execute?: (...args: unknown[]) => unknown
}

export async function coordinateApprovalDecision(options: CoordinateApprovalDecisionOptions): Promise<{ record: ApprovalRecord }> {
  return options.withSessionLease(async (lease) => {
    let currentSessionRevision = options.readCurrentRevision()
    const record = await options.decideAndExecute({
      currentSessionRevision,
      lease,
      hooks: {
        afterClaim: async () => {
          currentSessionRevision = options.readCurrentRevision()
        },
      },
    })
    await options.persist?.(record)
    await options.resume(record)
    emitNervesEvent({
      component: "engine",
      event: "engine.approval_decision_coordinated",
      message: "approval decision coordinated under session turn lease",
      meta: { approvalId: record.approvalId, state: record.state },
    })
    return { record }
  })
}

export interface ExecuteApprovalDecisionOptions {
  approvalStore: ApprovalStore
  checkpointStore: ApprovalSuspensionCheckpointStore
  decision: Omit<Parameters<ApprovalStore["decide"]>[0], "ownerId">
  ownerId: string
  currentSessionRevision: string
  resolveTool(toolName: string): ToolDefinition | undefined
  resolveApprovalPolicy?: (toolName: string, argumentsValue: JsonObject) => ReturnType<NonNullable<ToolDefinition["approvalPolicy"]>> | Promise<ReturnType<NonNullable<ToolDefinition["approvalPolicy"]>>>
  liveGuard(context: ApprovalLiveContext): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>
  liveRisk(context: ApprovalLiveContext): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>
  execute(toolName: string, argumentsValue: JsonObject): Promise<string>
  hooks?: {
    afterClaim?: () => void | Promise<void>
    afterAttempt?: () => void | Promise<void>
    afterHandler?: () => void | Promise<void>
  }
}

function checkpointMatches(record: ApprovalRecord, checkpoint: ApprovalSuspensionCheckpoint): boolean {
  return checkpoint.approvalId === record.approvalId
    && checkpoint.checkpointDigest === record.checkpointDigest
    && checkpoint.baseSessionRevision === record.baseSessionRevision
    && (record.state === "preparing" || checkpoint.suspendedSessionRevision === record.suspendedSessionRevision)
    && checkpoint.argumentDigest === record.argumentDigest
    && checkpoint.schemaDigest === record.schemaDigest
    && checkpoint.toolDigest === record.toolDigest
    && checkpoint.policyDigest === record.policyDigest
    && checkpoint.preCallDigest === digestTranscript(checkpoint.preCallMessages)
    && record.checkpointDigest === digestApprovalSuspensionCheckpointPayload(checkpoint)
    && JSON.stringify(checkpoint.frozenAssistantMessage) === JSON.stringify(record.frozenAssistantMessage)
}

function frozenCallMatches(record: ApprovalRecord, checkpoint: ApprovalSuspensionCheckpoint): boolean {
  const message = checkpoint.frozenAssistantMessage as Record<string, unknown>
  if (message.role !== "assistant") return false
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) return false
  const call = message.tool_calls[0]
  if (!call || typeof call !== "object" || Array.isArray(call)) return false
  const callRecord = call as Record<string, unknown>
  if (callRecord.type !== "function") return false
  const fn = callRecord.function
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return false
  const functionRecord = fn as Record<string, unknown>
  if (callRecord.id !== record.toolCallId || functionRecord.name !== record.toolName || typeof functionRecord.arguments !== "string") return false
  try {
    const parsed = JSON.parse(functionRecord.arguments)
    return JSON.stringify(parsed) === JSON.stringify(record.arguments)
  } catch {
    return false
  }
}

function digestTranscript(messages: OpenAI.ChatCompletionMessageParam[]): string {
  return createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex")
}

export function digestApprovalSuspensionCheckpointPayload(checkpoint: {
  baseSessionRevision: string
  argumentDigest: string
  schemaDigest: string
  toolDigest: string
  policyDigest: string
  preCallDigest: string
  preCallMessages: OpenAI.ChatCompletionMessageParam[]
  frozenAssistantMessage: JsonObject
}): string {
  return createHash("sha256").update(JSON.stringify({
    baseSessionRevision: checkpoint.baseSessionRevision,
    argumentDigest: checkpoint.argumentDigest,
    schemaDigest: checkpoint.schemaDigest,
    toolDigest: checkpoint.toolDigest,
    policyDigest: checkpoint.policyDigest,
    preCallDigest: checkpoint.preCallDigest,
    preCallMessages: checkpoint.preCallMessages,
    frozenAssistantMessage: checkpoint.frozenAssistantMessage,
  }), "utf8").digest("hex")
}

function digestDecisionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function commitApprovalProposal(options: CommitApprovalProposalOptions): CommittedApprovalProposal {
  emitNervesEvent({
    component: "engine",
    event: "engine.approval_proposal_commit_start",
    message: "approval proposal commit started",
    meta: { toolName: options.proposal.toolName, toolCallId: options.proposal.toolCallId },
  })
  const preCallDigest = digestTranscript(options.preCallMessages)
  const checkpointDigest = digestApprovalSuspensionCheckpointPayload({
    baseSessionRevision: options.proposal.baseSessionRevision,
    argumentDigest: canonicalApprovalArguments(options.proposal.arguments).digest,
    schemaDigest: options.proposal.schemaDigest,
    toolDigest: options.proposal.toolDigest,
    policyDigest: options.proposal.policyDigest,
    preCallDigest,
    preCallMessages: options.preCallMessages,
    frozenAssistantMessage: options.proposal.frozenAssistantMessage,
  })
  const prepared = options.approvalStore.prepare({ ...options.proposal, checkpointDigest })
  options.hooks?.afterJournalPrepare?.()
  options.tokenStore.put(prepared.record.approvalId, prepared.decisionToken)
  options.hooks?.afterTokenPersist?.()
  const attestation = options.checkpointStore.write({
    approvalId: prepared.record.approvalId,
    baseSessionRevision: prepared.record.baseSessionRevision,
    argumentDigest: prepared.record.argumentDigest,
    schemaDigest: prepared.record.schemaDigest,
    toolDigest: prepared.record.toolDigest,
    policyDigest: prepared.record.policyDigest,
    preCallDigest,
    preCallMessages: structuredClone(options.preCallMessages),
    frozenAssistantMessage: structuredClone(prepared.record.frozenAssistantMessage),
  })
  options.hooks?.afterCheckpointWrite?.()

  if (attestation.checkpointDigest !== prepared.record.checkpointDigest) {
    options.tokenStore.remove(prepared.record.approvalId)
    options.checkpointStore.remove(prepared.record.approvalId)
    options.approvalStore.recoverPreparing({
      approvalId: prepared.record.approvalId,
      state: "drifted",
      reason: "checkpoint attestation digest mismatch",
    })
    emitNervesEvent({
      level: "error",
      component: "engine",
      event: "engine.approval_checkpoint_attestation_mismatch",
      message: "approval checkpoint durability attestation did not match proposal",
      meta: { approvalId: prepared.record.approvalId },
    })
    throw new ApprovalStoreError("checkpoint_attestation_mismatch")
  }

  const record = options.approvalStore.activate({
    approvalId: prepared.record.approvalId,
    checkpointDigest: attestation.checkpointDigest,
    suspendedSessionRevision: attestation.suspendedSessionRevision,
  })
  emitNervesEvent({
    component: "engine",
    event: "engine.approval_proposal_commit_end",
    message: "approval proposal checkpoint activated",
    meta: { approvalId: record.approvalId },
  })
  return { record, decisionToken: prepared.decisionToken }
}

export function recoverApprovalProposals(options: {
  approvalStore: ApprovalStore
  checkpointStore: ApprovalSuspensionCheckpointStore
  tokenStore: ApprovalTokenStore
}): Array<{ approvalId: string; state: string }> {
  const recovered: Array<{ approvalId: string; state: string }> = []
  const preparing = options.approvalStore.listPreparing()
  const preparingIds = new Set(preparing.map((record) => record.approvalId))

  for (const checkpoint of options.checkpointStore.list()) {
    if (preparingIds.has(checkpoint.approvalId) || options.approvalStore.read(checkpoint.approvalId)) continue
    options.checkpointStore.remove(checkpoint.approvalId)
    recovered.push({ approvalId: checkpoint.approvalId, state: "orphan_checkpoint_removed" })
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.approval_orphan_checkpoint_removed",
      message: "removed approval checkpoint with no journal authority",
      meta: { approvalId: checkpoint.approvalId },
    })
  }

  for (const record of preparing) {
    const checkpoint = options.checkpointStore.read(record.approvalId)
    const token = options.tokenStore.get(record.approvalId)
    const hasToken = token !== null
    const tokenMatches = token !== null && digestDecisionToken(token) === record.decisionTokenDigest
    if (checkpoint && tokenMatches && checkpointMatches(record, checkpoint)) {
      const activated = options.approvalStore.activate({
        approvalId: record.approvalId,
        checkpointDigest: checkpoint.checkpointDigest,
        suspendedSessionRevision: checkpoint.suspendedSessionRevision,
      })
      recovered.push({ approvalId: record.approvalId, state: activated.state })
      continue
    }

    options.tokenStore.remove(record.approvalId)
    if (checkpoint) options.checkpointStore.remove(record.approvalId)
    const checkpointMismatch = checkpoint !== null && !checkpointMatches(record, checkpoint)
    const tokenMismatch = hasToken && !tokenMatches
    const mismatch = checkpointMismatch || tokenMismatch
    const terminal = options.approvalStore.recoverPreparing({
      approvalId: record.approvalId,
      state: mismatch ? "drifted" : "abandoned_before_attempt",
      reason: tokenMismatch ? "decision token evidence mismatch" : mismatch ? "checkpoint evidence mismatch" : "incomplete proposal commit",
    })
    recovered.push({ approvalId: record.approvalId, state: terminal.state })
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.approval_proposal_recovery",
    message: "approval proposal recovery scan completed",
    meta: { recoveredCount: recovered.length },
  })
  return recovered
}

function terminalizeClaimed(
  store: ApprovalStore,
  claimed: ApprovalRecord,
  state: "drifted" | "session_head_changed",
  reason: string,
): ApprovalRecord {
  emitNervesEvent({
    level: "warn",
    component: "engine",
    event: "engine.approval_pre_attempt_terminalized",
    message: "approval stopped during live revalidation",
    meta: { approvalId: claimed.approvalId, state, reason },
  })
  return store.terminalizeBeforeAttempt({
    approvalId: claimed.approvalId,
    ownerId: claimed.ownerId!,
    epoch: claimed.epoch,
    state,
    reason,
  })
}

export async function executeApprovalDecision(options: ExecuteApprovalDecisionOptions): Promise<ApprovalRecord> {
  const decided = options.approvalStore.decide({ ...options.decision, ownerId: options.ownerId })
  if (decided.state !== "claimed") return decided
  await options.hooks?.afterClaim?.()

  if (options.currentSessionRevision !== decided.suspendedSessionRevision) {
    return terminalizeClaimed(options.approvalStore, decided, "session_head_changed", "suspended session revision changed")
  }

  const checkpoint = options.checkpointStore.read(decided.approvalId)
  if (!checkpoint || !checkpointMatches(decided, checkpoint) || !frozenCallMatches(decided, checkpoint)) {
    return terminalizeClaimed(options.approvalStore, decided, "drifted", "checkpoint evidence drift")
  }

  const definition = options.resolveTool(decided.toolName)
  if (!definition || definition.tool.function.name !== decided.toolName) {
    return terminalizeClaimed(options.approvalStore, decided, "drifted", "tool identity drift")
  }
  const schema = definition.tool.function.parameters
  if (!schema || typeof schema !== "object") {
    return terminalizeClaimed(options.approvalStore, decided, "drifted", "advertised schema missing")
  }
  const validated = validateAdvertisedToolArguments(JSON.stringify(decided.arguments), schema)
  if (!validated.ok || validated.value.argumentDigest !== decided.argumentDigest
    || validated.value.schemaDigest !== decided.schemaDigest) {
    return terminalizeClaimed(options.approvalStore, decided, "drifted", "tool arguments or schema drift")
  }

  const policy = await options.resolveApprovalPolicy?.(decided.toolName, validated.value.arguments)
    ?? definition.approvalPolicy?.(validated.value.arguments)
    ?? { kind: "not_required" as const }
  if (policy.kind !== "required") {
    return terminalizeClaimed(options.approvalStore, decided, "drifted", "approval policy no longer requires approval")
  }
  const toolDigest = digestJson({ name: decided.toolName, schemaDigest: validated.value.schemaDigest, policyId: policy.policyId })
  const policyDigest = digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" })
  if (policy.policyId !== decided.policyId || toolDigest !== decided.toolDigest || policyDigest !== decided.policyDigest) {
    return terminalizeClaimed(options.approvalStore, decided, "drifted", "approval policy or tool digest drift")
  }

  const context: ApprovalLiveContext = {
    record: structuredClone(decided),
    checkpoint: structuredClone(checkpoint),
    definition,
    arguments: structuredClone(validated.value.arguments),
  }
  const guard = await options.liveGuard(context)
  if (!guard.ok) return terminalizeClaimed(options.approvalStore, decided, "drifted", guard.reason)
  const risk = await options.liveRisk(context)
  if (!risk.ok) return terminalizeClaimed(options.approvalStore, decided, "drifted", risk.reason)

  const attempted = options.approvalStore.markAttempted({
    approvalId: decided.approvalId,
    ownerId: decided.ownerId!,
    epoch: decided.epoch,
  })
  await options.hooks?.afterAttempt?.()

  let result: string
  try {
    result = await options.execute(attempted.toolName, structuredClone(attempted.arguments))
  } catch (error) {
    if (!(error instanceof ApprovalExecutionFailedError)) throw error
    await options.hooks?.afterHandler?.()
    return options.approvalStore.complete({
      approvalId: attempted.approvalId,
      ownerId: attempted.ownerId!,
      epoch: attempted.epoch,
      state: "failed",
      result: `error: ${error.message}`,
    })
  }
  await options.hooks?.afterHandler?.()
  return options.approvalStore.complete({
    approvalId: attempted.approvalId,
    ownerId: attempted.ownerId!,
    epoch: attempted.epoch,
    state: "succeeded",
    result,
  })
}

export function recoverClaimedApproval(options: {
  approvalStore: ApprovalStore
  approvalId: string
  reason: string
}): ApprovalRecord {
  const record = options.approvalStore.read(options.approvalId)
  if (!record || record.state !== "claimed" || !record.ownerId) throw new ApprovalStoreError("claimed_recovery_not_eligible")
  return options.approvalStore.abandonBeforeAttempt({
    approvalId: record.approvalId,
    ownerId: record.ownerId,
    epoch: record.epoch,
    reason: options.reason,
  })
}

export function recoverAttemptedApproval(options: {
  approvalStore: ApprovalStore
  approvalId: string
}): ApprovalRecord {
  const record = options.approvalStore.read(options.approvalId)
  if (!record || record.state !== "attempted" || !record.ownerId) throw new ApprovalStoreError("attempted_recovery_not_eligible")
  return options.approvalStore.complete({
    approvalId: record.approvalId,
    ownerId: record.ownerId,
    epoch: record.epoch,
    state: "attempted_indeterminate",
    result: "execution outcome is indeterminate after restart; action was not retried",
  })
}
