export type SyntheticCrashPoint =
  | "after_journal_prepare"
  | "after_token_persist"
  | "after_checkpoint_write"
  | "after_prompt_accept_before_bind"
  | "after_claim"
  | "after_attempt"
  | "after_handler"
  | "after_terminal_persist"
  | "after_continuation_materialize"
  | "after_continuation_attempt"

export interface SyntheticApprovalScenario {
  command?: string
  argumentsJson?: string
  liveArgumentsJson?: string
  decision?: "approve" | "deny"
  delayMs?: number
  restartBeforeDecision?: boolean
  crashAt?: SyntheticCrashPoint
  handlerMode?: "idempotent" | "non_idempotent"
  batch?: Array<{ name: string; argumentsJson: string }>
  concurrentDecisionProcesses?: number
  advanceSessionHeadBeforeDecision?: boolean
}

export interface SyntheticApprovalEvidence {
  initialOutcome: "suspended" | "rejected"
  protectedByPolicy: boolean
  reportedRisk: "low" | "medium" | "high"
  rejectedAt: "pre_proposal_schema" | "pre_attempt_schema" | "protected_batch" | null
  journalState: string | null
  handlerCallsAtSuspension: number
  handlerCalls: number
  externalEffects: number
  attemptedPersistedBeforeHandler: boolean
  originatingProviderCalls: number
  continuationProviderCalls: number
  originalUserMessageCount: number
  correlatedTerminalPairs: number
  ordinaryOrphanRepairResults: number
  deliveries: string[]
  processIds: number[]
  staleCallbackAccepted: boolean
  freshApprovalRequired: boolean
  retryableAttemptObserved: boolean
}

export async function runSyntheticApprovalScenario(
  _scenario: SyntheticApprovalScenario,
): Promise<SyntheticApprovalEvidence> {
  throw new Error("synthetic approval vertical slice is not implemented")
}
