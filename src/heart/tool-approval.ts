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

function checkpointMatches(record: ApprovalRecord, checkpoint: ApprovalSuspensionCheckpoint): boolean {
  return checkpoint.approvalId === record.approvalId
    && checkpoint.checkpointDigest === record.checkpointDigest
    && checkpoint.baseSessionRevision === record.baseSessionRevision
    && checkpoint.argumentDigest === record.argumentDigest
    && checkpoint.schemaDigest === record.schemaDigest
    && checkpoint.toolDigest === record.toolDigest
    && checkpoint.policyDigest === record.policyDigest
    && checkpoint.preCallDigest === digestTranscript(checkpoint.preCallMessages)
    && record.checkpointDigest === digestApprovalSuspensionCheckpointPayload(checkpoint)
    && JSON.stringify(checkpoint.frozenAssistantMessage) === JSON.stringify(record.frozenAssistantMessage)
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
