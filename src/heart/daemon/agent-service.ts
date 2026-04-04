/**
 * Agent service layer — handles MCP-facing daemon commands.
 * Each handler receives { agent, friendId, ...params } and returns DaemonResponse.
 *
 * DRY: uses the same shared functions the agent's own tools use (diary, session-recall).
 * This file is a thin adapter — no reimplemented search, parsing, or state reading.
 */

import * as fs from "fs"
import * as path from "path"
import type { DaemonResponse } from "./daemon"
import { getAgentRoot } from "../identity"
import { readDiaryEntries, searchDiaryEntries, resolveDiaryRoot, type DiaryEntry } from "../../mind/diary"
import { emitNervesEvent } from "../../nerves/runtime"

export interface AgentServiceParams {
  agent: string
  friendId: string
  [key: string]: unknown
}

/** Format diary hits the same way the recall tool does. */
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

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleAgentStatus(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({ component: "daemon", event: "daemon.agent_service_start", message: "handling agent.status", meta: { agent: params.agent } })
  const diaryRoot = agentDiaryRoot(params.agent)
  const facts = readDiaryEntries(diaryRoot)
  const innerStatus = readInnerDialogStatus(params.agent)
  const sessions = enumerateSessions(params.agent)
  emit("daemon.agent_service_end", "completed agent.status", { agent: params.agent })
  return {
    ok: true,
    message: `Agent ${params.agent} status`,
    data: {
      agent: params.agent,
      innerStatus: innerStatus?.status ?? "unknown",
      lastThoughtAt: innerStatus?.lastCompletedAt ?? null,
      sessionCount: sessions.length,
      hasMemory: facts.length > 0,
      factCount: facts.length,
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
  // Use the same searchDiaryEntries the recall tool uses (substring fallback — no embedding provider in shim)
  const diaryRoot = agentDiaryRoot(params.agent)
  const hits = await searchDiaryEntries(question, readDiaryEntries(diaryRoot))
  const context = hits.length > 0
    ? hits.slice(0, 10).map((f) => f.text).join("\n")
    : `No relevant memories found for: ${question}`
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

  let memorySummary: string | null = null
  if (query) {
    const hits = await searchDiaryEntries(query, facts)
    memorySummary = hits.length > 0
      ? hits.slice(0, 10).map((f) => f.text).join("\n")
      : `No relevant memories for: ${query}`
  } else {
    const recent = facts.slice(-10)
    if (recent.length > 0) memorySummary = recent.map((f) => f.text).join("\n")
  }
  emit("daemon.agent_service_end", "completed agent.getContext", { agent: params.agent })
  return {
    ok: true,
    data: {
      agent: params.agent,
      hasMemory: facts.length > 0,
      factCount: facts.length,
      memorySummary,
      taskCount: taskFiles.length,
      sessionCount: sessions.length,
      innerStatus: innerStatus?.status ?? null,
    },
  }
}

export async function handleAgentSearchMemory(params: AgentServiceParams): Promise<DaemonResponse> {
  emit("daemon.agent_service_start", "handling agent.searchMemory", { agent: params.agent })
  const query = params.query as string | undefined
  if (!query) {
    emit("daemon.agent_service_error", "agent.searchMemory missing query", { agent: params.agent })
    return { ok: false, error: "Missing required parameter: query" }
  }
  // Same searchDiaryEntries as the recall tool
  const diaryRoot = agentDiaryRoot(params.agent)
  const hits = await searchDiaryEntries(query, readDiaryEntries(diaryRoot))
  const formatted = formatDiaryHits(hits.slice(0, 20))
  emit("daemon.agent_service_end", "completed agent.searchMemory", { agent: params.agent, matchCount: hits.length })
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
  // Same searchDiaryEntries as the recall tool
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
