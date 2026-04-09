import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot } from "../identity"
import { isOpenObligation, readPendingObligations, readObligations } from "../../arc/obligations"
import type { TaskStatus } from "../../arc/task-lifecycle"
import { listSessionActivity } from "../session-activity"
import { buildTaskBoard } from "../../repertoire/tasks/board"
import { scanTasks } from "../../repertoire/tasks/scanner"
import { listEnabledBundleAgents } from "../daemon/agent-discovery"
import { getRuntimeMetadata, type RuntimeMetadata } from "../daemon/runtime-metadata"
import { deriveInnerJob, formatSurfacedValue, getInnerDialogSessionPath, readInnerDialogRawData } from "../daemon/thoughts"
import {
  OUTLOOK_DEFAULT_INNER_VISIBILITY,
  OUTLOOK_PRODUCT_NAME,
  type OutlookAgentState,
  type OutlookAgentSummary,
  type OutlookAttentionQueueItem,
  type OutlookAttentionView,
  type OutlookBridgeInventory,
  type OutlookBridgeItem,
  type OutlookCodingDeep,
  type OutlookCodingDeepItem,
  type OutlookCodingItem,
  type OutlookDaemonHealthDeep,
  type OutlookDegradedState,
  type OutlookDiaryEntry,
  type OutlookFreshness,
  type OutlookFriendSummary,
  type OutlookFriendView,
  type OutlookHabitItem,
  type OutlookHabitView,
  type OutlookIssue,
  type OutlookJournalEntry,
  type OutlookLogEntry,
  type OutlookLogView,
  type OutlookMachineState,
  type OutlookMemoryView,
  type OutlookObligationItem,
  type OutlookPendingChannel,
  type OutlookSessionContinuity,
  type OutlookSessionInventory,
  type OutlookSessionInventoryItem,
  type OutlookSessionItem,
  type OutlookSessionTranscript,
  type OutlookSessionUsage,
  type OutlookTaskSummary,
  type OutlookTranscriptMessage,
  type OutlookTranscriptToolCall,
  type OutlookContinuityView,
  type OutlookOrientationView,
  type OutlookObligationDetailView,
  type OutlookObligationDetailItem,
  type OutlookChangesView,
  type OutlookSelfFixView,
  type OutlookSelfFixStep,
  type OutlookMemoryDecisionView,
  type OutlookMemoryDecision,
} from "./outlook-types"
import { readPresence, readPeerPresence } from "../../arc/presence"
import { readActiveCares } from "../../arc/cares"
import { readRecentEpisodes } from "../../arc/episodes"

interface OutlookReadOptions {
  bundlesRoot?: string
  now?: () => Date
  runtimeMetadata?: RuntimeMetadata
  agentNames?: string[]
}

const LIVE_TASK_STATUSES: TaskStatus[] = ["processing", "validating", "collaborating", "blocked"]
const ACTIVE_CODING_STATUSES = new Set(["spawning", "running", "waiting_input", "stalled"])
const BLOCKED_CODING_STATUSES = new Set(["waiting_input", "stalled"])
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000

interface AgentConfigSummary {
  enabled: boolean
  provider: string | null
  senses: string[]
}

function issue(code: string, detail: string): OutlookIssue {
  return { code, detail }
}

function emptyByStatus(): Record<TaskStatus, number> {
  return {
    drafting: 0,
    processing: 0,
    validating: 0,
    collaborating: 0,
    paused: 0,
    blocked: 0,
    cancelled: 0,
    done: 0,
  }
}

function readAgentConfig(agentRoot: string): { summary: AgentConfigSummary; issues: OutlookIssue[] } {
  const configPath = path.join(agentRoot, "agent.json")
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      enabled?: unknown
      provider?: unknown
      senses?: Record<string, { enabled?: unknown }>
    }

    const senses = Object.entries(parsed.senses ?? {})
      .filter(([, value]) => value && typeof value.enabled === "boolean" && value.enabled)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right))

    return {
      summary: {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
        provider: typeof parsed.provider === "string" ? parsed.provider : null,
        senses,
      },
      issues: [],
    }
  } catch (error) {
    return {
      summary: {
        enabled: false,
        provider: null,
        senses: [],
      },
      issues: [issue("agent-config-unreadable", `${configPath}: ${error instanceof Error ? error.message : String(error)}`)],
    }
  }
}

function readTaskSummary(agentRoot: string): { summary: OutlookTaskSummary; issues: OutlookIssue[] } {
  const taskRoot = path.join(agentRoot, "tasks")
  const index = scanTasks(taskRoot)
  const board = buildTaskBoard(index)
  const byStatus = emptyByStatus()

  for (const status of Object.keys(byStatus) as TaskStatus[]) {
    byStatus[status] = board.byStatus[status].length
  }

  const liveTaskNames = LIVE_TASK_STATUSES.flatMap((status) => board.byStatus[status])
  const issues: OutlookIssue[] = index.issues.map((taskIssue) =>
    issue(taskIssue.code, `${taskIssue.target}: ${taskIssue.description}`)
  )

  return {
    summary: {
      totalCount: index.tasks.length,
      liveCount: liveTaskNames.length,
      blockedCount: board.byStatus.blocked.length,
      byStatus,
      liveTaskNames,
      actionRequired: [...board.actionRequired],
      activeBridges: [...board.activeBridges],
    },
    issues,
  }
}

function readObligationSummary(agentRoot: string): { items: OutlookObligationItem[] } {
  const items = readPendingObligations(agentRoot)
    .map((obligation) => ({
      id: obligation.id,
      status: obligation.status,
      content: obligation.content,
      updatedAt: obligation.updatedAt ?? obligation.createdAt,
      nextAction: obligation.nextAction ?? null,
      /* v8 ignore start */
      origin: obligation.origin ?? null,
      currentSurface: obligation.currentSurface ?? null,
      /* v8 ignore stop */
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return { items }
}

function readSessionSummary(agentName: string, agentRoot: string, now: Date): { items: OutlookSessionItem[] } {
  const items = listSessionActivity({
    sessionsDir: path.join(agentRoot, "state", "sessions"),
    friendsDir: path.join(agentRoot, "friends"),
    agentName,
    nowMs: now.getTime(),
  })
    .filter((session) => !(session.friendId === "self" && session.channel === "inner"))
    .map((session) => ({
      friendId: session.friendId,
      friendName: session.friendName,
      channel: session.channel,
      key: session.key,
      sessionPath: session.sessionPath,
      lastActivityAt: session.lastActivityAt,
      activitySource: session.activitySource,
    }))

  return { items }
}

function readInnerSummary(agentRoot: string): {
  summary: OutlookAgentState["inner"]
  issues: OutlookIssue[]
  latestActivityAt: string | null
} {
  const sessionPath = getInnerDialogSessionPath(agentRoot)
  const pendingDir = path.join(agentRoot, "state", "pending", "self", "inner", "dialog")
  const { pendingMessages, turns, runtimeState } = readInnerDialogRawData(sessionPath, pendingDir)
  const job = deriveInnerJob(pendingMessages, turns, runtimeState)
  const surfacedSummary = job.surfacedResult ? formatSurfacedValue(job.surfacedResult) : null
  const latestPendingTimestamp = pendingMessages.length > 0
    ? new Date(Math.max(...pendingMessages.map((message) => message.timestamp))).toISOString()
    : null
  const latestActivityAt = latestPendingTimestamp
    ?? runtimeState?.startedAt
    ?? runtimeState?.lastCompletedAt
    ?? null

  return {
    summary: {
      visibility: OUTLOOK_DEFAULT_INNER_VISIBILITY,
      status: job.status,
      hasPending: pendingMessages.length > 0,
      surfacedSummary,
      origin: job.origin,
      obligationStatus: job.obligationStatus,
      latestActivityAt,
    },
    issues: [],
    latestActivityAt,
  }
}

function readCodingSummary(agentRoot: string): {
  items: OutlookCodingItem[]
  issues: OutlookIssue[]
} {
  const stateFilePath = path.join(agentRoot, "state", "coding", "sessions.json")
  const issues: OutlookIssue[] = []

  if (!fs.existsSync(stateFilePath)) {
    return { items: [], issues }
  }

  let parsed: { records?: Array<{ session?: Record<string, unknown> }> }
  try {
    parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf-8")) as { records?: Array<{ session?: Record<string, unknown> }> }
  } catch (error) {
    issues.push(issue("coding-state-unreadable", `${stateFilePath}: ${error instanceof Error ? error.message : String(error)}`))
    return { items: [], issues }
  }

  const items = Array.isArray(parsed.records)
    ? parsed.records.flatMap((record) => {
      const session = record?.session
      if (!session || typeof session.id !== "string" || typeof session.runner !== "string" || typeof session.status !== "string" || typeof session.workdir !== "string" || typeof session.lastActivityAt !== "string") {
        return []
      }

      const checkpoint = typeof session.checkpoint === "string"
        ? session.checkpoint
        : typeof session.stderrTail === "string" && session.stderrTail.trim().length > 0
          ? session.stderrTail.trim()
          : typeof session.stdoutTail === "string" && session.stdoutTail.trim().length > 0
            ? session.stdoutTail.trim()
            : null

      const originSession = session.originSession as Record<string, unknown> | undefined
      const normalizedOrigin = originSession
        && typeof originSession.friendId === "string"
        && typeof originSession.channel === "string"
        && typeof originSession.key === "string"
        ? {
            friendId: originSession.friendId,
            channel: originSession.channel,
            key: originSession.key,
          }
        : null

      return [{
        id: session.id,
        runner: session.runner as OutlookCodingItem["runner"],
        status: session.status as OutlookCodingItem["status"],
        checkpoint,
        taskRef: typeof session.taskRef === "string" ? session.taskRef : null,
        workdir: session.workdir,
        originSession: normalizedOrigin,
        lastActivityAt: session.lastActivityAt,
      }]
    })
    : []

  return { items, issues }
}

function collectLatestActivityTimestamps(input: {
  obligations: OutlookObligationItem[]
  sessions: OutlookSessionItem[]
  innerLatestActivityAt: string | null
  coding: OutlookCodingItem[]
}): string[] {
  const timestamps: string[] = []

  for (const item of input.obligations) timestamps.push(item.updatedAt)
  for (const item of input.sessions) timestamps.push(item.lastActivityAt)
  for (const item of input.coding) timestamps.push(item.lastActivityAt)
  if (input.innerLatestActivityAt) timestamps.push(input.innerLatestActivityAt)

  return timestamps
    .filter((value) => Number.isFinite(Date.parse(value)))
}

function summarizeFreshness(latestActivityAt: string | null, now: Date): OutlookFreshness {
  if (!latestActivityAt) {
    return {
      status: "unknown",
      latestActivityAt: null,
      ageMs: null,
    }
  }

  const ageMs = now.getTime() - Date.parse(latestActivityAt)
  return {
    status: ageMs > STALE_THRESHOLD_MS ? "stale" : "fresh",
    latestActivityAt,
    ageMs,
  }
}

function summarizeDegraded(issues: OutlookIssue[]): OutlookDegradedState {
  return {
    status: issues.length > 0 ? "degraded" : "ok",
    issues,
  }
}

function summarizeAgent(state: OutlookAgentState): OutlookAgentSummary {
  return {
    agentName: state.agentName,
    enabled: state.enabled,
    freshness: state.freshness,
    degraded: state.degraded,
    tasks: {
      liveCount: state.tasks.liveCount,
      blockedCount: state.tasks.blockedCount,
    },
    obligations: {
      openCount: state.obligations.openCount,
    },
    coding: {
      activeCount: state.coding.activeCount,
      blockedCount: state.coding.blockedCount,
    },
  }
}

export function readOutlookAgentState(agentName: string, options: OutlookReadOptions = {}): OutlookAgentState {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const issues: OutlookIssue[] = []

  const config = readAgentConfig(agentRoot)
  issues.push(...config.issues)

  const tasks = readTaskSummary(agentRoot)
  issues.push(...tasks.issues)

  const obligations = readObligationSummary(agentRoot)
  const sessions = readSessionSummary(agentName, agentRoot, now)
  const inner = readInnerSummary(agentRoot)
  issues.push(...inner.issues)

  const coding = readCodingSummary(agentRoot)
  issues.push(...coding.issues)

  const latestActivityAt = collectLatestActivityTimestamps({
    obligations: obligations.items,
    sessions: sessions.items,
    innerLatestActivityAt: inner.latestActivityAt,
    coding: coding.items,
  }).sort((left, right) => right.localeCompare(left))[0] ?? null

  return {
    productName: OUTLOOK_PRODUCT_NAME,
    agentName,
    agentRoot,
    enabled: config.summary.enabled,
    provider: config.summary.provider,
    senses: config.summary.senses,
    freshness: summarizeFreshness(latestActivityAt, now),
    degraded: summarizeDegraded(issues),
    tasks: tasks.summary,
    obligations: {
      openCount: obligations.items.length,
      items: obligations.items,
    },
    sessions: {
      liveCount: sessions.items.length,
      items: sessions.items,
    },
    inner: inner.summary,
    coding: {
      totalCount: coding.items.length,
      activeCount: coding.items.filter((item) => ACTIVE_CODING_STATUSES.has(item.status)).length,
      blockedCount: coding.items.filter((item) => BLOCKED_CODING_STATUSES.has(item.status)).length,
      items: coding.items,
    },
  }
}

export function readOutlookMachineState(options: OutlookReadOptions = {}): OutlookMachineState {
  /* v8 ignore next */
  emitNervesEvent({ component: "daemon", event: "daemon.outlook_read", message: "reading outlook machine state", meta: {} })
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const runtime = options.runtimeMetadata ?? getRuntimeMetadata({ bundlesRoot })
  const agentNames = options.agentNames ?? listEnabledBundleAgents({ bundlesRoot })
  const agentStates = agentNames.map((agentName) => readOutlookAgentState(agentName, { ...options, bundlesRoot, now: () => now }))
  const degradedIssues = agentStates
    .flatMap((state) => state.degraded.issues.map((problem) => issue("agent-degraded", `${state.agentName}: ${problem.detail}`)))
  const freshest = agentStates
    .map((state) => state.freshness.latestActivityAt)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => right.localeCompare(left))[0] ?? null

  return {
    productName: OUTLOOK_PRODUCT_NAME,
    observedAt: now.toISOString(),
    runtime,
    agentCount: agentStates.length,
    freshness: summarizeFreshness(freshest, now),
    degraded: summarizeDegraded(degradedIssues),
    agents: agentStates.map(summarizeAgent),
  }
}

// ---------------------------------------------------------------------------
// Session inventory — enumerate all sessions with summary metadata
// ---------------------------------------------------------------------------

interface SessionEnvelope {
  version?: number
  messages?: Array<Record<string, unknown>>
  lastUsage?: Record<string, unknown>
  state?: Record<string, unknown>
}

/* v8 ignore start — session envelope parsing utilities */
function parseSessionUsage(raw: Record<string, unknown> | undefined): OutlookSessionUsage | null {
  if (!raw) return null
  const inputTokens = typeof raw.input_tokens === "number" ? raw.input_tokens : 0
  const outputTokens = typeof raw.output_tokens === "number" ? raw.output_tokens : 0
  const reasoningTokens = typeof raw.reasoning_tokens === "number" ? raw.reasoning_tokens : 0
  const totalTokens = typeof raw.total_tokens === "number" ? raw.total_tokens : 0
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null
  return { input_tokens: inputTokens, output_tokens: outputTokens, reasoning_tokens: reasoningTokens, total_tokens: totalTokens }
}

function parseSessionContinuity(raw: Record<string, unknown> | undefined): OutlookSessionContinuity | null {
  if (!raw) return null
  return {
    mustResolveBeforeHandoff: raw.mustResolveBeforeHandoff === true,
    lastFriendActivityAt: typeof raw.lastFriendActivityAt === "string" ? raw.lastFriendActivityAt : null,
  }
}

function extractContent(message: Record<string, unknown>): string | null {
  if (typeof message.content === "string") return message.content
  return null
}

function extractToolCallNames(message: Record<string, unknown>): string[] {
  const toolCalls = message.tool_calls
  if (!Array.isArray(toolCalls)) return []
  return toolCalls
    .map((call) => {
      if (call && typeof call === "object" && "function" in call) {
        const fn = (call as Record<string, unknown>).function
        if (fn && typeof fn === "object" && "name" in fn) {
          return typeof (fn as Record<string, unknown>).name === "string" ? (fn as Record<string, unknown>).name as string : null
        }
      }
      /* v8 ignore start */
      return null
      /* v8 ignore stop */
    })
    .filter((name): name is string => name !== null)
}

/* v8 ignore stop */

function estimateTokenCount(messages: Array<Record<string, unknown>>): number {
  let charCount = 0
  for (const msg of messages) {
    const content = extractContent(msg)
    if (content) charCount += content.length
    const toolCalls = msg.tool_calls
    if (Array.isArray(toolCalls)) {
      charCount += JSON.stringify(toolCalls).length
    }
  }
  return Math.ceil(charCount / 4)
}

function readSessionEnvelope(sessionPath: string): SessionEnvelope | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8")
    return JSON.parse(raw) as SessionEnvelope
  } catch {
    return null
  }
}

/* v8 ignore start — filesystem traversal with defensive isDirectory checks */
function resolveAllSessionPaths(sessionsDir: string): Array<{ friendId: string; channel: string; key: string; sessionPath: string }> {
  const results: Array<{ friendId: string; channel: string; key: string; sessionPath: string }> = []
  if (!fs.existsSync(sessionsDir)) return results

  for (const friendId of safeReaddir(sessionsDir)) {
    const friendDir = path.join(sessionsDir, friendId)
    if (!safeIsDirectory(friendDir)) continue
    for (const channel of safeReaddir(friendDir)) {
      const channelDir = path.join(friendDir, channel)
      if (!safeIsDirectory(channelDir)) continue
      for (const file of safeReaddir(channelDir)) {
        if (!file.endsWith(".json")) continue
        const key = file.slice(0, -5)
        results.push({
          friendId,
          channel,
          key,
          sessionPath: path.join(channelDir, file),
        })
      }
    }
  }
  return results
}

/* v8 ignore stop */

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function safeIsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory()
  /* v8 ignore start */
  } catch {
    return false
  }
  /* v8 ignore stop */
}

/* v8 ignore start — defensive friend name resolution */
function resolveFriendName(friendsDir: string, friendId: string): string {
  try {
    const raw = fs.readFileSync(path.join(friendsDir, `${friendId}.json`), "utf-8")
    const parsed = JSON.parse(raw) as { name?: unknown }
    return typeof parsed.name === "string" ? parsed.name : friendId
  } catch {
    return friendId
  }
}

/* v8 ignore stop */

/* v8 ignore start — session inventory with defensive parsing */
export function readSessionInventory(agentName: string, options: OutlookReadOptions = {}): OutlookSessionInventory {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const sessionsDir = path.join(agentRoot, "state", "sessions")
  const friendsDir = path.join(agentRoot, "friends")

  const allSessions = resolveAllSessionPaths(sessionsDir)
  const items: OutlookSessionInventoryItem[] = []

  for (const { friendId, channel, key, sessionPath } of allSessions) {
    if (friendId === "self" && channel === "inner") continue

    const envelope = readSessionEnvelope(sessionPath)
    const messages = Array.isArray(envelope?.messages) ? envelope.messages : []
    const lastUsage = parseSessionUsage(envelope?.lastUsage as Record<string, unknown> | undefined)
    const continuity = parseSessionContinuity(envelope?.state as Record<string, unknown> | undefined)

    const lastActivityAt = continuity?.lastFriendActivityAt ?? safeFileMtime(sessionPath) ?? now.toISOString()
    const activitySource: "friend-facing" | "mtime-fallback" = continuity?.lastFriendActivityAt ? "friend-facing" : "mtime-fallback"

    const userMessages = messages.filter((m) => m.role === "user")
    const assistantMessages = messages.filter((m) => m.role === "assistant")
    const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1]! : null
    const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1]! : null

    const latestToolCallNames: string[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const names = extractToolCallNames(messages[i]!)
      if (names.length > 0) {
        latestToolCallNames.push(...names)
        break
      }
    }

    const friendName = resolveFriendName(friendsDir, friendId)

    // Derive reply state from message pattern
    const lastMsg = messages.length > 0 ? messages[messages.length - 1]! : null
    const mustResolve = continuity?.mustResolveBeforeHandoff === true
    let replyState: "needs-reply" | "on-hold" | "monitoring" | "idle" = "idle"
    if (mustResolve) {
      replyState = "on-hold"
    } else if (lastMsg?.role === "user") {
      replyState = "needs-reply"
    } else if (messages.length > 0) {
      replyState = "monitoring"
    }

    items.push({
      friendId,
      friendName,
      channel,
      key,
      sessionPath,
      lastActivityAt,
      activitySource,
      replyState,
      messageCount: messages.length,
      lastUsage,
      continuity,
      latestUserExcerpt: truncateExcerpt(extractContent(lastUser ?? {})),
      latestAssistantExcerpt: truncateExcerpt(extractContent(lastAssistant ?? {})),
      latestToolCallNames,
      estimatedTokens: messages.length > 0 ? estimateTokenCount(messages) : null,
    })
  }

  items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))

  const ageThreshold = now.getTime() - STALE_THRESHOLD_MS
  const activeCount = items.filter((item) => Date.parse(item.lastActivityAt) >= ageThreshold).length

  return {
    totalCount: items.length,
    activeCount,
    staleCount: items.length - activeCount,
    items,
  }
}

/* v8 ignore start — utility helpers with defensive branches */
function truncateExcerpt(content: string | null, maxLength = 200): string | null {
  if (!content) return null
  if (content.length <= maxLength) return content
  const truncated = content.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated) + "…"
}

function safeFileMtime(filePath: string): string | null {
  try {
    return fs.statSync(filePath).mtime.toISOString()
  } catch {
    return null
  }
}

/* v8 ignore stop */

// ---------------------------------------------------------------------------
/* v8 ignore stop */

// Session transcript — full x-ray of one session
// ---------------------------------------------------------------------------

/* v8 ignore start — defensive parsing */
export function readSessionTranscript(
  agentName: string,
  friendId: string,
  channel: string,
  key: string,
  options: OutlookReadOptions = {},
): OutlookSessionTranscript | null {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const sessionPath = path.join(agentRoot, "state", "sessions", friendId, channel, `${key}.json`)

  const envelope = readSessionEnvelope(sessionPath)
  if (!envelope) return null

  const rawMessages = Array.isArray(envelope.messages) ? envelope.messages : []
  const friendsDir = path.join(agentRoot, "friends")
  const friendName = resolveFriendName(friendsDir, friendId)

  const messages: OutlookTranscriptMessage[] = rawMessages.map((msg, index) => {
    const role = typeof msg.role === "string" ? msg.role as OutlookTranscriptMessage["role"] : "user"
    const content = extractContent(msg)
    const result: OutlookTranscriptMessage = { index, role, content }

    if (typeof msg.name === "string") result.name = msg.name
    if (typeof msg.tool_call_id === "string") result.tool_call_id = msg.tool_call_id

    if (Array.isArray(msg.tool_calls)) {
      result.tool_calls = msg.tool_calls
        .filter((call): call is Record<string, unknown> => call != null && typeof call === "object")
        .map((call) => {
          const fn = call.function as Record<string, unknown> | undefined
          return {
            id: typeof call.id === "string" ? call.id : "",
            type: typeof call.type === "string" ? call.type : "function",
            function: {
              name: typeof fn?.name === "string" ? fn.name : "unknown",
              arguments: typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? ""),
            },
          } satisfies OutlookTranscriptToolCall
        })
    }

    return result
  })

  return {
    friendId,
    friendName,
    channel,
    key,
    sessionPath,
    messageCount: messages.length,
    lastUsage: parseSessionUsage(envelope.lastUsage as Record<string, unknown> | undefined),
    continuity: parseSessionContinuity(envelope.state as Record<string, unknown> | undefined),
    messages,
  }
}

// ---------------------------------------------------------------------------
// Coding deep — full details for all coding sessions
// ---------------------------------------------------------------------------

/* v8 ignore start — defensive parsing of on-disk JSON, fallback branches are safety nets */
export function readCodingDeep(agentRoot: string): OutlookCodingDeep {
  const stateFilePath = path.join(agentRoot, "state", "coding", "sessions.json")

  if (!fs.existsSync(stateFilePath)) {
    return { totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }
  }

  let parsed: { records?: Array<{ session?: Record<string, unknown> }> }
  try {
    parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf-8")) as typeof parsed
  } catch {
    return { totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }
  }

  const items: OutlookCodingDeepItem[] = Array.isArray(parsed.records)
    ? parsed.records.flatMap((record) => {
      const s = record?.session
      if (!s || typeof s.id !== "string" || typeof s.status !== "string") return []

      const checkpoint = typeof s.checkpoint === "string" ? s.checkpoint
        : typeof s.stderrTail === "string" && s.stderrTail.trim().length > 0 ? s.stderrTail.trim()
          : typeof s.stdoutTail === "string" && s.stdoutTail.trim().length > 0 ? s.stdoutTail.trim()
            : null

      const originSession = s.originSession as Record<string, unknown> | undefined
      const normalizedOrigin = originSession
        && typeof originSession.friendId === "string"
        && typeof originSession.channel === "string"
        && typeof originSession.key === "string"
        ? { friendId: originSession.friendId, channel: originSession.channel, key: originSession.key }
        : null

      const failure = s.failure as Record<string, unknown> | null | undefined
      const normalizedFailure = failure && typeof failure === "object"
        ? {
            command: typeof failure.command === "string" ? failure.command : "",
            args: Array.isArray(failure.args) ? failure.args.map(String) : [],
            code: typeof failure.code === "number" ? failure.code : null,
            signal: typeof failure.signal === "string" ? failure.signal : null,
            stdoutTail: typeof failure.stdoutTail === "string" ? failure.stdoutTail : "",
            stderrTail: typeof failure.stderrTail === "string" ? failure.stderrTail : "",
          }
        : null

      return [{
        id: s.id,
        runner: (typeof s.runner === "string" ? s.runner : "claude") as OutlookCodingDeepItem["runner"],
        status: s.status as OutlookCodingDeepItem["status"],
        checkpoint,
        taskRef: typeof s.taskRef === "string" ? s.taskRef : null,
        workdir: typeof s.workdir === "string" ? s.workdir : "",
        originSession: normalizedOrigin,
        obligationId: typeof s.obligationId === "string" ? s.obligationId : null,
        scopeFile: typeof s.scopeFile === "string" ? s.scopeFile : null,
        stateFile: typeof s.stateFile === "string" ? s.stateFile : null,
        artifactPath: typeof s.artifactPath === "string" ? s.artifactPath : null,
        pid: typeof s.pid === "number" ? s.pid : null,
        startedAt: typeof s.startedAt === "string" ? s.startedAt : "",
        lastActivityAt: typeof s.lastActivityAt === "string" ? s.lastActivityAt : "",
        endedAt: typeof s.endedAt === "string" ? s.endedAt : null,
        restartCount: typeof s.restartCount === "number" ? s.restartCount : 0,
        lastExitCode: typeof s.lastExitCode === "number" ? s.lastExitCode : null,
        lastSignal: typeof s.lastSignal === "string" ? s.lastSignal : null,
        stdoutTail: typeof s.stdoutTail === "string" ? s.stdoutTail : "",
        stderrTail: typeof s.stderrTail === "string" ? s.stderrTail : "",
        failure: normalizedFailure,
      }]
    })
    : []

  return {
    totalCount: items.length,
    activeCount: items.filter((item) => ACTIVE_CODING_STATUSES.has(item.status)).length,
    blockedCount: items.filter((item) => BLOCKED_CODING_STATUSES.has(item.status)).length,
    items,
  }
}

// ---------------------------------------------------------------------------
// Attention / pending / inbox
// ---------------------------------------------------------------------------

/* v8 ignore stop */

function scanPendingChannels(agentRoot: string): OutlookPendingChannel[] {
  const pendingRoot = path.join(agentRoot, "state", "pending")
  const channels: OutlookPendingChannel[] = []

  for (const friendId of safeReaddir(pendingRoot)) {
    if (friendId === "self") continue
    const friendDir = path.join(pendingRoot, friendId)
    if (!safeIsDirectory(friendDir)) continue
    for (const channel of safeReaddir(friendDir)) {
      const channelDir = path.join(friendDir, channel)
      if (!safeIsDirectory(channelDir)) continue
      for (const key of safeReaddir(channelDir)) {
        const keyDir = path.join(channelDir, key)
        if (!safeIsDirectory(keyDir)) continue
        const files = safeReaddir(keyDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.processing"))
        if (files.length > 0) {
          channels.push({ friendId, channel, key, messageCount: files.length })
        }
      }
    }
  }

  return channels
}

function readPendingMessagesNonDestructive(pendingDir: string): Array<Record<string, unknown>> {
  const files = safeReaddir(pendingDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.processing"))
  const messages: Array<Record<string, unknown>> = []
  for (const file of files.sort()) {
    try {
      const raw = fs.readFileSync(path.join(pendingDir, file), "utf-8")
      messages.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // skip unparseable pending messages
    }
  }
  return messages
}

/* v8 ignore stop */

export function readAttentionView(agentName: string, options: OutlookReadOptions = {}): OutlookAttentionView {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const friendsDir = path.join(agentRoot, "friends")

  const pendingChannels = scanPendingChannels(agentRoot)

  // Build attention queue items from pending messages across all channels
  const queueItems: OutlookAttentionQueueItem[] = []
  const pendingRoot = path.join(agentRoot, "state", "pending")

  for (const pending of pendingChannels) {
    const pendingDir = path.join(pendingRoot, pending.friendId, pending.channel, pending.key)
    const messages = readPendingMessagesNonDestructive(pendingDir)
    for (const msg of messages) {
      const delegatedFrom = msg.delegatedFrom as Record<string, unknown> | undefined
      queueItems.push({
        id: typeof msg.timestamp === "number" ? `${msg.timestamp}-${pending.friendId}` : `pending-${Date.now()}`,
        friendId: pending.friendId,
        friendName: resolveFriendName(friendsDir, pending.friendId),
        channel: pending.channel,
        key: pending.key,
        bridgeId: delegatedFrom && typeof delegatedFrom.bridgeId === "string" ? delegatedFrom.bridgeId : null,
        delegatedContent: typeof msg.content === "string" ? msg.content : "",
        obligationId: typeof msg.obligationId === "string" ? msg.obligationId : null,
        source: "pending",
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : 0,
      })
    }
  }

  queueItems.sort((a, b) => a.timestamp - b.timestamp)

  // Return obligations
  const returnObligations = readObligationSummary(agentRoot).items

  return {
    queueLength: queueItems.length,
    queueItems,
    pendingChannels,
    returnObligations,
  }
}

// ---------------------------------------------------------------------------
// Bridge inventory — all bridge records
// ---------------------------------------------------------------------------

/* v8 ignore start — defensive parsing */
export function readBridgeInventory(agentRoot: string): OutlookBridgeInventory {
  const bridgesDir = path.join(agentRoot, "state", "bridges")
  const items: OutlookBridgeItem[] = []

  for (const file of safeReaddir(bridgesDir)) {
    if (!file.endsWith(".json")) continue
    try {
      const raw = fs.readFileSync(path.join(bridgesDir, file), "utf-8")
      const bridge = JSON.parse(raw) as Record<string, unknown>

      if (typeof bridge.id !== "string") continue

      const attachedSessions = Array.isArray(bridge.attachedSessions)
        ? (bridge.attachedSessions as Array<Record<string, unknown>>)
            .filter((s) => typeof s.friendId === "string")
            .map((s) => ({
              friendId: s.friendId as string,
              channel: typeof s.channel === "string" ? s.channel : "",
              key: typeof s.key === "string" ? s.key : "",
              sessionPath: typeof s.sessionPath === "string" ? s.sessionPath : "",
              snapshot: typeof s.snapshot === "string" ? s.snapshot : null,
            }))
        : []

      const taskLink = bridge.task as Record<string, unknown> | null | undefined
      const normalizedTask = taskLink && typeof taskLink === "object" && typeof taskLink.taskName === "string"
        ? {
            taskName: taskLink.taskName as string,
            path: typeof taskLink.path === "string" ? taskLink.path : "",
            mode: typeof taskLink.mode === "string" ? taskLink.mode : "bound",
            boundAt: typeof taskLink.boundAt === "string" ? taskLink.boundAt : "",
          }
        : null

      items.push({
        id: bridge.id,
        objective: typeof bridge.objective === "string" ? bridge.objective : "",
        summary: typeof bridge.summary === "string" ? bridge.summary : "",
        lifecycle: typeof bridge.lifecycle === "string" ? bridge.lifecycle : "unknown",
        runtime: typeof bridge.runtime === "string" ? bridge.runtime : "unknown",
        createdAt: typeof bridge.createdAt === "string" ? bridge.createdAt : "",
        updatedAt: typeof bridge.updatedAt === "string" ? bridge.updatedAt : "",
        attachedSessions,
        task: normalizedTask,
      })
    } catch {
      // skip unparseable bridge files
    }
  }

  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const activeCount = items.filter((item) => item.lifecycle === "active").length

  return {
    totalCount: items.length,
    activeCount,
    items,
  }
}

// ---------------------------------------------------------------------------
// Daemon health deep
// ---------------------------------------------------------------------------

/* v8 ignore stop */

/* v8 ignore start — defensive parsing */
export function readDaemonHealthDeep(healthPath?: string): OutlookDaemonHealthDeep | null {
  const resolvedPath = healthPath ?? path.join(process.env.HOME ?? "", ".ouro-cli", "daemon-health.json")
  try {
    const raw = fs.readFileSync(resolvedPath, "utf-8")
    const health = JSON.parse(raw) as Record<string, unknown>

    return {
      status: typeof health.status === "string" ? health.status : "unknown",
      mode: typeof health.mode === "string" ? health.mode : "unknown",
      pid: typeof health.pid === "number" ? health.pid : 0,
      startedAt: typeof health.startedAt === "string" ? health.startedAt : "",
      uptimeSeconds: typeof health.uptimeSeconds === "number" ? health.uptimeSeconds : 0,
      safeMode: health.safeMode && typeof health.safeMode === "object"
        ? {
            active: (health.safeMode as Record<string, unknown>).active === true,
            reason: typeof (health.safeMode as Record<string, unknown>).reason === "string" ? (health.safeMode as Record<string, unknown>).reason as string : "",
            enteredAt: typeof (health.safeMode as Record<string, unknown>).enteredAt === "string" ? (health.safeMode as Record<string, unknown>).enteredAt as string : "",
          }
        : null,
      degradedComponents: Array.isArray(health.degraded)
        ? (health.degraded as Array<Record<string, unknown>>).map((c) => ({
            component: typeof c.component === "string" ? c.component : "",
            reason: typeof c.reason === "string" ? c.reason : "",
            since: typeof c.since === "string" ? c.since : "",
          }))
        : [],
      agentHealth: health.agents && typeof health.agents === "object"
        ? Object.fromEntries(
            Object.entries(health.agents as Record<string, Record<string, unknown>>).map(([name, entry]) => [
              name,
              {
                status: typeof entry.status === "string" ? entry.status : "unknown",
                pid: typeof entry.pid === "number" ? entry.pid : null,
                crashes: typeof entry.crashes === "number" ? entry.crashes : 0,
              },
            ]),
          )
        : {},
      habitHealth: health.habits && typeof health.habits === "object"
        ? Object.fromEntries(
            Object.entries(health.habits as Record<string, Record<string, unknown>>).map(([name, entry]) => [
              name,
              {
                cronStatus: typeof entry.cronStatus === "string" ? entry.cronStatus : "unknown",
                lastFired: typeof entry.lastFired === "string" ? entry.lastFired : null,
                fallback: entry.fallback === true,
              },
            ]),
          )
        : {},
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Memory / journal inspection
// ---------------------------------------------------------------------------

/* v8 ignore stop */

/* v8 ignore start — defensive parsing */
export function readMemoryView(agentRoot: string): OutlookMemoryView {
  // Read diary entries from facts.jsonl
  const diaryRoot = path.join(agentRoot, "diary")
  const effectiveDiaryRoot = fs.existsSync(diaryRoot) ? diaryRoot : null

  const diaryEntries: OutlookDiaryEntry[] = []
  if (effectiveDiaryRoot) {
    const factsPath = path.join(effectiveDiaryRoot, "facts.jsonl")
    try {
      const raw = fs.readFileSync(factsPath, "utf-8")
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          if (typeof entry.id === "string" && typeof entry.text === "string") {
            diaryEntries.push({
              id: entry.id,
              text: entry.text,
              source: typeof entry.source === "string" ? entry.source : "",
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
            })
          }
        } catch {
          // skip unparseable lines
        }
      }
    } catch {
      // no diary facts file
    }
  }

  // Sort by createdAt descending, take recent
  diaryEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  // Read journal index
  const journalDir = path.join(agentRoot, "journal")
  const journalEntries: OutlookJournalEntry[] = []
  const indexPath = path.join(journalDir, ".index.json")
  try {
    const raw = fs.readFileSync(indexPath, "utf-8")
    const index = JSON.parse(raw) as Array<Record<string, unknown>>
    if (Array.isArray(index)) {
      for (const entry of index) {
        if (typeof entry.filename === "string") {
          journalEntries.push({
            filename: entry.filename,
            preview: typeof entry.preview === "string" ? entry.preview : "",
            mtime: typeof entry.mtime === "number" ? entry.mtime : 0,
          })
        }
      }
    }
  } catch {
    // no journal index
  }

  journalEntries.sort((a, b) => b.mtime - a.mtime)

  return {
    diaryEntryCount: diaryEntries.length,
    recentDiaryEntries: diaryEntries.slice(0, 20),
    journalEntryCount: journalEntries.length,
    recentJournalEntries: journalEntries.slice(0, 20),
  }
}

// ---------------------------------------------------------------------------
// Friend / relationship economics
// ---------------------------------------------------------------------------

/* v8 ignore stop */

export function readFriendView(agentName: string, options: OutlookReadOptions = {}): OutlookFriendView {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const friendsDir = path.join(agentRoot, "friends")
  const sessionsDir = path.join(agentRoot, "state", "sessions")

  const friends: OutlookFriendSummary[] = []

  for (const file of safeReaddir(friendsDir)) {
    if (!file.endsWith(".json")) continue
    const friendId = file.slice(0, -5)
    try {
      const raw = fs.readFileSync(path.join(friendsDir, file), "utf-8")
      const record = JSON.parse(raw) as Record<string, unknown>

      // Count sessions and channels for this friend
      const friendSessionsDir = path.join(sessionsDir, friendId)
      const channels = new Set<string>()
      let sessionCount = 0
      let latestActivity: string | null = null

      for (const channel of safeReaddir(friendSessionsDir)) {
        const channelDir = path.join(friendSessionsDir, channel)
        if (!safeIsDirectory(channelDir)) continue
        for (const keyFile of safeReaddir(channelDir)) {
          if (!keyFile.endsWith(".json")) continue
          channels.add(channel)
          sessionCount++
          const mtime = safeFileMtime(path.join(channelDir, keyFile))
          if (mtime && (!latestActivity || mtime > latestActivity)) {
            latestActivity = mtime
          }
        }
      }

      friends.push({
        friendId,
        friendName: typeof record.name === "string" ? record.name : friendId,
        totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : 0,
        sessionCount,
        channels: [...channels].sort(),
        lastActivityAt: latestActivity,
      })
    } catch {
      // skip unparseable friend records
    }
  }

  friends.sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    totalFriends: friends.length,
    friends,
  }
}

// ---------------------------------------------------------------------------
// Log / event reading (NDJSON)
// ---------------------------------------------------------------------------

export function readLogView(logPath: string | null, limit = 100): OutlookLogView {
  if (!logPath || !fs.existsSync(logPath)) {
    return { logPath, totalLines: 0, entries: [] }
  }

  try {
    const raw = fs.readFileSync(logPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    const totalLines = lines.length
    const recentLines = lines.slice(-limit)

    const entries: OutlookLogEntry[] = []
    for (const line of recentLines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        entries.push({
          ts: typeof parsed.ts === "string" ? parsed.ts : "",
          level: typeof parsed.level === "string" ? parsed.level as OutlookLogEntry["level"] : "info",
          event: typeof parsed.event === "string" ? parsed.event : "",
          component: typeof parsed.component === "string" ? parsed.component : "",
          message: typeof parsed.message === "string" ? parsed.message : "",
          trace_id: typeof parsed.trace_id === "string" ? parsed.trace_id : "",
          meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta as Record<string, unknown> : {},
        })
      } catch {
        // skip unparseable log lines
      }
    }

    return { logPath, totalLines, entries }
  } catch { /* v8 ignore next */
    return { logPath, totalLines: 0, entries: [] }
  }
}

// ---------------------------------------------------------------------------
// Habit inspection
// ---------------------------------------------------------------------------

export function readHabitView(agentRoot: string, options: OutlookReadOptions = {}): OutlookHabitView {
  const habitsDir = path.join(agentRoot, "habits")
  const now = options.now?.() ?? new Date()
  const items: OutlookHabitItem[] = []

  for (const file of safeReaddir(habitsDir)) {
    if (!file.endsWith(".md")) continue
    try {
      const raw = fs.readFileSync(path.join(habitsDir, file), "utf-8")
      const habit = parseHabitFrontmatter(raw)
      if (!habit) continue

      const cadenceMs = parseCadenceMs(habit.cadence)
      let isOverdue = false
      let overdueMs: number | null = null
      if (habit.status === "active" && habit.lastRun && cadenceMs) {
        const elapsed = now.getTime() - Date.parse(habit.lastRun)
        if (elapsed > cadenceMs) {
          isOverdue = true
          overdueMs = elapsed - cadenceMs
        }
      }

      items.push({
        name: habit.name ?? file.slice(0, -3),
        title: habit.title ?? file.slice(0, -3),
        cadence: habit.cadence,
        status: habit.status === "paused" ? "paused" : "active",
        lastRun: habit.lastRun,
        bodyExcerpt: truncateExcerpt(habit.body, 120),
        isDegraded: false,
        degradedReason: null,
        isOverdue,
        overdueMs,
      })
    } catch {
      // skip unparseable habit files
    }
  }

  items.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1
    if (!a.isOverdue && b.isOverdue) return 1
    return a.name.localeCompare(b.name)
  })

  return {
    totalCount: items.length,
    activeCount: items.filter((h) => h.status === "active").length,
    pausedCount: items.filter((h) => h.status === "paused").length,
    degradedCount: items.filter((h) => h.isDegraded).length,
    overdueCount: items.filter((h) => h.isOverdue).length,
    items,
  }
}

interface ParsedHabitFrontmatter {
  name: string | null
  title: string | null
  cadence: string | null
  status: string | null
  lastRun: string | null
  body: string | null
}

function parseHabitFrontmatter(content: string): ParsedHabitFrontmatter | null {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!fmMatch) return null

  const fm = fmMatch[1]!
  const body = content.slice(fmMatch[0].length).trim() || null

  function extract(key: string): string | null {
    const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm)
    return match ? match[1]!.trim() : null
  }

  return {
    name: extract("name"),
    title: extract("title"),
    cadence: extract("cadence"),
    status: extract("status"),
    lastRun: extract("lastRun") ?? extract("last_run"),
    body,
  }
}

// ---------------------------------------------------------------------------
// "What needs me now" — aggregates across all surfaces
// ---------------------------------------------------------------------------

/* v8 ignore start — defensive parsing in needs-me aggregator */
export function readNeedsMeView(agentName: string, options: OutlookReadOptions = {}): import("./outlook-types").OutlookNeedsMeView {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const items: import("./outlook-types").OutlookNeedsMeItem[] = []

  // Load dismissed obligations to filter them out
  const prefs = readDeskPrefs(agentRoot)
  const dismissed = new Set(prefs.dismissedObligations)

  // 1. Sessions that need a reply (last message is from user)
  const sessions = readSessionInventory(agentName, options)
  for (const s of sessions.items) {
    if (s.replyState === "needs-reply") {
      items.push({
        urgency: "owed-reply",
        label: `${s.friendName} is waiting for a reply`,
        detail: `via ${s.channel} · ${s.latestUserExcerpt ? truncateExcerpt(s.latestUserExcerpt, 80) ?? "" : ""}`,
        ref: { tab: "sessions", focus: `${s.friendId}/${s.channel}/${s.key}` },
        ageMs: now.getTime() - Date.parse(s.lastActivityAt),
      })
    }
  }

  // 2. Obligations that are blocking or stale
  const obligations = readObligationSummary(agentRoot)
  for (const o of obligations.items) {
    if (dismissed.has(o.id)) continue
    const ageMs = now.getTime() - Date.parse(o.updatedAt)
    const isStale = ageMs > 24 * 60 * 60 * 1000

    // Return-ready: obligation has a surface (result exists) but status is still open
    const hasResult = o.currentSurface !== null
    const isOpen = o.status === "pending" || o.status === "investigating" || o.status === "waiting_for_merge" || o.status === "updating_runtime"

    if (isOpen) {
      items.push({
        urgency: hasResult ? "return-ready" : isStale ? "stale-delegation" : "blocking-obligation",
        label: truncateExcerpt(o.content, 80) ?? o.id,
        detail: hasResult ? `result ready — ${o.currentSurface!.kind}: ${o.currentSurface!.label}` : `${o.status}${o.nextAction ? ` · next: ${o.nextAction}` : ""}`,
        ref: { tab: "work", focus: o.id },
        ageMs,
      })
    }
  }

  // 3. Pending attention queue items (someone delegated work that hasn't been picked up)
  const pendingChannels = scanPendingChannels(agentRoot)
  for (const p of pendingChannels) {
    if (p.friendId === "self") continue
    const friendName = resolveFriendName(path.join(agentRoot, "friends"), p.friendId)
    items.push({
      urgency: "stale-delegation",
      label: `${p.messageCount} pending from ${friendName}`,
      detail: `${p.channel}/${p.key}`,
      ref: { tab: "connections" },
      ageMs: null,
    })
  }

  // 4. Overdue habits
  const habits = readHabitView(agentRoot, options)
  for (const h of habits.items) {
    if (h.isOverdue) {
      items.push({
        urgency: "overdue-habit",
        label: `${h.title} is overdue`,
        detail: h.cadence ? `every ${h.cadence} · last ${h.lastRun ?? "never"}` : "no cadence set",
        ref: { tab: "inner" },
        ageMs: h.overdueMs,
      })
    }
  }

  // Sort: owed replies first, then blocking obligations, then stale, then habits
  const urgencyOrder: Record<string, number> = {
    "owed-reply": 0,
    "blocking-obligation": 1,
    "broken-return": 2,
    "stale-delegation": 3,
    "return-ready": 4,
    "overdue-habit": 5,
  }
  items.sort((a, b) => (urgencyOrder[a.urgency] ?? 99) - (urgencyOrder[b.urgency] ?? 99))

  return { items }
}

// ---------------------------------------------------------------------------
// Agent desk preferences
// ---------------------------------------------------------------------------

/* v8 ignore stop */

/* v8 ignore start — defensive JSON parsing in desk prefs reader */
export function readDeskPrefs(agentRoot: string): import("./outlook-types").OutlookDeskPrefs {
  const prefsPath = path.join(agentRoot, "state", "outlook-prefs.json")
  const defaults: import("./outlook-types").OutlookDeskPrefs = {
    carrying: null,
    statusLine: null,
    tabOrder: null,
    starredFriends: [],
    pinnedConstellations: [],
    dismissedObligations: [],
  }
  try {
    const raw = fs.readFileSync(prefsPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      carrying: typeof parsed.carrying === "string" ? parsed.carrying : null,
      statusLine: typeof parsed.statusLine === "string" ? parsed.statusLine : null,
      tabOrder: Array.isArray(parsed.tabOrder) ? parsed.tabOrder.filter((t): t is string => typeof t === "string") : null,
      starredFriends: Array.isArray(parsed.starredFriends) ? parsed.starredFriends.filter((f): f is string => typeof f === "string") : [],
      pinnedConstellations: Array.isArray(parsed.pinnedConstellations)
        ? (parsed.pinnedConstellations as Array<Record<string, unknown>>).map((c) => ({
            label: typeof c.label === "string" ? c.label : "",
            friendIds: Array.isArray(c.friendIds) ? c.friendIds.filter((f): f is string => typeof f === "string") : [],
            taskRefs: Array.isArray(c.taskRefs) ? c.taskRefs.filter((t): t is string => typeof t === "string") : [],
            bridgeIds: Array.isArray(c.bridgeIds) ? c.bridgeIds.filter((b): b is string => typeof b === "string") : [],
            codingIds: Array.isArray(c.codingIds) ? c.codingIds.filter((c2): c2 is string => typeof c2 === "string") : [],
          }))
        : [],
      dismissedObligations: Array.isArray(parsed.dismissedObligations) ? parsed.dismissedObligations.filter((id): id is string => typeof id === "string") : [],
    }
  } catch {
    return defaults
  }
}
/* v8 ignore stop */

function parseCadenceMs(cadence: string | null): number | null {
  if (!cadence) return null
  const match = /^(\d+)\s*(m|min|h|hr|d|day)s?$/i.exec(cadence.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 10)
  const unit = match[2]!.toLowerCase()
  if (unit === "m" || unit === "min") return value * 60 * 1000
  if (unit === "h" || unit === "hr") return value * 60 * 60 * 1000
  if (unit === "d" || unit === "day") return value * 24 * 60 * 60 * 1000
  /* v8 ignore next */
  return null
}

// ---------------------------------------------------------------------------
// Continuity — presence, cares, episodes for outlook surfaces
// ---------------------------------------------------------------------------

export function readOutlookContinuity(agentRoot: string, agentName: string): OutlookContinuityView {
  const self = readPresence(agentRoot, agentName)
  const peers = readPeerPresence(agentRoot)
  const cares = readActiveCares(agentRoot)
  const episodes = readRecentEpisodes(agentRoot, { limit: 10 })

  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_continuity_read",
    message: `outlook continuity: ${cares.length} cares, ${episodes.length} episodes`,
    meta: { careCount: cares.length, episodeCount: episodes.length, hasSelf: self != null, peerCount: peers.length },
  })

  return {
    presence: { self, peers },
    cares: {
      activeCount: cares.length,
      items: cares.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        salience: c.salience,
      })),
    },
    episodes: {
      recentCount: episodes.length,
      items: episodes.map((ep) => ({
        id: ep.id,
        kind: ep.kind,
        summary: ep.summary,
        timestamp: ep.timestamp,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// Orientation reader — daemon-side assembly of "where am I?"
// ---------------------------------------------------------------------------

export function readOrientationView(agentRoot: string, agentName: string): OutlookOrientationView {
  // Read obligations for primary selection
  let obligations: ReturnType<typeof readObligations> = []
  try {
    obligations = readObligations(agentRoot)
  } catch {
    obligations = []
  }
  const openObligations = obligations.filter(isOpenObligation)

  // Select primary obligation (most advanced status, then most recent)
  const statusPriority: Record<string, number> = {
    returning: 0,
    collaborating: 1,
    in_progress: 2,
    delegated: 3,
    accepted: 4,
    pending: 5,
  }
  const sorted = [...openObligations].sort((a, b) => {
    const sp = (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
    if (sp !== 0) return sp
    const aMs = new Date(a.updatedAt ?? a.createdAt).getTime()
    const bMs = new Date(b.updatedAt ?? b.createdAt).getTime()
    return bMs - aMs
  })
  const primary = sorted[0] ?? null

  // Read session activity for current session and others
  let sessions: ReturnType<typeof listSessionActivity> = []
  try {
    sessions = listSessionActivity({
      sessionsDir: path.join(agentRoot, "state", "sessions"),
      friendsDir: path.join(agentRoot, "friends"),
      agentName,
    })
  } catch {
    sessions = []
  }
  const sortedSessions = [...sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs)

  const currentSession = sortedSessions.length > 0
    ? {
        friendId: sortedSessions[0]!.friendId,
        channel: sortedSessions[0]!.channel,
        key: sortedSessions[0]!.key,
        lastActivityAt: sortedSessions[0]!.lastActivityAt,
      }
    : null

  const otherActiveSessions = sortedSessions.slice(1).map((s) => ({
    friendId: s.friendId,
    friendName: s.friendName,
    channel: s.channel,
    key: s.key,
    lastActivityAt: s.lastActivityAt,
  }))

  // Derive center of gravity summary
  const parts: string[] = []
  if (primary) parts.push(primary.content)
  if (openObligations.length > 1) parts.push(`${openObligations.length} open obligations`)
  if (sessions.length > 0) parts.push(`${sessions.length} active sessions`)
  const centerOfGravity = parts.length > 0 ? parts.join(" | ") : "idle"

  const primaryObligation = primary
    ? {
        id: primary.id,
        content: primary.content,
        status: primary.status,
        nextAction: primary.nextAction ?? null,
        waitingOn: primary.meaning?.waitingOn?.detail ?? null,
      }
    : null

  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_orientation_read",
    message: `outlook orientation: ${openObligations.length} obligations, ${sessions.length} sessions`,
    meta: { obligationCount: openObligations.length, sessionCount: sessions.length, primaryId: primary?.id ?? null },
  })

  return {
    currentSession,
    centerOfGravity,
    primaryObligation,
    resumeHandle: null,
    otherActiveSessions,
    rawState: null,
  }
}

// ---------------------------------------------------------------------------
// Obligation detail reader — richer view with primary selection context
// ---------------------------------------------------------------------------

export function readObligationDetailView(agentRoot: string): OutlookObligationDetailView {
  let obligations: ReturnType<typeof readObligations> = []
  try {
    obligations = readObligations(agentRoot)
  } catch {
    obligations = []
  }
  const openObligations = obligations.filter(isOpenObligation)

  // Select primary (same logic as orientation)
  const statusPriority: Record<string, number> = {
    returning: 0,
    collaborating: 1,
    in_progress: 2,
    delegated: 3,
    accepted: 4,
    pending: 5,
  }
  const sorted = [...openObligations].sort((a, b) => {
    const sp = (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
    if (sp !== 0) return sp
    const aMs = new Date(a.updatedAt ?? a.createdAt).getTime()
    const bMs = new Date(b.updatedAt ?? b.createdAt).getTime()
    return bMs - aMs
  })
  const primary = sorted[0] ?? null

  const items: OutlookObligationDetailItem[] = openObligations.map((ob) => ({
    id: ob.id,
    status: ob.status,
    content: ob.content,
    updatedAt: ob.updatedAt ?? ob.createdAt,
    nextAction: ob.nextAction ?? null,
    origin: ob.origin ?? null,
    currentSurface: ob.currentSurface ? { kind: ob.currentSurface.kind, label: ob.currentSurface.label } : null,
    meaning: ob.meaning ? { waitingOn: ob.meaning.waitingOn?.detail ?? null } : null,
    isPrimary: primary ? ob.id === primary.id : false,
  }))

  let primarySelectionReason: string | null = null
  if (primary) {
    if (primary.status !== "pending") {
      primarySelectionReason = `most advanced status: ${primary.status}`
    } else {
      primarySelectionReason = "most recent pending"
    }
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_obligations_read",
    message: `outlook obligations: ${openObligations.length} open`,
    meta: { openCount: openObligations.length, primaryId: primary?.id ?? null },
  })

  return {
    openCount: openObligations.length,
    primaryId: primary?.id ?? null,
    primarySelectionReason,
    items,
  }
}

// ---------------------------------------------------------------------------
// Changes reader — cross-session drift via snapshot comparison
// ---------------------------------------------------------------------------

import { detectActiveWorkChanges, formatActiveWorkChanges, type ActiveWorkSnapshot } from "../active-work"

export function readChangesView(agentRoot: string): OutlookChangesView {
  const snapshotPath = path.join(agentRoot, "state", "outlook", "active-work-snapshot.json")

  // Read prior snapshot
  let previous: ActiveWorkSnapshot | null = null
  try {
    const raw = fs.readFileSync(snapshotPath, "utf-8")
    previous = JSON.parse(raw) as ActiveWorkSnapshot
    if (!previous.obligationSnapshots || !previous.codingSnapshots) previous = null
  } catch {
    previous = null
  }

  // Build current snapshot from raw state
  let obligations: ReturnType<typeof readObligations> = []
  try { obligations = readObligations(agentRoot) } catch { obligations = [] }
  const openObligations = obligations.filter(isOpenObligation)

  const current: ActiveWorkSnapshot = {
    obligationSnapshots: openObligations.map((ob) => ({
      id: ob.id,
      status: ob.status,
      artifact: ob.currentArtifact?.trim() || null,
      nextAction: ob.nextAction?.trim() || null,
    })),
    codingSnapshots: [],
    timestamp: new Date().toISOString(),
  }

  // Persist current as the new snapshot
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
    fs.writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + "\n", "utf-8")
  } catch {
    // Best effort
  }

  if (!previous) {
    return { changeCount: 0, items: [], snapshotAge: null, formatted: "" }
  }

  const changes = detectActiveWorkChanges(previous, current)
  const formatted = formatActiveWorkChanges(changes)

  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_changes_read",
    message: `outlook changes: ${changes.length} detected`,
    meta: { changeCount: changes.length, snapshotAge: previous.timestamp },
  })

  return {
    changeCount: changes.length,
    items: changes.map((c) => ({ kind: c.kind, id: c.id, from: c.from, to: c.to, summary: c.summary })),
    snapshotAge: previous.timestamp,
    formatted,
  }
}

// ---------------------------------------------------------------------------
// Self-fix workflow reader — derived from task board and coding state
// ---------------------------------------------------------------------------

export function readSelfFixView(agentRoot: string): OutlookSelfFixView {
  // Derive self-fix state from task scanner
  let tasks: { name: string; title: string; status: string }[] = []
  try {
    const scanned = scanTasks(path.join(agentRoot, "tasks"))
    tasks = scanned.tasks.map((t) => ({ name: t.name, title: t.title, status: t.status }))
  } catch {
    tasks = []
  }

  // Look for self-fix-related tasks
  const selfFixTasks = tasks.filter((t) =>
    t.title.toLowerCase().includes("fix") || t.title.toLowerCase().includes("self-fix"),
  )

  if (selfFixTasks.length === 0) {
    return { active: false, currentStep: null, steps: [] }
  }

  const steps: OutlookSelfFixStep[] = selfFixTasks.map((t) => ({
    label: t.title,
    status: t.status === "done" ? "done" : t.status === "processing" ? "active" : "pending",
    detail: `task ${t.name}: ${t.status}`,
  }))

  const activeStep = steps.find((s) => s.status === "active")

  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_selffix_read",
    message: `outlook self-fix: ${selfFixTasks.length} tasks`,
    meta: { taskCount: selfFixTasks.length, active: !!activeStep },
  })

  return {
    active: !!activeStep,
    currentStep: activeStep?.label ?? null,
    steps,
  }
}

// ---------------------------------------------------------------------------
// Memory decisions reader — append-only JSONL log
// ---------------------------------------------------------------------------

export function readMemoryDecisionView(agentRoot: string, limit = 50): OutlookMemoryDecisionView {
  const logPath = path.join(agentRoot, "state", "outlook", "memory-decisions.jsonl")

  let lines: string[] = []
  try {
    const raw = fs.readFileSync(logPath, "utf-8")
    lines = raw.split("\n").filter((l) => l.trim().length > 0)
  } catch {
    return { totalCount: 0, items: [] }
  }

  const items: OutlookMemoryDecision[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as OutlookMemoryDecision
      if (parsed.kind && parsed.decision && parsed.timestamp) {
        items.push(parsed)
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Reverse chronological
  items.reverse()
  const limited = items.slice(0, limit)

  return { totalCount: items.length, items: limited }
}
