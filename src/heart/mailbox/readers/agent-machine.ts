import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import { readPendingObligations } from "../../../arc/obligations"
import type { TaskStatus } from "../../../arc/task-lifecycle"
import { buildTaskBoard } from "../../../repertoire/tasks/board"
import { scanTasks } from "../../../repertoire/tasks/scanner"
import { listSessionActivity } from "../../session-activity"
import { getAgentBundlesRoot } from "../../identity"
import { listEnabledBundleAgents } from "../../daemon/agent-discovery"
import { getRuntimeMetadata } from "../../daemon/runtime-metadata"
import { buildAgentProviderVisibility } from "../../provider-visibility"
import {
  deriveInnerJob,
  formatSurfacedValue,
  getInnerDialogSessionPath,
  readInnerDialogRawData,
} from "../../daemon/thoughts"
import {
  MAILBOX_DEFAULT_INNER_VISIBILITY,
  MAILBOX_PRODUCT_NAME,
  type MailboxAgentState,
  type MailboxAgentSummary,
  type MailboxCodingItem,
  type MailboxDegradedState,
  type MailboxFreshness,
  type MailboxIssue,
  type MailboxMachineState,
  type MailboxObligationItem,
  type MailboxReturnObligationQueueSummary,
  type MailboxSessionItem,
  type MailboxTaskSummary,
} from "../mailbox-types"
import {
  ACTIVE_CODING_STATUSES,
  BLOCKED_CODING_STATUSES,
  STALE_THRESHOLD_MS,
  type MailboxReadOptions,
  issue,
} from "./shared"

const LIVE_TASK_STATUSES: TaskStatus[] = ["processing", "validating", "collaborating", "blocked"]

interface AgentConfigSummary {
  enabled: boolean
  provider: string | null
  senses: string[]
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

function readAgentConfig(agentRoot: string): { summary: AgentConfigSummary; issues: MailboxIssue[] } {
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

function readTaskSummary(agentRoot: string): { summary: MailboxTaskSummary; issues: MailboxIssue[] } {
  const taskRoot = path.join(agentRoot, "tasks")
  const index = scanTasks(taskRoot)
  const board = buildTaskBoard(index)
  const byStatus = emptyByStatus()

  for (const status of Object.keys(byStatus) as TaskStatus[]) {
    byStatus[status] = board.byStatus[status].length
  }

  const liveTaskNames = LIVE_TASK_STATUSES.flatMap((status) => board.byStatus[status])
  const issues: MailboxIssue[] = index.issues.map((taskIssue) =>
    issue(taskIssue.code, `${taskIssue.target}: ${taskIssue.description}`),
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

const STALE_CODING_SURFACE_WINDOW_MS = 60 * 60 * 1000

function buildLiveCodingSurfaceLabels(agentRoot: string): Set<string> {
  return new Set(
    readCodingSummary(agentRoot).items
      .filter((item) => ACTIVE_CODING_STATUSES.has(item.status))
      .map((item) => `${item.runner} ${item.id}`),
  )
}

function normalizeObligationCurrentSurface(
  currentSurface: MailboxObligationItem["currentSurface"],
  updatedAt: string,
  liveCodingSurfaceLabels: Set<string>,
): MailboxObligationItem["currentSurface"] {
  if (!currentSurface || currentSurface.kind !== "coding") return currentSurface

  const liveLabel = currentSurface.label.trim()
  if (!liveLabel) return null
  if (liveCodingSurfaceLabels.has(liveLabel)) return currentSurface

  const updatedAtMs = Date.parse(updatedAt)
  const recentlyTouched = Number.isFinite(updatedAtMs)
    && (Date.now() - updatedAtMs) <= STALE_CODING_SURFACE_WINDOW_MS
  return recentlyTouched ? currentSurface : null
}

export function readObligationSummary(agentRoot: string): { items: MailboxObligationItem[] } {
  const liveCodingSurfaceLabels = buildLiveCodingSurfaceLabels(agentRoot)
  const items = readPendingObligations(agentRoot)
    .map((obligation) => {
      const updatedAt = obligation.updatedAt ?? obligation.createdAt
      return {
        id: obligation.id,
        status: obligation.status,
        content: obligation.content,
        updatedAt,
        nextAction: obligation.nextAction ?? null,
        /* v8 ignore start */
        origin: obligation.origin ?? null,
        currentSurface: normalizeObligationCurrentSurface(obligation.currentSurface ?? null, updatedAt, liveCodingSurfaceLabels),
        /* v8 ignore stop */
      }
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return { items }
}

function readSessionSummary(agentName: string, agentRoot: string, now: Date): { items: MailboxSessionItem[] } {
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
  summary: MailboxAgentState["inner"]
  issues: MailboxIssue[]
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

  // Read the return-obligation queue so the Inner tab can show what the
  // agent is actually holding right now. Before this, the "Inner work"
  // panel only consulted the pending-messages dir (inbox-style); it
  // reported "No pending inner work" even when dozens of held items were
  // sitting in arc/obligations/inner/ waiting to be reinjected next turn.
  const returnObligationQueue = readReturnObligationQueueSummary(agentRoot)

  return {
    summary: {
      visibility: MAILBOX_DEFAULT_INNER_VISIBILITY,
      status: job.status,
      hasPending: pendingMessages.length > 0,
      surfacedSummary,
      origin: job.origin,
      obligationStatus: job.obligationStatus,
      latestActivityAt,
      returnObligationQueue,
    },
    issues: [],
    latestActivityAt,
  }
}

function readReturnObligationQueueSummary(agentRoot: string): MailboxReturnObligationQueueSummary {
  const dir = path.join(agentRoot, "arc", "obligations", "inner")
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return { queuedCount: 0, runningCount: 0, oldestActiveAt: null }
  }
  let queuedCount = 0
  let runningCount = 0
  let oldestActiveAt: number | null = null
  for (const name of names) {
    let parsed: { status?: unknown; createdAt?: unknown } | null = null
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"))
    } catch {
      continue
    }
    if (!parsed) continue
    const status = parsed.status
    if (status === "queued") queuedCount += 1
    else if (status === "running") runningCount += 1
    else continue
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : null
    if (createdAt !== null && (oldestActiveAt === null || createdAt < oldestActiveAt)) {
      oldestActiveAt = createdAt
    }
  }
  return { queuedCount, runningCount, oldestActiveAt }
}

function readCodingSummary(agentRoot: string): {
  items: MailboxCodingItem[]
  issues: MailboxIssue[]
} {
  const stateFilePath = path.join(agentRoot, "state", "coding", "sessions.json")
  const issues: MailboxIssue[] = []

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
        runner: session.runner as MailboxCodingItem["runner"],
        status: session.status as MailboxCodingItem["status"],
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
  obligations: MailboxObligationItem[]
  sessions: MailboxSessionItem[]
  innerLatestActivityAt: string | null
  coding: MailboxCodingItem[]
}): string[] {
  const timestamps: string[] = []

  for (const item of input.obligations) timestamps.push(item.updatedAt)
  for (const item of input.sessions) timestamps.push(item.lastActivityAt)
  for (const item of input.coding) timestamps.push(item.lastActivityAt)
  if (input.innerLatestActivityAt) timestamps.push(input.innerLatestActivityAt)

  return timestamps
    .filter((value) => Number.isFinite(Date.parse(value)))
}

function summarizeFreshness(latestActivityAt: string | null, now: Date): MailboxFreshness {
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

function summarizeDegraded(issues: MailboxIssue[]): MailboxDegradedState {
  return {
    status: issues.length > 0 ? "degraded" : "ok",
    issues,
  }
}

function summarizeAgent(state: MailboxAgentState): MailboxAgentSummary {
  return {
    agentName: state.agentName,
    enabled: state.enabled,
    providers: state.providers,
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

export function readMailboxAgentState(agentName: string, options: MailboxReadOptions = {}): MailboxAgentState {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const issues: MailboxIssue[] = []

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
  const providers = buildAgentProviderVisibility({ agentName, agentRoot, homeDir: options.homeDir })

  const latestActivityAt = collectLatestActivityTimestamps({
    obligations: obligations.items,
    sessions: sessions.items,
    innerLatestActivityAt: inner.latestActivityAt,
    coding: coding.items,
  }).sort((left, right) => right.localeCompare(left))[0] ?? null

  return {
    productName: MAILBOX_PRODUCT_NAME,
    agentName,
    agentRoot,
    enabled: config.summary.enabled,
    provider: config.summary.provider,
    providers,
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

export function readMailboxMachineState(options: MailboxReadOptions = {}): MailboxMachineState {
  /* v8 ignore next */
  emitNervesEvent({ component: "daemon", event: "daemon.mailbox_read", message: "reading mailbox machine state", meta: {} })
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const runtime = options.runtimeMetadata ?? getRuntimeMetadata({ bundlesRoot })
  const agentNames = options.agentNames ?? listEnabledBundleAgents({ bundlesRoot })
  const agentStates = agentNames.map((agentName) => readMailboxAgentState(agentName, { ...options, bundlesRoot, now: () => now }))
  const degradedIssues = agentStates
    .flatMap((state) => state.degraded.issues.map((problem) => issue("agent-degraded", `${state.agentName}: ${problem.detail}`)))
  const freshest = agentStates
    .map((state) => state.freshness.latestActivityAt)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => right.localeCompare(left))[0] ?? null

  return {
    productName: MAILBOX_PRODUCT_NAME,
    observedAt: now.toISOString(),
    runtime,
    agentCount: agentStates.length,
    freshness: summarizeFreshness(freshest, now),
    degraded: summarizeDegraded(degradedIssues),
    agents: agentStates.map(summarizeAgent),
  }
}
