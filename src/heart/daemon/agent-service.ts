/**
 * Agent service layer — handles MCP-facing daemon commands.
 * Each handler receives { agent, friendId, ...params } and returns DaemonResponse.
 *
 * DRY: uses the same shared functions the agent's own tools use (diary, session transcript).
 * This file is a thin adapter — no reimplemented search, parsing, or state reading.
 */

import * as fs from "fs"
import * as path from "path"
import type { DaemonResponse } from "./daemon"
import { getAgentRoot } from "../identity"
import { readDiaryEntries, searchDiaryEntries, resolveDiaryRoot, type DiaryEntry } from "../../mind/diary"
import { emitNervesEvent } from "../../nerves/runtime"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "./socket-client"

export interface AgentServiceParams {
  agent: string
  friendId: string
  socketPath?: string
  [key: string]: unknown
}

/** Format diary hits the same way the search_notes tool does. */
function formatDiaryHits(hits: DiaryEntry[]): string[] {
  return hits.map((f) => `[diary] ${f.text} (source=${f.source}, createdAt=${f.createdAt})`)
}

/** Read a file from the agent root, returning null if it doesn't exist. */
function readAgentFile(agent: string, ...segments: string[]): string | null {
  const filePath = path.join(getAgentRoot(agent), ...segments)
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, "utf-8")
}

/** Resolve the diary root for a specific agent. */
function agentDiaryRoot(agent: string): string {
  return resolveDiaryRoot(path.join(getAgentRoot(agent), "diary"))
}

/** Read inner dialog runtime status. */
function readInnerDialogStatus(agent: string): { status: string; lastCompletedAt: string } | null {
  const content = readAgentFile(agent, "state", "sessions", "self", "inner", "runtime.json")
  if (!content) return null
  try {
    const data = JSON.parse(content)
    return { status: data.status ?? "unknown", lastCompletedAt: data.lastCompletedAt ?? "" }
  } catch {
    return null
  }
}

function safeReaddir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).map(String)
  /* v8 ignore start — catch is defensive; tested paths don't trigger fs errors */
  } catch { return [] }
  /* v8 ignore stop */
}

function safeIsDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  /* v8 ignore start — catch is defensive; tested paths don't trigger fs errors */
  } catch { return false }
  /* v8 ignore stop */
}

/** Session info extracted from the filesystem. */
interface SessionInfo { friendId: string; channel: string; key: string; lastUsage: string }

/** Enumerate sessions from state/sessions/, reading session.json files. */
function enumerateSessions(agent: string): SessionInfo[] {
  const sessionsDir = path.join(getAgentRoot(agent), "state", "sessions")
  if (!fs.existsSync(sessionsDir)) return []
  const sessions: SessionInfo[] = []
  for (const friendId of safeReaddir(sessionsDir)) {
    const friendPath = path.join(sessionsDir, friendId)
    if (!safeIsDir(friendPath)) continue
    for (const channel of safeReaddir(friendPath)) {
      const channelPath = path.join(friendPath, channel)
      if (!safeIsDir(channelPath)) continue
      for (const key of safeReaddir(channelPath)) {
        const sessionFile = path.join(channelPath, key, "session.json")
        if (!fs.existsSync(sessionFile)) continue
        try {
          const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"))
          sessions.push({ friendId, channel, key, lastUsage: data.lastUsage ?? "" })
        } catch { /* skip malformed */ }
      }
    }
  }
  return sessions
}

/** List markdown files in {agentRoot}/tasks/. */
function listTaskFiles(agent: string): string[] {
  const tasksDir = path.join(getAgentRoot(agent), "tasks")
  if (!fs.existsSync(tasksDir)) return []
  try { return fs.readdirSync(tasksDir).map(String).filter((f) => f.endsWith(".md")) } catch { return [] }
}

function emit(event: string, message: string, meta: Record<string, unknown>): void {
  emitNervesEvent({ component: "daemon", event, message, meta })
}

interface RuntimeStatusSummary {
  daemonReachable: boolean
  overview?: {
    daemon: string
    health: string
    version: string | null
    mode: string | null
  }
  workers: Array<{ worker: string; status: string }>
  senses: Array<{
    sense: string
    status: string
    enabled: boolean
    detail: string | null
    proofMethod: string | null
    lastProofAt: string | null
    proofAgeMs: number | null
    pendingRecoveryCount: number | null
    failedRecoveryCount: number | null
    failureLayer: string | null
    lastFailure: string | null
    recoveryAction: string | null
  }>
  error?: string
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readMcpRuntimeVersion(): string | null {
  const packagePath = path.resolve(__dirname, "..", "..", "..", "package.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as { version?: unknown }
    return stringValue(parsed.version)
  } catch {
    return null
  }
}

function summarizeRuntimeStatus(data: unknown, agent: string): RuntimeStatusSummary | null {
  const payload = objectRecord(data)
  if (!payload) return null
  const overview = objectRecord(payload.overview)
  const workers = Array.isArray(payload.workers) ? payload.workers : []
  const senses = Array.isArray(payload.senses) ? payload.senses : []

  return {
    daemonReachable: true,
    overview: overview
      ? {
          daemon: stringValue(overview.daemon) ?? "unknown",
          health: stringValue(overview.health) ?? "unknown",
          version: stringValue(overview.version),
          mode: stringValue(overview.mode),
        }
      : undefined,
    workers: workers.flatMap((row) => {
      const record = objectRecord(row)
      if (!record || stringValue(record.agent) !== agent) return []
      const worker = stringValue(record.worker)
      const status = stringValue(record.status)
      return worker && status ? [{ worker, status }] : []
    }),
    senses: senses.flatMap((row) => {
      const record = objectRecord(row)
      if (!record || stringValue(record.agent) !== agent) return []
      const sense = stringValue(record.sense)
      const status = stringValue(record.status)
      const enabled = booleanValue(record.enabled)
      if (!sense || !status || enabled === null) return []
      return [{
        sense,
        status,
        enabled,
        detail: stringValue(record.detail),
        proofMethod: stringValue(record.proofMethod),
        lastProofAt: stringValue(record.lastProofAt),
        proofAgeMs: numberValue(record.proofAgeMs),
        pendingRecoveryCount: numberValue(record.pendingRecoveryCount),
        failedRecoveryCount: numberValue(record.failedRecoveryCount),
        failureLayer: stringValue(record.failureLayer),
        lastFailure: stringValue(record.lastFailure),
        recoveryAction: stringValue(record.recoveryAction),
      }]
    }),
  }
}

async function readRuntimeStatus(socketPath: string | undefined, agent: string): Promise<RuntimeStatusSummary | null> {
  if (!socketPath) return null
  try {
    const response = await sendDaemonCommand(socketPath, { kind: "daemon.status" })
    if (!response.ok) {
      return {
        daemonReachable: false,
        workers: [],
        senses: [],
        error: response.error ?? response.message ?? "daemon status did not answer cleanly",
      }
    }
    return summarizeRuntimeStatus(response.data, agent)
  } catch (error) {
    return {
      daemonReachable: false,
      workers: [],
      senses: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatRuntimeStatusLines(
  runtime: RuntimeStatusSummary | null,
  mcpVersion: string | null,
): string[] {
  if (!runtime) return mcpVersion ? [`mcpVersion=${mcpVersion}`] : []
  if (!runtime.daemonReachable) {
    return [
      `daemon=unreachable${runtime.error ? `\terror=${runtime.error}` : ""}`,
      ...(mcpVersion ? [`mcpVersion=${mcpVersion}`] : []),
    ]
  }

  const lines: string[] = []
  if (runtime.overview) {
    const versionPart = runtime.overview.version ? `\tdaemonVersion=${runtime.overview.version}` : ""
    const modePart = runtime.overview.mode ? `\tmode=${runtime.overview.mode}` : ""
    const mcpVersionPart = mcpVersion ? `\tmcpVersion=${mcpVersion}` : ""
    const mismatchPart = mcpVersion && runtime.overview.version && mcpVersion !== runtime.overview.version
      ? `\tversionMismatch=mcp:${mcpVersion},daemon:${runtime.overview.version}`
      : ""
    lines.push(`daemon=${runtime.overview.daemon}\thealth=${runtime.overview.health}${versionPart}${modePart}${mcpVersionPart}${mismatchPart}`)
  }
  for (const worker of runtime.workers) {
    lines.push(`worker=${worker.worker}:${worker.status}`)
  }
  for (const sense of runtime.senses) {
    const detailPart = sense.detail ? `\tdetail=${sense.detail}` : ""
    const proofPart = sense.proofMethod ? `\tproof=${sense.proofMethod}` : ""
    const lastProofPart = sense.lastProofAt ? `\tlastProofAt=${sense.lastProofAt}` : ""
    const proofAgePart = sense.proofAgeMs !== null ? `\tproofAgeMs=${sense.proofAgeMs}` : ""
    const pendingPart = sense.pendingRecoveryCount !== null ? `\tpendingRecovery=${sense.pendingRecoveryCount}` : ""
    const failedPart = sense.failedRecoveryCount !== null ? `\tfailedRecovery=${sense.failedRecoveryCount}` : ""
    const failureLayerPart = sense.failureLayer ? `\tfailureLayer=${sense.failureLayer}` : ""
    const failurePart = sense.lastFailure ? `\tlastFailure=${sense.lastFailure}` : ""
    const recoveryPart = sense.recoveryAction ? `\trecovery=${sense.recoveryAction}` : ""
    lines.push(
      `sense=${sense.sense}:${sense.enabled ? sense.status : "disabled"}`
      + detailPart
      + proofPart
      + lastProofPart
      + proofAgePart
      + pendingPart
      + failedPart
      + failureLayerPart
      + failurePart
      + recoveryPart,
    )
  }
  if (lines.length === 0 && mcpVersion) lines.push(`mcpVersion=${mcpVersion}`)
  return lines
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleAgentStatus(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({ component: "daemon", event: "daemon.agent_service_start", message: "handling agent.status", meta: { agent: params.agent } })
  const diaryRoot = agentDiaryRoot(params.agent)
  const facts = readDiaryEntries(diaryRoot)
  const innerStatus = readInnerDialogStatus(params.agent)
  const sessions = enumerateSessions(params.agent)
  const mcpVersion = readMcpRuntimeVersion()
  const runtime = await readRuntimeStatus(params.socketPath ?? DEFAULT_DAEMON_SOCKET_PATH, params.agent)
  emit("daemon.agent_service_end", "completed agent.status", { agent: params.agent })
  const innerStatusValue = innerStatus?.status ?? "unknown"
  const lastThoughtAt = innerStatus?.lastCompletedAt ?? null
  const agentLine = [
    `agent=${params.agent}`,
    `innerStatus=${innerStatusValue}`,
    `lastThoughtAt=${lastThoughtAt ?? "never"}`,
    `sessionCount=${sessions.length}`,
    `diaryEntries=${facts.length}`,
  ].join("\t")
  const runtimeLines = formatRuntimeStatusLines(runtime, mcpVersion)
  const message = [agentLine, ...runtimeLines].join("\n")
  return {
    ok: true,
    message,
    data: {
      agent: params.agent,
      innerStatus: innerStatusValue,
      lastThoughtAt,
      sessionCount: sessions.length,
      hasDiaryEntries: facts.length > 0,
      factCount: facts.length,
      runtime,
      mcpVersion,
    },
  }
}

export async function handleAgentAsk(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.ask", { agent: params.agent })
  const question = params.question as string | undefined
  if (!question) {
    emit("daemon.agent_service_error", "agent.ask missing question", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: question" }
  }
  // Use the same searchDiaryEntries the search_notes tool uses (substring fallback — no embedding provider in shim)
  const diaryRoot = agentDiaryRoot(params.agent)
  const hits = await searchDiaryEntries(question, readDiaryEntries(diaryRoot))
  const context = hits.length > 0
    ? hits.slice(0, 10).map((f) => f.text).join("\n")
    : `No relevant notes found for: ${question}`
  emit("daemon.agent_service_end", "completed agent.ask", { agent: params.agent })
  return { ok: true, message: context }
}

export async function handleAgentCatchup(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.catchup", { agent: params.agent })
  const sessions = enumerateSessions(params.agent)
  const sorted = sessions.sort((a, b) => (b.lastUsage || "").localeCompare(a.lastUsage || ""))
  const recentSessions = sorted.slice(0, 5)
  const innerStatus = readInnerDialogStatus(params.agent)

  const parts: string[] = []
  if (innerStatus) {
    parts.push(`Inner dialog: ${innerStatus.status} (last completed: ${innerStatus.lastCompletedAt || "never"})`)
  }
  if (recentSessions.length > 0) {
    parts.push(`Recent sessions (${recentSessions.length}):`)
    for (const s of recentSessions) {
      parts.push(`  - ${s.friendId}/${s.channel}/${s.key} (${s.lastUsage || "unknown"})`)
    }
  } else {
    parts.push("No recent sessions")
  }
  emit("daemon.agent_service_end", "completed agent.catchup", { agent: params.agent })
  return {
    ok: true,
    /* v8 ignore next — parts always has at least one element (either sessions or "No recent sessions") */
    message: parts.length > 0 ? parts.join("\n") : `No recent activity for ${params.agent}`,
    data: { recentSessions, innerStatus },
  }
}

export async function handleAgentDelegate(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.delegate", { agent: params.agent })
  const task = params.task as string | undefined
  if (!task) {
    emit("daemon.agent_service_error", "agent.delegate missing task", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: task" }
  }
  emit("daemon.agent_service_end", "completed agent.delegate", { agent: params.agent })
  return { ok: true, message: `Task queued: ${task}`, data: { task, context: params.context ?? null, queuedAt: new Date().toISOString() } }
}

export async function handleAgentGetContext(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.getContext", { agent: params.agent })
  const query = (params.question ?? params.query ?? params.topic) as string | undefined
  const diaryRoot = agentDiaryRoot(params.agent)
  const facts = readDiaryEntries(diaryRoot)
  const innerStatus = readInnerDialogStatus(params.agent)
  const sessions = enumerateSessions(params.agent)
  const taskFiles = listTaskFiles(params.agent)

  let noteSummary: string | null = null
  if (query) {
    const hits = await searchDiaryEntries(query, facts)
    noteSummary = hits.length > 0
      ? hits.slice(0, 10).map((f) => f.text).join("\n")
      : `No relevant notes for: ${query}`
  } else {
    const recent = facts.slice(-10)
    if (recent.length > 0) noteSummary = recent.map((f) => f.text).join("\n")
  }
  emit("daemon.agent_service_end", "completed agent.getContext", { agent: params.agent })
  return {
    ok: true,
    data: {
      agent: params.agent,
      hasDiaryEntries: facts.length > 0,
      factCount: facts.length,
      noteSummary,
      taskCount: taskFiles.length,
      sessionCount: sessions.length,
      innerStatus: innerStatus?.status ?? null,
    },
  }
}

export async function handleAgentSearchNotes(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.searchNotes", { agent: params.agent })
  const query = params.query as string | undefined
  if (!query) {
    emit("daemon.agent_service_error", "agent.searchNotes missing query", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: query" }
  }
  // Same searchDiaryEntries as the search_notes tool
  const diaryRoot = agentDiaryRoot(params.agent)
  const hits = await searchDiaryEntries(query, readDiaryEntries(diaryRoot))
  const formatted = formatDiaryHits(hits.slice(0, 20))
  emit("daemon.agent_service_end", "completed agent.searchNotes", { agent: params.agent, matchCount: hits.length })
  return {
    ok: true,
    message: hits.length > 0 ? `Found ${hits.length} matches` : "No matches found",
    data: { query, matches: formatted },
  }
}

export async function handleAgentGetTask(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.getTask", { agent: params.agent })
  const taskFiles = listTaskFiles(params.agent)
  const activeTasks = taskFiles.filter((f) => f.toLowerCase().includes("doing") && !f.toLowerCase().includes("done"))
  const taskNames = activeTasks.length > 0 ? activeTasks : taskFiles
  const tasks = taskNames.map((name) => {
    const content = readAgentFile(params.agent, "tasks", name)
    const firstLine = content?.split("\n").find((l) => l.trim().length > 0)?.trim() ?? ""
    return { name, statusLine: firstLine }
  })
  emit("daemon.agent_service_end", "completed agent.getTask", { agent: params.agent })
  return {
    ok: true,
    message: tasks.length > 0 ? `Tasks (${tasks.length}): ${tasks.map((t) => t.name).join(", ")}` : `No active tasks for ${params.agent}`,
    data: { tasks, activeCount: activeTasks.length, totalCount: taskFiles.length },
  }
}

export async function handleAgentCheckScope(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.checkScope", { agent: params.agent })
  const item = params.item as string | undefined
  if (!item) {
    emit("daemon.agent_service_error", "agent.checkScope missing item", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: item" }
  }
  emit("daemon.agent_service_end", "completed agent.checkScope", { agent: params.agent })
  return { ok: true, message: `Scope check for: ${item}`, data: { item, inScope: true, reason: "MVP: scope check requires inference — defaulting to in-scope" } }
}

export async function handleAgentRequestDecision(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.requestDecision", { agent: params.agent })
  const topic = params.topic as string | undefined
  if (!topic) {
    emit("daemon.agent_service_error", "agent.requestDecision missing topic", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: topic" }
  }
  emit("daemon.agent_service_end", "completed agent.requestDecision", { agent: params.agent })
  return { ok: true, message: `Decision request queued: ${topic}`, data: { topic, options: params.options ?? null, status: "pending" } }
}

export async function handleAgentCheckGuidance(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.checkGuidance", { agent: params.agent })
  const topic = params.topic as string | undefined
  if (!topic) {
    emit("daemon.agent_service_error", "agent.checkGuidance missing topic", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: topic" }
  }
  // Same searchDiaryEntries as the search_notes tool
  const diaryRoot = agentDiaryRoot(params.agent)
  const hits = await searchDiaryEntries(topic, readDiaryEntries(diaryRoot))
  const guidance = hits.length > 0
    ? `Relevant guidance:\n${hits.slice(0, 10).map((f) => f.text).join("\n")}`
    : `No specific guidance found for: ${topic}`
  emit("daemon.agent_service_end", "completed agent.checkGuidance", { agent: params.agent })
  return { ok: true, message: guidance }
}

export async function handleAgentReportProgress(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.reportProgress", { agent: params.agent })
  const summary = params.summary as string | undefined
  if (!summary) {
    emit("daemon.agent_service_error", "agent.reportProgress missing summary", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: summary" }
  }
  emit("daemon.agent_service_end", "completed agent.reportProgress", { agent: params.agent })
  return { ok: true, message: `Progress noted: ${summary}`, data: { summary, receivedAt: new Date().toISOString() } }
}

export async function handleAgentReportBlocker(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.reportBlocker", { agent: params.agent })
  const blocker = params.blocker as string | undefined
  if (!blocker) {
    emit("daemon.agent_service_error", "agent.reportBlocker missing blocker", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: blocker" }
  }
  emit("daemon.agent_service_end", "completed agent.reportBlocker", { agent: params.agent })
  return { ok: true, message: `Blocker reported: ${blocker}`, data: { blocker, receivedAt: new Date().toISOString() } }
}

export async function handleAgentReportComplete(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.reportComplete", { agent: params.agent })
  const summary = params.summary as string | undefined
  if (!summary) {
    emit("daemon.agent_service_error", "agent.reportComplete missing summary", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: summary" }
  }
  emit("daemon.agent_service_end", "completed agent.reportComplete", { agent: params.agent })
  return { ok: true, message: `Completion reported: ${summary}`, data: { summary, receivedAt: new Date().toISOString() } }
}
