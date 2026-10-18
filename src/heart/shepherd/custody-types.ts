import type { ShepherdAdministrationContext } from "./types"

export interface ShepherdInputReceipt {
  requestId: string
  surfaceId: string
  workspaceId: string
  processInstance: string
  pasteAdmitted: boolean
  submitAdmitted: boolean
}

export interface ShepherdNativeTarget {
  hostInstance: string
  workspaceId: string
}

export interface ShepherdRetirementProof {
  kind: "host_process_inventory"
  host: string
  session: string
  instance: string | null
  checkedAt: string
  gone: true
  wholeSessionRetired: boolean
}

export type ShepherdRecoveryEvidence =
  | { kind: "guarded_host_receipt_v1"; host: string; checkedAt: string; receipt: ShepherdInputReceipt
    native?: { requestId: string; hostInstance: string } }
  | ShepherdRetirementProof

export interface ShepherdRecoveryRequest {
  id: string
  expectedRevision: number
  requestId: string
  actor: Omit<ShepherdAdministrationContext, "requestId">
  evidence: ShepherdRecoveryEvidence
}

export interface ShepherdRecoveryReceipt {
  revision: number
  dispatchId: string
  resolution: "acknowledged_delivery" | "retired_instance"
  originalState: "claimed" | "sent" | "unknown"
  at: string
  actorId: string
  requestId: string
}

export interface ShepherdCustodyEntry {
  id: string
  nativeRequestId?: string
  nativeTarget?: ShepherdNativeTarget
  host: string
  session: string
  instance: string | null
  state: "claimed" | "sent" | "not_sent" | "unknown"
  trigger: "immediate" | "network" | "periodic"
  claimedAt: string
  reason: string | null
  retired: boolean
  receipt: ShepherdInputReceipt | null
  reconciliations: ShepherdRecoveryReceipt[]
  reconciliationCount: number
}

export interface ShepherdCustodySnapshot {
  state: "ready" | "missing"
  schemaVersion: 1 | 2 | null
  revision: number | null
  bytes: number | null
  capacity: "normal" | "warning" | "refused" | "unknown"
  totalCount: number | null
  noticeCount: number | null
  counts: Record<ShepherdCustodyEntry["state"], number> | null
  entries: ShepherdCustodyEntry[]
  nextCursor: string | null
}

export interface ShepherdSenseStoppedProof {
  kind: "daemon_lifecycle"
  checkedAt: string
  enabled: false
  processState: "stopped"
}

export interface ShepherdMaintenanceRequest {
  /** Trusted local adapter's canonical original intent; excludes derived live proofs and pagination. */
  requestFingerprint?: string
  expectedRevision: number
  requestId: string
  actor: Omit<ShepherdAdministrationContext, "requestId">
  sense: ShepherdSenseStoppedProof
  retiredInstances: ShepherdRetirementProof[]
  destination: string
}

export interface ShepherdMaintenanceReceipt {
  revision: number
  requestId: string
  actorId: string
  archivedCount: number
  retainedCount: number
  archive: string
  archiveDigest: string
  at: string
}
