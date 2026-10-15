export type ContinuityRunner = "copilot" | "claude" | "codex"
export type ContinuityFileIdentity = { dev: number; ino: number }

export interface ContinuityRoot {
  id: string
  path: string
  namespace: string
  receiptBase: string
  launchRoots: string[]
  worktreeRoots: string[]
  identity: ContinuityFileIdentity
}

export interface ContinuityProfile {
  id: string
  runner: ContinuityRunner
  launcher: "direct" | "agency"
  executable: string
  argv: string[]
  rootIds: string[]
  settingsPath: string
  version: string
  executableIdentity: ContinuityFileIdentity
  fingerprint: string
}

export interface ContinuityConfig {
  schemaVersion: 1
  roots: ContinuityRoot[]
  profiles: ContinuityProfile[]
}

export interface ProcessGeneration {
  pid: number
  birth: string
  uid: number
}

export interface ContinuityOrigin {
  actorId: string
  requestId: string
  surfaceId?: string
}

export interface ContinuityBinding {
  id: string
  agent: string
  host: string
  incarnation: string
  surfaceId: string
  surfaceGeneration: string
  nativeSessionId: string
  runner: ContinuityRunner
  process: ProcessGeneration
  wrapper: ProcessGeneration | null
  launchCwd: string
  worktree: string
  rootId: string
  root: ContinuityRoot
  taskRef: string
  taskKey: string
  profileId: string | null
  profileFingerprint: string | null
  configFingerprint: string
  enrollmentEpoch: string
}

export type ContinuityRoundKind = "preparation" | "followup" | "correction"
export interface ContinuityRound {
  batchId: string
  kind: ContinuityRoundKind
  nonce: string
  receiptSlot: string
  phase: "reserved" | "issued" | "acknowledged" | "uncertain" | "blocked"
  attemptId: string
  expectedRevision: number
}

export interface ContinuityReceiptCorrelation {
  schemaVersion: 1
  batchId: string
  bindingId: string
  generation: number
  round: ContinuityRoundKind | "bootstrap" | "execute"
  nonce: string
  launchAttemptId: string | null
}

export interface ContinuityKnownJob {
  id: string
  kind: string
  owner: string
  effects: string
  status: string
  disposition: string
  reference: string
}

export interface ContinuityUncertainMutation {
  id: string
  operation: string
  disposition: string
  evidence: string
}

export interface ContinuityReceipt extends ContinuityReceiptCorrelation {
  checkpoint: { rootId: string; relativePath: string; sha256: string }
  task: {
    ref: string
    rootId: string
    launchCwd: string
    worktree: string
    branch: string
    head: string
    nextAction: string
  }
  confirmation: boolean
  knownJobs: ContinuityKnownJob[]
  uncertainMutations: ContinuityUncertainMutation[]
}

export interface ContinuityAssurance {
  checkpoint: "unverified" | "verified"
  endReadiness: "unconfirmed" | "agent-confirmed-as-of-native-boundary" | "native-observed"
  backgroundCoverage: "unknown" | "native-managed-snapshot"
  jobInventory: "unverified" | "preserved-agent-reported"
  reopen: "unverified" | "eligible" | "blocked"
  observedAt: string | null
  qualifications: string[]
}

export interface ContinuityCheckpointProjection {
  goal: string
  scope: string
  decisions: string[]
  nextAction: string
  knownJobs: ContinuityKnownJob[]
  uncertainMutations: ContinuityUncertainMutation[]
  references: string[]
  checkpointSha256: string
}

export interface ContinuityEnrollment {
  id: string
  agent: string
  runner: ContinuityRunner
  nativeSessionId: string
  process: ProcessGeneration
  wrapper: ProcessGeneration | null
  profileId: string
  profileFingerprint: string
  configFingerprint: string
  launchCwd: string
  observedAt: string
}

export interface ContinuityLaunch {
  attemptId: string
  bootstrapNonce: string
  bootstrapSlot: string
  phase: "reserved" | "created" | "bootstrapped" | "grant-issued" | "working" | "reconciling" | "uncertain" | "blocked"
  nativeSessionId: string
  wrapper: ProcessGeneration | null
  actor: ProcessGeneration | null
  workspaceId: string | null
  surfaceId: string | null
  executeNonce: string | null
  executeSlot: string | null
  milestones: string[]
}

export interface ContinuityTarget {
  id: string
  binding: ContinuityBinding
  generation: number
  state: "previewed" | "pending-boundary" | "checkpoint-requested" | "verifying" | "ready" | "blocked" | "unsupported" | "uncertain" | "cancelled"
  reopen: "not-requested" | "eligible" | "launching" | "launched" | "blocked" | "unsupported" | "uncertain"
  rounds: ContinuityRound[]
  reasons: string[]
  assurance: ContinuityAssurance
  receipt: ContinuityReceipt | null
  projection: ContinuityCheckpointProjection | null
  unresolvedInventory: {
    knownJobs: ContinuityKnownJob[]
    uncertainMutations: ContinuityUncertainMutation[]
  }
  observedTransitions: string[]
  launch: ContinuityLaunch | null
}

export interface ContinuityBatch {
  id: string
  agent: string
  requestId: string
  bodyHash: string
  origin: ContinuityOrigin
  createdAt: string
  cancellation: "none" | "cancelling" | "cancelled"
  targets: ContinuityTarget[]
}

export interface ContinuityClaim {
  taskKey: string
  agent: string
  batchId: string
  targetId: string
  bindingId: string
  phase: "source" | "launch-reserved" | "created" | "transferred" | "uncertain" | "ended"
  actor: ProcessGeneration | null
  attemptId: string | null
}

export interface ContinuityHold {
  agent: string
  host: string
  surface: string
  batchId: string
  targetId: string
}

export interface ContinuityDispatchRequest {
  agent: string
  host: string
  surface: string
  requestId: string
  bodyHash: string
}

export interface ContinuityDispatch extends ContinuityDispatchRequest {
  id: string
  phase: "reserved" | "issued" | "acknowledged" | "uncertain" | "blocked"
}

export interface ContinuityDispatchReservation extends ContinuityDispatch {
  newlyReserved: boolean
}

export interface ContinuityState {
  schemaVersion: 1
  revision: number
  enrollments: ContinuityEnrollment[]
  batches: ContinuityBatch[]
  claims: ContinuityClaim[]
  holds: ContinuityHold[]
  dispatches: ContinuityDispatch[]
}

export interface ContinuitySummary {
  agent: string
  revision: number
  batches: ContinuityBatch[]
  counts: {
    selected: number
    ready: number
    blocked: number
    unsupported: number
    uncertain: number
    cancelled: number
    pending: number
    launched: number
    backgroundUnknown: number
  }
}
