import type { CodingSession, CodingSessionOrigin } from "../../nerves/observation"
import type { BridgeRecord, BridgeSessionRef, BridgeTaskLink } from "../../nerves/observation"
import type { TaskStatus, RuntimeMetadata } from "../../nerves/observation"
import type { UsageData } from "../../nerves/observation"
import type { DaemonStatus } from "../../nerves/observation"
import type { InnerJobStatus } from "../daemon/thoughts"
import type { AgentProviderVisibility } from "../provider-visibility"
import type { SessionEvent } from "../session-events"

// Re-export domain types through the observation layer
export type { UsageData } from "../../nerves/observation"
export type { SessionEvent } from "../session-events"

export const MAILBOX_PRODUCT_NAME = "Ouro Mailbox" as const
export const MAILBOX_RELEASE_INTERACTION_MODEL = "read-only" as const
export const MAILBOX_DEFAULT_INNER_VISIBILITY = "summary" as const
export const MAILBOX_DEFAULT_PORT = 6876 as const

// ---------------------------------------------------------------------------
// Agent desk preferences — customizable per-agent Mailbox surface
// ---------------------------------------------------------------------------

export interface MailboxDeskPrefs {
  /** Agent-written "what I'm carrying" text, shown at top of Overview */
  carrying: string | null
  /** Manual status line override (null = auto-derived) */
  statusLine: string | null
  /** Tab ordering — array of tab IDs in preferred order */
  tabOrder: string[] | null
  /** Starred friend IDs — gravitational relationships shown prominently */
  starredFriends: string[]
  /** Pinned constellations — linked threads the agent cares about */
  pinnedConstellations: MailboxConstellation[]
  /** Obligation IDs the agent has dismissed from the needs-me queue */
  dismissedObligations: string[]
}

export interface MailboxConstellation {
  label: string
  friendIds: string[]
  taskRefs: string[]
  bridgeIds: string[]
  codingIds: string[]
}

export type MailboxFreshnessStatus = "fresh" | "stale" | "unknown"
export type MailboxHealthStatus = "ok" | "degraded"

export interface MailboxIssue {
  code: string
  detail: string
}

export interface MailboxDegradedState {
  status: MailboxHealthStatus
  issues: MailboxIssue[]
}

export interface MailboxFreshness {
  status: MailboxFreshnessStatus
  latestActivityAt: string | null
  ageMs: number | null
}

export interface MailboxTaskSummary {
  totalCount: number
  liveCount: number
  blockedCount: number
  byStatus: Record<TaskStatus, number>
  liveTaskNames: string[]
  actionRequired: string[]
  activeBridges: string[]
}

export interface MailboxObligationItem {
  id: string
  status: string
  content: string
  updatedAt: string
  nextAction: string | null
  origin: { friendId: string; channel: string; key: string } | null
  currentSurface: { kind: string; label: string } | null
}

export interface MailboxObligationSummary {
  openCount: number
  items: MailboxObligationItem[]
}

export interface MailboxSessionItem {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  lastActivityAt: string
  activitySource: "friend-facing" | "mtime-fallback"
}

export interface MailboxSessionSummary {
  liveCount: number
  items: MailboxSessionItem[]
}

export interface MailboxReturnObligationQueueSummary {
  /** Count of return obligations currently in `queued` status (created but not yet drained into a turn). */
  queuedCount: number
  /** Count of return obligations currently in `running` status (drained into the active turn). */
  runningCount: number
  /** Createdat (ms) of the oldest queued/running item, or null if the queue is empty. */
  oldestActiveAt: number | null
}

export interface MailboxInnerSummary {
  visibility: typeof MAILBOX_DEFAULT_INNER_VISIBILITY
  status: InnerJobStatus
  hasPending: boolean
  surfacedSummary: string | null
  origin: { friendId: string; channel: string; key: string; friendName?: string } | null
  obligationStatus: "pending" | "fulfilled" | null
  latestActivityAt: string | null
  /**
   * Held-work-items snapshot: the count and oldest-age of return obligations
   * the inner loop will re-inject into the next turn's prompt. Separate from
   * `hasPending` (which is about pending inbound messages waiting to wake the
   * loop). Empty queue is represented with zero counts and a null age, so
   * the UI can render "nothing held" without consulting two fields.
   */
  returnObligationQueue: MailboxReturnObligationQueueSummary
}

/** Coding summary item — subset of CodingSession for list views */
export type MailboxCodingItem = Pick<CodingSession, "id" | "runner" | "status" | "workdir" | "lastActivityAt"> & {
  checkpoint: string | null
  taskRef: string | null
  originSession: CodingSessionOrigin | null
}

export interface MailboxCodingSummary {
  totalCount: number
  activeCount: number
  blockedCount: number
  items: MailboxCodingItem[]
}

export interface MailboxAgentState {
  productName: typeof MAILBOX_PRODUCT_NAME
  agentName: string
  agentRoot: string
  enabled: boolean
  provider: string | null
  providers?: AgentProviderVisibility | null
  senses: string[]
  freshness: MailboxFreshness
  degraded: MailboxDegradedState
  tasks: MailboxTaskSummary
  obligations: MailboxObligationSummary
  sessions: MailboxSessionSummary
  inner: MailboxInnerSummary
  coding: MailboxCodingSummary
}

export interface MailboxAgentSummary {
  agentName: string
  enabled: boolean
  providers?: AgentProviderVisibility | null
  freshness: MailboxFreshness
  degraded: MailboxDegradedState
  tasks: Pick<MailboxTaskSummary, "liveCount" | "blockedCount">
  obligations: Pick<MailboxObligationSummary, "openCount">
  coding: Pick<MailboxCodingSummary, "activeCount" | "blockedCount">
}

export interface MailboxMachineState {
  productName: typeof MAILBOX_PRODUCT_NAME
  observedAt: string
  runtime: RuntimeMetadata
  agentCount: number
  freshness: MailboxFreshness
  degraded: MailboxDegradedState
  agents: MailboxAgentSummary[]
}

export interface MailboxMachineDaemonSummary {
  status: "running" | "stopped"
  health: "ok" | "warn"
  mode: "dev" | "production"
  socketPath: string
  mailboxUrl: string
  entryPath: string
  workerCount: number
  senseCount: number
}

export interface MailboxMachineTotals {
  agents: number
  enabledAgents: number
  degradedAgents: number
  staleAgents: number
  liveTasks: number
  blockedTasks: number
  openObligations: number
  activeCodingAgents: number
  blockedCodingAgents: number
}

export interface MailboxEntryPoint {
  kind: "web" | "cli"
  label: string
  target: string
}

export type MailboxAttentionLevel = "degraded" | "stale" | "blocked" | "active" | "idle"
/** @deprecated mood is synthetic — will be removed in nerves refactor */
export type MailboxMachineMood = "calm" | "watchful" | "strained"

export interface MailboxAttentionSummary {
  level: MailboxAttentionLevel
  label: string
}

export interface MailboxMachineAgentView extends MailboxAgentSummary {
  attention: MailboxAttentionSummary
}

export interface MailboxMachineOverview {
  productName: typeof MAILBOX_PRODUCT_NAME
  observedAt: string
  primaryEntryPoint: string
  daemon: MailboxMachineDaemonSummary
  runtime: RuntimeMetadata
  freshness: MailboxFreshness
  degraded: MailboxDegradedState
  totals: MailboxMachineTotals
  mood: MailboxMachineMood
  entrypoints: MailboxEntryPoint[]
}

export interface MailboxMachineView {
  overview: MailboxMachineOverview
  agents: MailboxMachineAgentView[]
}

export interface MailboxViewer {
  kind: "human" | "agent-self" | "agent-peer"
  agentName?: string
  innerDetail?: "summary" | "deep"
}

export interface MailboxAgentIdentityView {
  agentName: string
  agentRoot: string
  enabled: boolean
  provider: string | null
  providers?: AgentProviderVisibility | null
  senses: string[]
  freshness: MailboxFreshness
  degraded: MailboxDegradedState
  attention: MailboxAttentionSummary
}

export interface MailboxAgentWorkView {
  tasks: MailboxTaskSummary
  obligations: MailboxObligationSummary
  sessions: MailboxSessionSummary
  coding: MailboxCodingSummary
  bridges: string[]
}

export interface MailboxRecentActivityItem {
  kind: "coding" | "session" | "obligation" | "inner"
  at: string
  label: string
  detail: string
}

export interface MailboxAgentActivityView {
  freshness: MailboxFreshness
  recent: MailboxRecentActivityItem[]
}

export type MailboxAgentInnerView =
  | {
      mode: "summary"
      status: InnerJobStatus
      summary: string | null
      hasPending: boolean
      returnObligationQueue: MailboxReturnObligationQueueSummary
    }
  | {
      mode: "deep"
      status: InnerJobStatus
      summary: string | null
      hasPending: boolean
      origin: MailboxInnerSummary["origin"]
      obligationStatus: MailboxInnerSummary["obligationStatus"]
      returnObligationQueue: MailboxReturnObligationQueueSummary
    }

export interface MailboxAgentView {
  productName: typeof MAILBOX_PRODUCT_NAME
  interactionModel: typeof MAILBOX_RELEASE_INTERACTION_MODEL
  viewer: {
    kind: MailboxViewer["kind"]
    agentName?: string
    innerDetail: "summary" | "deep"
  }
  agent: MailboxAgentIdentityView
  work: MailboxAgentWorkView
  inner: MailboxAgentInnerView
  activity: MailboxAgentActivityView
}

// ---------------------------------------------------------------------------
// Session x-ray: inventory + transcript inspection
// ---------------------------------------------------------------------------

/** Session usage — domain type */
export type MailboxSessionUsage = UsageData

/** Session continuity — derived from domain SessionContinuityState with required fields */
export interface MailboxSessionContinuity {
  mustResolveBeforeHandoff: boolean
  lastFriendActivityAt: string | null
}

export type MailboxSessionReplyState = "needs-reply" | "on-hold" | "monitoring" | "idle"

export interface MailboxSessionInventoryItem {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  lastActivityAt: string
  activitySource: "event-timeline" | "friend-facing" | "mtime-fallback"
  replyState: MailboxSessionReplyState
  messageCount: number
  lastUsage: MailboxSessionUsage | null
  continuity: MailboxSessionContinuity | null
  latestUserExcerpt: string | null
  latestAssistantExcerpt: string | null
  latestToolCallNames: string[]
  estimatedTokens: number | null
}

export interface MailboxSessionInventory {
  totalCount: number
  activeCount: number
  staleCount: number
  items: MailboxSessionInventoryItem[]
}

export type MailboxTranscriptToolCall = SessionEvent["toolCalls"][number]
export type MailboxTranscriptMessage = SessionEvent

function transcriptContentText(content: SessionEvent["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (
      part.type === "text" && typeof part.text === "string"
        ? part.text
        : ""
    ))
    .filter((text) => text.length > 0)
    .join("")
}

export function getMailboxTranscriptMessageText(message: MailboxTranscriptMessage): string {
  return transcriptContentText(message.content)
}

export function getMailboxTranscriptTimestamp(message: MailboxTranscriptMessage): string {
  return message.time.authoredAt ?? message.time.observedAt ?? message.time.recordedAt
}

export interface MailboxSessionTranscript {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  messageCount: number
  lastUsage: MailboxSessionUsage | null
  continuity: MailboxSessionContinuity | null
  messages: MailboxTranscriptMessage[]
}

// ---------------------------------------------------------------------------
// Mail sense surface: read-only mailbox inspection
// ---------------------------------------------------------------------------

export type MailboxMailStatus = "ready" | "auth-required" | "misconfigured" | "not-found" | "error"

export interface MailboxMailFolder {
  id: string
  label: string
  count: number
}

export interface MailboxMailAttachmentSummary {
  filename: string
  contentType: string
  size: number
}

export interface MailboxMailMessageSummary {
  id: string
  subject: string
  from: string[]
  to: string[]
  cc: string[]
  date: string | null
  receivedAt: string
  snippet: string
  placement: "imbox" | "screener" | "discarded" | "quarantine" | "draft" | "sent"
  compartmentKind: "native" | "delegated"
  ownerEmail: string | null
  source: string | null
  recipient: string
  attachmentCount: number
  untrustedContentWarning: string
  provenance: MailboxMailProvenance
}

export interface MailboxMailMessageDetail extends MailboxMailMessageSummary {
  text: string
  htmlAvailable: boolean
  bodyTruncated: boolean
  attachments: MailboxMailAttachmentSummary[]
  access: {
    tool: string
    reason: string
    accessedAt: string
  }
}

export interface MailboxMailProvenance {
  placement: "imbox" | "screener" | "discarded" | "quarantine" | "draft" | "sent"
  compartmentKind: "native" | "delegated"
  ownerEmail: string | null
  source: string | null
  recipient: string
  mailboxId: string
  grantId: string | null
  trustReason: string
}

export interface MailboxMailScreenerCandidate {
  id: string
  messageId: string
  senderEmail: string
  senderDisplay: string
  recipient: string
  source: string | null
  ownerEmail: string | null
  status: "pending" | "allowed" | "discarded" | "quarantined" | "restored"
  placement: "imbox" | "screener" | "discarded" | "quarantine" | "draft" | "sent"
  trustReason: string
  firstSeenAt: string
  lastSeenAt: string
  messageCount: number
}

export interface MailboxMailOutboundPolicyDecision {
  allowed: boolean
  mode: "autonomous" | "confirmation-required" | "blocked" | "confirmed"
  code:
    | "allowed"
    | "explicit-confirmation"
    | "autonomy-policy-disabled"
    | "autonomy-kill-switch"
    | "recipient-not-allowed"
    | "recipient-limit-exceeded"
    | "autonomous-rate-limit"
    | "delegated-send-as-human-not-authorized"
    | "agent-mismatch"
    | "native-mailbox-mismatch"
    | "draft-not-sendable"
  reason: string
  evaluatedAt: string
  recipients: string[]
  fallback: "CONFIRM_SEND" | "none"
  policyId: string | null
  remainingSendsInWindow: number | null
}

export interface MailboxMailOutboundDeliveryEvent {
  provider: "local-sink" | "azure-communication-services"
  providerEventId: string
  providerMessageId: string
  outcome: "accepted" | "delivered" | "bounced" | "suppressed" | "quarantined" | "spam-filtered" | "failed"
  recipient: string | null
  occurredAt: string
  receivedAt: string
  bodySafeSummary: string
  providerStatus: string | null
}

export interface MailboxMailOutboundRecord {
  id: string
  status: "draft" | "sent" | "submitted" | "accepted" | "delivered" | "bounced" | "suppressed" | "quarantined" | "spam-filtered" | "failed"
  mailboxRole: "agent-native-mailbox" | "delegated-human-mailbox"
  sendAuthority: "agent-native"
  ownerEmail: string | null
  source: string | null
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  createdAt: string
  updatedAt: string
  sentAt: string | null
  submittedAt: string | null
  acceptedAt: string | null
  deliveredAt: string | null
  failedAt: string | null
  sendMode: "confirmed" | "autonomous" | null
  policyDecision: MailboxMailOutboundPolicyDecision | null
  provider: string | null
  providerMessageId: string | null
  providerRequestId: string | null
  operationLocation: string | null
  deliveryEvents: MailboxMailOutboundDeliveryEvent[]
  transport: string | null
  reason: string
}

export interface MailboxMailRecoverySummary {
  discardedCount: number
  quarantineCount: number
  undecryptableCount: number
  missingKeyIds: string[]
}

export interface MailboxMailAccessEntry {
  id: string
  messageId: string | null
  threadId: string | null
  tool: string
  reason: string
  mailboxRole: "agent-native-mailbox" | "delegated-human-mailbox" | null
  compartmentKind: "native" | "delegated" | null
  ownerEmail: string | null
  source: string | null
  accessedAt: string
}

export interface MailboxMailView {
  status: MailboxMailStatus
  agentName: string
  mailboxAddress: string | null
  generatedAt: string
  store: {
    kind: "file" | "azure-blob"
    label: string
  } | null
  folders: MailboxMailFolder[]
  messages: MailboxMailMessageSummary[]
  screener: MailboxMailScreenerCandidate[]
  outbound: MailboxMailOutboundRecord[]
  recovery: MailboxMailRecoverySummary
  accessLog: MailboxMailAccessEntry[]
  error: string | null
}

export interface MailboxMailMessageView {
  status: MailboxMailStatus
  agentName: string
  mailboxAddress: string | null
  generatedAt: string
  message: MailboxMailMessageDetail | null
  accessLog: MailboxMailAccessEntry[]
  error: string | null
}

// ---------------------------------------------------------------------------
// Coding deep inspection
// ---------------------------------------------------------------------------

/**
 * Coding failure diagnostics for JSON-safe inspection.
 * Structurally aligned with CodingFailureDiagnostics but uses string for signal
 * (NodeJS.Signals is not JSON-serializable).
 */
export interface MailboxCodingFailureDiagnostics {
  command: string
  args: string[]
  code: number | null
  signal: string | null
  stdoutTail: string
  stderrTail: string
}

/**
 * Full coding session for deep inspection.
 * Structurally aligned with CodingSession but uses null instead of undefined
 * for optional fields (JSON serialization normalizes undefined to null) and
 * string for signal types.
 */
export interface MailboxCodingDeepItem {
  id: string
  runner: CodingSession["runner"]
  status: CodingSession["status"]
  checkpoint: string | null
  taskRef: string | null
  workdir: string
  originSession: CodingSessionOrigin | null
  obligationId: string | null
  scopeFile: string | null
  stateFile: string | null
  artifactPath: string | null
  pid: number | null
  startedAt: string
  lastActivityAt: string
  endedAt: string | null
  restartCount: number
  lastExitCode: number | null
  lastSignal: string | null
  stdoutTail: string
  stderrTail: string
  failure: MailboxCodingFailureDiagnostics | null
}

export interface MailboxCodingDeep {
  totalCount: number
  activeCount: number
  blockedCount: number
  items: MailboxCodingDeepItem[]
}

// ---------------------------------------------------------------------------
// Attention / pending / inbox
// ---------------------------------------------------------------------------

export interface MailboxAttentionQueueItem {
  id: string
  friendId: string
  friendName: string
  channel: string
  key: string
  bridgeId: string | null
  delegatedContent: string
  obligationId: string | null
  source: string
  timestamp: number
}

export interface MailboxPendingChannel {
  friendId: string
  channel: string
  key: string
  messageCount: number
}

export interface MailboxAttentionView {
  queueLength: number
  queueItems: MailboxAttentionQueueItem[]
  pendingChannels: MailboxPendingChannel[]
  returnObligations: MailboxObligationItem[]
}

// ---------------------------------------------------------------------------
// Bridge inventory (deep)
// ---------------------------------------------------------------------------

/** Bridge session ref — domain type re-exported */
export type MailboxBridgeSessionRef = BridgeSessionRef

/** Bridge task link — domain type with loosened mode (string instead of union) */
export type MailboxBridgeTaskLink = Omit<BridgeTaskLink, "mode"> & { mode: string }

/** Bridge for inspection — domain BridgeRecord with loosened lifecycle/runtime (string instead of typed enums) */
export type MailboxBridgeItem = Omit<BridgeRecord, "lifecycle" | "runtime" | "attachedSessions" | "task"> & {
  lifecycle: string
  runtime: string
  attachedSessions: MailboxBridgeSessionRef[]
  task: MailboxBridgeTaskLink | null
}

export interface MailboxBridgeInventory {
  totalCount: number
  activeCount: number
  items: MailboxBridgeItem[]
}

// ---------------------------------------------------------------------------
// Daemon health deep inspection
// ---------------------------------------------------------------------------

import type { SafeModeState, DegradedComponent, AgentHealth, HabitHealth } from "../../nerves/observation"
import type { LogEvent } from "../../nerves/observation"

export type MailboxSafeModeState = SafeModeState
export type MailboxDegradedComponent = DegradedComponent
export type MailboxAgentHealthEntry = AgentHealth
export type MailboxHabitHealthEntry = HabitHealth
export type MailboxLogEntry = LogEvent

export interface MailboxDaemonHealthDeep {
  /**
   * Daemon-wide rollup status. After Layer 1 this is one of the five
   * `DaemonStatus` literals (`healthy`/`partial`/`degraded`/`safe-mode`/
   * `down`) when the cached health file uses the post-Layer-1 vocabulary,
   * or `"unknown"` when the file is absent, malformed, or contains a
   * legacy/unrecognized status string. Mailbox consumers MUST handle
   * `"unknown"` defensively.
   */
  status: DaemonStatus | "unknown"
  mode: string
  pid: number
  startedAt: string
  uptimeSeconds: number
  safeMode: MailboxSafeModeState | null
  degradedComponents: MailboxDegradedComponent[]
  agentHealth: Record<string, MailboxAgentHealthEntry>
  habitHealth: Record<string, MailboxHabitHealthEntry>
}

// ---------------------------------------------------------------------------
// Notes / journal inspection
// ---------------------------------------------------------------------------

export interface MailboxDiaryEntry {
  id: string
  text: string
  source: string
  createdAt: string
}

export interface MailboxJournalEntry {
  filename: string
  preview: string
  mtime: number
}

export interface MailboxNotesView {
  diaryEntryCount: number
  recentDiaryEntries: MailboxDiaryEntry[]
  journalEntryCount: number
  recentJournalEntries: MailboxJournalEntry[]
}

// ---------------------------------------------------------------------------
// Friend / relationship economics
// ---------------------------------------------------------------------------

export interface MailboxFriendSummary {
  friendId: string
  friendName: string
  totalTokens: number
  sessionCount: number
  channels: string[]
  lastActivityAt: string | null
}

export interface MailboxFriendView {
  totalFriends: number
  friends: MailboxFriendSummary[]
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export interface MailboxHabitItem {
  name: string
  title: string
  cadence: string | null
  status: "active" | "paused"
  lastRun: string | null
  bodyExcerpt: string | null
  isDegraded: boolean
  degradedReason: string | null
  isOverdue: boolean
  overdueMs: number | null
}

export interface MailboxHabitView {
  totalCount: number
  activeCount: number
  pausedCount: number
  degradedCount: number
  overdueCount: number
  items: MailboxHabitItem[]
}

// ---------------------------------------------------------------------------
// "What needs me now" — the single brutally clear queue
// ---------------------------------------------------------------------------

export type MailboxUrgencyReason = "owed-reply" | "blocking-obligation" | "stale-delegation" | "broken-return" | "overdue-habit" | "return-ready"

export interface MailboxNeedsMeItem {
  urgency: MailboxUrgencyReason
  label: string
  detail: string
  /** Cross-reference for navigation */
  ref: { tab: string; focus?: string } | null
  ageMs: number | null
}

export interface MailboxNeedsMeView {
  items: MailboxNeedsMeItem[]
}

// ---------------------------------------------------------------------------
// Center of gravity — the "what is the plot right now?" narrative
// ---------------------------------------------------------------------------

export interface MailboxCenterOfGravity {
  summary: string
  currentLane: "idle" | "session-work" | "inner-work" | "coding" | "obligation-pressure" | "habit-cycle"
  activePressures: MailboxPressureItem[]
  waitingOn: MailboxWaitingItem[]
}

export interface MailboxPressureItem {
  kind: "obligation" | "task" | "coding" | "inner" | "attention" | "habit"
  label: string
  urgency: "low" | "medium" | "high"
}

export interface MailboxWaitingItem {
  kind: "friend" | "coding" | "inner" | "bridge"
  who: string
  since: string | null
  detail: string
}

// ---------------------------------------------------------------------------
// Orientation — the "where am I?" packet for daemon inspection
// ---------------------------------------------------------------------------

export interface MailboxResumeHandle {
  sessionLabel: string | null
  lane: string | null
  artifact: string | null
  blockerOrWaitingOn: string | null
  nextAction: string | null
  lastVerifiedCheckpoint: string | null
  confidence: "high" | "medium" | "low"
  codingIdentity: { sessionId: string; runner: string; status: string } | null
}

export interface MailboxOrientationView {
  currentSession: { friendId: string; channel: string; key: string; lastActivityAt: string | null } | null
  centerOfGravity: string
  primaryObligation: {
    id: string
    content: string
    status: string
    nextAction: string | null
    waitingOn: string | null
  } | null
  resumeHandle: MailboxResumeHandle | null
  otherActiveSessions: Array<{
    friendId: string
    friendName: string
    channel: string
    key: string
    lastActivityAt: string
  }>
  rawState: string | null
}

// ---------------------------------------------------------------------------
// Obligations detail — richer than summary, includes origin and primary context
// ---------------------------------------------------------------------------

export interface MailboxObligationDetailItem {
  id: string
  status: string
  content: string
  updatedAt: string
  nextAction: string | null
  origin: { friendId: string; channel: string; key: string } | null
  currentSurface: { kind: string; label: string } | null
  meaning: { waitingOn: string | null } | null
  isPrimary: boolean
}

export interface MailboxObligationDetailView {
  openCount: number
  primaryId: string | null
  primarySelectionReason: string | null
  items: MailboxObligationDetailItem[]
}

// ---------------------------------------------------------------------------
// Changes — cross-session drift detection
// ---------------------------------------------------------------------------

export interface MailboxChangeItem {
  kind: string
  id: string
  from: string | null
  to: string | null
  summary: string
}

export interface MailboxChangesView {
  changeCount: number
  items: MailboxChangeItem[]
  snapshotAge: string | null
  formatted: string
}

// ---------------------------------------------------------------------------
// Coding identity — enriched coding truth
// ---------------------------------------------------------------------------

export interface MailboxCodingIdentity {
  repo: string | null
  worktree: string | null
  branch: string | null
  commit: string | null
  dirty: boolean
  taskRef: string | null
  verificationCommands: string[]
  verificationStatus: "verified-pass" | "verified-fail" | "not-verified"
}

export interface MailboxCodingEnrichedItem {
  id: string
  runner: string
  status: string
  workdir: string
  lastActivityAt: string
  checkpoint: string | null
  taskRef: string | null
  identity: MailboxCodingIdentity | null
}

export interface MailboxCodingEnrichedView {
  totalCount: number
  activeCount: number
  blockedCount: number
  items: MailboxCodingEnrichedItem[]
}

// ---------------------------------------------------------------------------
// Self-fix workflow state
// ---------------------------------------------------------------------------

export interface MailboxSelfFixStep {
  label: string
  status: "done" | "active" | "pending" | "skipped"
  detail: string | null
}

export interface MailboxSelfFixView {
  active: boolean
  currentStep: string | null
  steps: MailboxSelfFixStep[]
}

// ---------------------------------------------------------------------------
// Notes decisions — save/skip judgement log
// ---------------------------------------------------------------------------

export interface MailboxNoteDecision {
  kind: "diary_write" | "save_friend_note" | "note_skip"
  decision: "saved" | "skipped"
  reason: string | null
  excerpt: string | null
  timestamp: string
}

export interface MailboxNoteDecisionView {
  totalCount: number
  items: MailboxNoteDecision[]
}

// ---------------------------------------------------------------------------
// Log / event inspection
// ---------------------------------------------------------------------------

export interface MailboxLogView {
  logPath: string | null
  totalLines: number
  entries: MailboxLogEntry[]
}

// ---------------------------------------------------------------------------
// Continuity — presence, cares, episodes
// ---------------------------------------------------------------------------

export interface MailboxPresenceView {
  self: import("../../arc/presence").AgentPresence | null
  peers: import("../../arc/presence").AgentPresence[]
}

export interface MailboxCareSummary {
  activeCount: number
  items: { id: string; label: string; status: string; salience: string }[]
}

export interface MailboxEpisodeSummary {
  recentCount: number
  items: { id: string; kind: string; summary: string; timestamp: string }[]
}

export interface MailboxContinuityView {
  presence: MailboxPresenceView
  cares: MailboxCareSummary
  episodes: MailboxEpisodeSummary
}
