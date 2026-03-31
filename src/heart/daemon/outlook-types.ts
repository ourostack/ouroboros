import type { CodingSession, CodingSessionOrigin } from "../../nerves/observation"
import type { BridgeRecord, BridgeSessionRef, BridgeTaskLink } from "../../nerves/observation"
import type { TaskStatus, RuntimeMetadata } from "../../nerves/observation"
import type { UsageData } from "../../nerves/observation"
import type { InnerJobStatus } from "./thoughts"

// Re-export domain types through the observation layer
export type { UsageData } from "../../nerves/observation"

export const OUTLOOK_PRODUCT_NAME = "Ouro Outlook" as const
export const OUTLOOK_RELEASE_INTERACTION_MODEL = "read-only" as const
export const OUTLOOK_DEFAULT_INNER_VISIBILITY = "summary" as const
export const OUTLOOK_DEFAULT_PORT = 6876 as const

// ---------------------------------------------------------------------------
// Agent desk preferences — customizable per-agent Outlook surface
// ---------------------------------------------------------------------------

export interface OutlookDeskPrefs {
  /** Agent-written "what I'm carrying" text, shown at top of Overview */
  carrying: string | null
  /** Manual status line override (null = auto-derived) */
  statusLine: string | null
  /** Tab ordering — array of tab IDs in preferred order */
  tabOrder: string[] | null
  /** Starred friend IDs — gravitational relationships shown prominently */
  starredFriends: string[]
  /** Pinned constellations — linked threads the agent cares about */
  pinnedConstellations: OutlookConstellation[]
}

export interface OutlookConstellation {
  label: string
  friendIds: string[]
  taskRefs: string[]
  bridgeIds: string[]
  codingIds: string[]
}

export type OutlookFreshnessStatus = "fresh" | "stale" | "unknown"
export type OutlookHealthStatus = "ok" | "degraded"

export interface OutlookIssue {
  code: string
  detail: string
}

export interface OutlookDegradedState {
  status: OutlookHealthStatus
  issues: OutlookIssue[]
}

export interface OutlookFreshness {
  status: OutlookFreshnessStatus
  latestActivityAt: string | null
  ageMs: number | null
}

export interface OutlookTaskSummary {
  totalCount: number
  liveCount: number
  blockedCount: number
  byStatus: Record<TaskStatus, number>
  liveTaskNames: string[]
  actionRequired: string[]
  activeBridges: string[]
}

export interface OutlookObligationItem {
  id: string
  status: string
  content: string
  updatedAt: string
  nextAction: string | null
  origin: { friendId: string; channel: string; key: string } | null
  currentSurface: { kind: string; label: string } | null
}

export interface OutlookObligationSummary {
  openCount: number
  items: OutlookObligationItem[]
}

export interface OutlookSessionItem {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  lastActivityAt: string
  activitySource: "friend-facing" | "mtime-fallback"
}

export interface OutlookSessionSummary {
  liveCount: number
  items: OutlookSessionItem[]
}

export interface OutlookInnerSummary {
  visibility: typeof OUTLOOK_DEFAULT_INNER_VISIBILITY
  status: InnerJobStatus
  hasPending: boolean
  surfacedSummary: string | null
  origin: { friendId: string; channel: string; key: string; friendName?: string } | null
  obligationStatus: "pending" | "fulfilled" | null
  latestActivityAt: string | null
}

/** Coding summary item — subset of CodingSession for list views */
export type OutlookCodingItem = Pick<CodingSession, "id" | "runner" | "status" | "workdir" | "lastActivityAt"> & {
  checkpoint: string | null
  taskRef: string | null
  originSession: CodingSessionOrigin | null
}

export interface OutlookCodingSummary {
  totalCount: number
  activeCount: number
  blockedCount: number
  items: OutlookCodingItem[]
}

export interface OutlookAgentState {
  productName: typeof OUTLOOK_PRODUCT_NAME
  agentName: string
  agentRoot: string
  enabled: boolean
  provider: string | null
  senses: string[]
  freshness: OutlookFreshness
  degraded: OutlookDegradedState
  tasks: OutlookTaskSummary
  obligations: OutlookObligationSummary
  sessions: OutlookSessionSummary
  inner: OutlookInnerSummary
  coding: OutlookCodingSummary
}

export interface OutlookAgentSummary {
  agentName: string
  enabled: boolean
  freshness: OutlookFreshness
  degraded: OutlookDegradedState
  tasks: Pick<OutlookTaskSummary, "liveCount" | "blockedCount">
  obligations: Pick<OutlookObligationSummary, "openCount">
  coding: Pick<OutlookCodingSummary, "activeCount" | "blockedCount">
}

export interface OutlookMachineState {
  productName: typeof OUTLOOK_PRODUCT_NAME
  observedAt: string
  runtime: RuntimeMetadata
  agentCount: number
  freshness: OutlookFreshness
  degraded: OutlookDegradedState
  agents: OutlookAgentSummary[]
}

export interface OutlookMachineDaemonSummary {
  status: "running" | "stopped"
  health: "ok" | "warn"
  mode: "dev" | "production"
  socketPath: string
  outlookUrl: string
  entryPath: string
  workerCount: number
  senseCount: number
}

export interface OutlookMachineTotals {
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

export interface OutlookEntryPoint {
  kind: "web" | "cli"
  label: string
  target: string
}

export type OutlookAttentionLevel = "degraded" | "stale" | "blocked" | "active" | "idle"
/** @deprecated mood is synthetic — will be removed in nerves refactor */
export type OutlookMachineMood = "calm" | "watchful" | "strained"

export interface OutlookAttentionSummary {
  level: OutlookAttentionLevel
  label: string
}

export interface OutlookMachineAgentView extends OutlookAgentSummary {
  attention: OutlookAttentionSummary
}

export interface OutlookMachineOverview {
  productName: typeof OUTLOOK_PRODUCT_NAME
  observedAt: string
  primaryEntryPoint: string
  daemon: OutlookMachineDaemonSummary
  runtime: RuntimeMetadata
  freshness: OutlookFreshness
  degraded: OutlookDegradedState
  totals: OutlookMachineTotals
  mood: OutlookMachineMood
  entrypoints: OutlookEntryPoint[]
}

export interface OutlookMachineView {
  overview: OutlookMachineOverview
  agents: OutlookMachineAgentView[]
}

export interface OutlookViewer {
  kind: "human" | "agent-self" | "agent-peer"
  agentName?: string
  innerDetail?: "summary" | "deep"
}

export interface OutlookAgentIdentityView {
  agentName: string
  agentRoot: string
  enabled: boolean
  provider: string | null
  senses: string[]
  freshness: OutlookFreshness
  degraded: OutlookDegradedState
  attention: OutlookAttentionSummary
}

export interface OutlookAgentWorkView {
  tasks: OutlookTaskSummary
  obligations: OutlookObligationSummary
  sessions: OutlookSessionSummary
  coding: OutlookCodingSummary
  bridges: string[]
}

export interface OutlookRecentActivityItem {
  kind: "coding" | "session" | "obligation" | "inner"
  at: string
  label: string
  detail: string
}

export interface OutlookAgentActivityView {
  freshness: OutlookFreshness
  recent: OutlookRecentActivityItem[]
}

export type OutlookAgentInnerView =
  | {
      mode: "summary"
      status: InnerJobStatus
      summary: string | null
      hasPending: boolean
    }
  | {
      mode: "deep"
      status: InnerJobStatus
      summary: string | null
      hasPending: boolean
      origin: OutlookInnerSummary["origin"]
      obligationStatus: OutlookInnerSummary["obligationStatus"]
    }

export interface OutlookAgentView {
  productName: typeof OUTLOOK_PRODUCT_NAME
  interactionModel: typeof OUTLOOK_RELEASE_INTERACTION_MODEL
  viewer: {
    kind: OutlookViewer["kind"]
    agentName?: string
    innerDetail: "summary" | "deep"
  }
  agent: OutlookAgentIdentityView
  work: OutlookAgentWorkView
  inner: OutlookAgentInnerView
  activity: OutlookAgentActivityView
}

// ---------------------------------------------------------------------------
// Session x-ray: inventory + transcript inspection
// ---------------------------------------------------------------------------

/** Session usage — domain type */
export type OutlookSessionUsage = UsageData

/** Session continuity — derived from domain SessionContinuityState with required fields */
export interface OutlookSessionContinuity {
  mustResolveBeforeHandoff: boolean
  lastFriendActivityAt: string | null
}

export type OutlookSessionReplyState = "needs-reply" | "on-hold" | "monitoring" | "idle"

export interface OutlookSessionInventoryItem {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  lastActivityAt: string
  activitySource: "friend-facing" | "mtime-fallback"
  replyState: OutlookSessionReplyState
  messageCount: number
  lastUsage: OutlookSessionUsage | null
  continuity: OutlookSessionContinuity | null
  latestUserExcerpt: string | null
  latestAssistantExcerpt: string | null
  latestToolCallNames: string[]
  estimatedTokens: number | null
}

export interface OutlookSessionInventory {
  totalCount: number
  activeCount: number
  staleCount: number
  items: OutlookSessionInventoryItem[]
}

export interface OutlookTranscriptToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export interface OutlookTranscriptMessage {
  index: number
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: OutlookTranscriptToolCall[]
}

export interface OutlookSessionTranscript {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  messageCount: number
  lastUsage: OutlookSessionUsage | null
  continuity: OutlookSessionContinuity | null
  messages: OutlookTranscriptMessage[]
}

// ---------------------------------------------------------------------------
// Coding deep inspection
// ---------------------------------------------------------------------------

/**
 * Coding failure diagnostics for JSON-safe inspection.
 * Structurally aligned with CodingFailureDiagnostics but uses string for signal
 * (NodeJS.Signals is not JSON-serializable).
 */
export interface OutlookCodingFailureDiagnostics {
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
export interface OutlookCodingDeepItem {
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
  failure: OutlookCodingFailureDiagnostics | null
}

export interface OutlookCodingDeep {
  totalCount: number
  activeCount: number
  blockedCount: number
  items: OutlookCodingDeepItem[]
}

// ---------------------------------------------------------------------------
// Attention / pending / inbox
// ---------------------------------------------------------------------------

export interface OutlookAttentionQueueItem {
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

export interface OutlookPendingChannel {
  friendId: string
  channel: string
  key: string
  messageCount: number
}

export interface OutlookAttentionView {
  queueLength: number
  queueItems: OutlookAttentionQueueItem[]
  pendingChannels: OutlookPendingChannel[]
  returnObligations: OutlookObligationItem[]
}

// ---------------------------------------------------------------------------
// Bridge inventory (deep)
// ---------------------------------------------------------------------------

/** Bridge session ref — domain type re-exported */
export type OutlookBridgeSessionRef = BridgeSessionRef

/** Bridge task link — domain type with loosened mode (string instead of union) */
export type OutlookBridgeTaskLink = Omit<BridgeTaskLink, "mode"> & { mode: string }

/** Bridge for inspection — domain BridgeRecord with loosened lifecycle/runtime (string instead of typed enums) */
export type OutlookBridgeItem = Omit<BridgeRecord, "lifecycle" | "runtime" | "attachedSessions" | "task"> & {
  lifecycle: string
  runtime: string
  attachedSessions: OutlookBridgeSessionRef[]
  task: OutlookBridgeTaskLink | null
}

export interface OutlookBridgeInventory {
  totalCount: number
  activeCount: number
  items: OutlookBridgeItem[]
}

// ---------------------------------------------------------------------------
// Daemon health deep inspection
// ---------------------------------------------------------------------------

import type { SafeModeState, DegradedComponent, AgentHealth, HabitHealth } from "../../nerves/observation"
import type { LogEvent } from "../../nerves/observation"

export type OutlookSafeModeState = SafeModeState
export type OutlookDegradedComponent = DegradedComponent
export type OutlookAgentHealthEntry = AgentHealth
export type OutlookHabitHealthEntry = HabitHealth
export type OutlookLogEntry = LogEvent

export interface OutlookDaemonHealthDeep {
  status: string
  mode: string
  pid: number
  startedAt: string
  uptimeSeconds: number
  safeMode: OutlookSafeModeState | null
  degradedComponents: OutlookDegradedComponent[]
  agentHealth: Record<string, OutlookAgentHealthEntry>
  habitHealth: Record<string, OutlookHabitHealthEntry>
}

// ---------------------------------------------------------------------------
// Memory / journal inspection
// ---------------------------------------------------------------------------

export interface OutlookDiaryEntry {
  id: string
  text: string
  source: string
  createdAt: string
}

export interface OutlookJournalEntry {
  filename: string
  preview: string
  mtime: number
}

export interface OutlookMemoryView {
  diaryEntryCount: number
  recentDiaryEntries: OutlookDiaryEntry[]
  journalEntryCount: number
  recentJournalEntries: OutlookJournalEntry[]
}

// ---------------------------------------------------------------------------
// Friend / relationship economics
// ---------------------------------------------------------------------------

export interface OutlookFriendSummary {
  friendId: string
  friendName: string
  totalTokens: number
  sessionCount: number
  channels: string[]
  lastActivityAt: string | null
}

export interface OutlookFriendView {
  totalFriends: number
  friends: OutlookFriendSummary[]
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export interface OutlookHabitItem {
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

export interface OutlookHabitView {
  totalCount: number
  activeCount: number
  pausedCount: number
  degradedCount: number
  overdueCount: number
  items: OutlookHabitItem[]
}

// ---------------------------------------------------------------------------
// "What needs me now" — the single brutally clear queue
// ---------------------------------------------------------------------------

export type OutlookUrgencyReason = "owed-reply" | "blocking-obligation" | "stale-delegation" | "broken-return" | "overdue-habit" | "return-ready"

export interface OutlookNeedsMeItem {
  urgency: OutlookUrgencyReason
  label: string
  detail: string
  /** Cross-reference for navigation */
  ref: { tab: string; focus?: string } | null
  ageMs: number | null
}

export interface OutlookNeedsMeView {
  items: OutlookNeedsMeItem[]
}

// ---------------------------------------------------------------------------
// Center of gravity — the "what is the plot right now?" narrative
// ---------------------------------------------------------------------------

export interface OutlookCenterOfGravity {
  summary: string
  currentLane: "idle" | "session-work" | "inner-work" | "coding" | "obligation-pressure" | "habit-cycle"
  activePressures: OutlookPressureItem[]
  waitingOn: OutlookWaitingItem[]
}

export interface OutlookPressureItem {
  kind: "obligation" | "task" | "coding" | "inner" | "attention" | "habit"
  label: string
  urgency: "low" | "medium" | "high"
}

export interface OutlookWaitingItem {
  kind: "friend" | "coding" | "inner" | "bridge"
  who: string
  since: string | null
  detail: string
}

// ---------------------------------------------------------------------------
// Log / event inspection
// ---------------------------------------------------------------------------

export interface OutlookLogView {
  logPath: string | null
  totalLines: number
  entries: OutlookLogEntry[]
}
