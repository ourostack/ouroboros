import { runAgent, resumeApprovalContinuation } from "../../heart/core"
import { openApprovalStore } from "../../heart/approval-store"
import {
  commitApprovalProposal,
  coordinateApprovalDecision,
  executeApprovalDecision,
} from "../../heart/tool-approval"

export const syntheticApprovalProductionSeams = {
  runAgent,
  openApprovalStore,
  commitApprovalProposal,
  coordinateApprovalDecision,
  executeApprovalDecision,
  resumeApprovalContinuation,
}

export type SyntheticCrashPoint =
  | "after_journal_prepare"
  | "after_token_persist"
  | "after_checkpoint_write"
  | "after_prompt_accept_before_bind"
  | "after_claim"
  | "after_attempt"
  | "after_handler"
  | "after_terminal_persist"
  | "after_terminal_pair_persist_before_materialized"
  | "after_materialized_marker_before_continuation_attempt"
  | "after_continuation_attempt"

export interface SyntheticApprovalScenario {
  command?: string
  argumentsJson?: string
  liveSchemaMutation?: "require_missing_property" | "wrong_command_type" | "treat_command_as_extra"
  corruptJournalAfterProposal?: "non_object_arguments" | "malformed_record_json"
  decision?: "approve" | "deny"
  delayMs?: number
  restartBeforeDecision?: boolean
  crashAt?: SyntheticCrashPoint
  handlerMode?: "idempotent" | "non_idempotent" | "observable_failure"
  batch?: Array<{ name: string; argumentsJson: string }>
  concurrentDecisionProcesses?: number
  advanceSessionHeadBeforeDecision?: boolean
}

export interface SyntheticApprovalArtifacts {
  root: string
  approvalId: string | null
  approvalDatabasePath: string
  sessionPath: string
  effectsLogPath: string
  providerLogPath: string
  deliveryLogPath: string
  traceLogPath: string
  initialOutcome: "suspended" | "rejected"
  rejectionAt: "pre_proposal_schema" | "protected_batch" | null
  runErrorCode: string | null
  originPid: number
  decisionPids: number[]
  continuationPids: number[]
  callbackOutcomes: Array<{ processPid: number; accepted: boolean; reason: string }>
}

export async function runSyntheticApprovalScenario(
  _scenario: SyntheticApprovalScenario,
): Promise<SyntheticApprovalArtifacts> {
  throw new Error("synthetic approval vertical slice is not implemented")
}
