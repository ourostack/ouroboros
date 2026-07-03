import type { AgentProvider } from "../identity"
import type { ProviderLane } from "../provider-lanes"

export type PrivateTurnDecisionResult = "allow" | "deny"

export interface PrivateTurnOriginRef {
  kind: string
  id: string
  [key: string]: unknown
}

export interface PrivateTurnRequest {
  agent: string
  origin: string
  reason: string
  providerLane: ProviderLane
  triggerSource: string
  idempotencyKey?: string
  budgetClass: string
  originRefs: PrivateTurnOriginRef[]
  turn?: unknown
  [key: string]: unknown
}

export interface PrivateTurnProviderLaneMetadata {
  lane: ProviderLane
  provider: AgentProvider | string
  model: string
  source: "agent.json"
  credentialRevision?: string
}

export interface PrivateTurnLedgerLocator {
  path: string
  line?: number
}

export interface PrivateTurnDecision {
  schemaVersion: 1
  receiptId: string
  agent: string
  origin: string
  reason: string
  providerLane: PrivateTurnProviderLaneMetadata
  triggerSource: string
  idempotencyKey: string
  budgetClass: string
  originRefs: PrivateTurnOriginRef[]
  requestFingerprint: string
  result: PrivateTurnDecisionResult
  executable: boolean
  decidedAt: string
  ledgerLocator: PrivateTurnLedgerLocator
  deniedReason?: string
  duplicateOf?: string
  error?: string
}

export type PrivateTurnPolicyEvaluation =
  | { result: "allow"; reason: string }
  | { result: "deny"; reason?: string; deniedReason?: string }

export interface PrivateTurnPolicyDeps {
  ledgerPath?: string
  now?: () => string | Date
  resolveProviderLane?: (agent: string, lane: ProviderLane) => Promise<PrivateTurnProviderLaneMetadata> | PrivateTurnProviderLaneMetadata
  evaluatePolicy?: (
    request: PrivateTurnRequest,
    context: {
      requestFingerprint: string
      idempotencyKey: string
      providerLane: PrivateTurnProviderLaneMetadata
    },
  ) => Promise<PrivateTurnPolicyEvaluation> | PrivateTurnPolicyEvaluation
  emitNervesEvent?: (event: {
    level?: "debug" | "info" | "warn" | "error"
    component: string
    event: string
    message: string
    meta?: Record<string, unknown>
  }) => void
  bundlesRoot?: string
}

