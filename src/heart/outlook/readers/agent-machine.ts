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
  OUTLOOK_DEFAULT_INNER_VISIBILITY,
  OUTLOOK_PRODUCT_NAME,
  type OutlookAgentState,
  type OutlookAgentSummary,
  type OutlookCodingItem,
  type OutlookDegradedState,
  type OutlookFreshness,
  type OutlookIssue,
  type OutlookMachineState,
  type OutlookObligationItem,
  type OutlookSessionItem,
  type OutlookTaskSummary,
} from "../outlook-types"
import {
  ACTIVE_CODING_STATUSES,
  BLOCKED_CODING_STATUSES,
  STALE_THRESHOLD_MS,
  type OutlookReadOptions,
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

export function readObligationSummary(agentRoot: string): { items: OutlookObligationItem[] } {
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
    providers: state.providers ?? null,
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
  const providers = buildAgentProviderVisibility({ agentName, agentRoot, homeDir: options.homeDir })

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
