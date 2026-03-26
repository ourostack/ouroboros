/**
 * Agent service layer — handles MCP-facing daemon commands.
 * Each handler receives { agent, friendId, ...params } and returns DaemonResponse.
 * For MVP, these read from agent state on the filesystem.
 * Full inference support can come later.
 */

import * as fs from "fs"
import * as path from "path"
import type { DaemonResponse } from "./daemon"
import { getAgentRoot, getAgentStateRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface AgentServiceParams {
  agent: string
  friendId: string
  [key: string]: unknown
}

function readAgentFile(agent: string, ...segments: string[]): string | null {
  const filePath = path.join(getAgentRoot(agent), ...segments)
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, "utf-8")
}

/** Read agent memory from multiple possible locations. */
function readAgentMemory(agent: string): string | null {
  // Try memory/MEMORY.md first, then psyche/memory/facts.jsonl
  return readAgentFile(agent, "memory", "MEMORY.md")
    ?? readAgentFile(agent, "psyche", "memory", "facts.jsonl")
}

function listStateFiles(agent: string, ...segments: string[]): string[] {
  const dirPath = path.join(getAgentStateRoot(agent), ...segments)
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath).filter((f) => f.endsWith(".json") || f.endsWith(".jsonl") || f.endsWith(".md"))
}

export async function handleAgentStatus(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.status",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const sessionFiles = listStateFiles(params.agent, "sessions")
  const memoryContent = readAgentMemory(params.agent)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.status",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Agent ${params.agent} status`,
    data: {
      agent: params.agent,
      status: "active",
      sessionCount: sessionFiles.length,
      hasMemory: memoryContent !== null,
    },
  }
}

export async function handleAgentAsk(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.ask",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const question = params.question as string | undefined
  if (!question) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.ask missing question parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: question" }
  }

  // MVP: return memory + recent session context without running inference
  const memoryContent = readAgentMemory(params.agent)
  const context = memoryContent
    ? `Based on agent memory:\n${memoryContent.slice(0, 2000)}`
    : `Agent ${params.agent} has no memory file. Question was: ${question}`

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.ask",
    meta: { agent: params.agent },
  })

  return { ok: true, message: context }
}

export async function handleAgentCatchup(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.catchup",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const sessionFiles = listStateFiles(params.agent, "sessions")
  const recentSessions = sessionFiles.slice(-5)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.catchup",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: recentSessions.length > 0
      ? `Recent activity: ${recentSessions.length} recent sessions found`
      : `No recent activity for ${params.agent}`,
    data: { recentSessions },
  }
}

export async function handleAgentDelegate(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.delegate",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const task = params.task as string | undefined
  if (!task) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.delegate missing task parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: task" }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.delegate",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Task queued for delegate to ${params.agent}: ${task}`,
    data: { task, context: params.context ?? null, queuedAt: new Date().toISOString() },
  }
}

export async function handleAgentGetContext(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.getContext",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const memoryContent = readAgentMemory(params.agent)
  const taskFiles = listStateFiles(params.agent, "tasks")

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.getContext",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    data: {
      agent: params.agent,
      hasMemory: memoryContent !== null,
      memorySummary: memoryContent ? memoryContent.slice(0, 500) : null,
      taskCount: taskFiles.length,
    },
  }
}

export async function handleAgentSearchMemory(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.searchMemory",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const query = params.query as string | undefined
  if (!query) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.searchMemory missing query parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: query" }
  }

  // MVP: simple substring search in memory file
  const memoryContent = readAgentMemory(params.agent)
  const matches: string[] = []
  if (memoryContent) {
    const lines = memoryContent.split("\n")
    const queryLower = query.toLowerCase()
    for (const line of lines) {
      if (line.toLowerCase().includes(queryLower)) {
        matches.push(line.trim())
      }
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.searchMemory",
    meta: { agent: params.agent, matchCount: matches.length },
  })

  return {
    ok: true,
    message: matches.length > 0 ? `Found ${matches.length} matches` : "No matches found",
    data: { query, matches: matches.slice(0, 20) },
  }
}

export async function handleAgentGetTask(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.getTask",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const taskFiles = listStateFiles(params.agent, "tasks")

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.getTask",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: taskFiles.length > 0
      ? `Current tasks: ${taskFiles.join(", ")}`
      : `No active tasks for ${params.agent}`,
    data: { tasks: taskFiles },
  }
}

export async function handleAgentCheckScope(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.checkScope",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const item = params.item as string | undefined
  if (!item) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.checkScope missing item parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: item" }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.checkScope",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Scope check for: ${item}`,
    data: { item, inScope: true, reason: "MVP: scope check requires inference — defaulting to in-scope" },
  }
}

export async function handleAgentRequestDecision(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.requestDecision",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const topic = params.topic as string | undefined
  if (!topic) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.requestDecision missing topic parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: topic" }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.requestDecision",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Decision request queued: ${topic}`,
    data: {
      topic,
      options: params.options ?? null,
      status: "pending",
      note: "MVP: decision requires inference — queued for agent review",
    },
  }
}

export async function handleAgentCheckGuidance(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.checkGuidance",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const topic = params.topic as string | undefined
  if (!topic) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.checkGuidance missing topic parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: topic" }
  }

  // MVP: check memory for relevant guidance
  const memoryContent = readAgentMemory(params.agent)
  let guidance = `No specific guidance found for: ${topic}`
  if (memoryContent) {
    const lines = memoryContent.split("\n")
    const topicLower = topic.toLowerCase()
    const relevant = lines.filter((line) => line.toLowerCase().includes(topicLower))
    if (relevant.length > 0) {
      guidance = `Relevant guidance:\n${relevant.slice(0, 10).join("\n")}`
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.checkGuidance",
    meta: { agent: params.agent },
  })

  return { ok: true, message: guidance }
}

export async function handleAgentReportProgress(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.reportProgress",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const summary = params.summary as string | undefined
  if (!summary) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.reportProgress missing summary parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: summary" }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.reportProgress",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Progress noted: ${summary}`,
    data: { summary, receivedAt: new Date().toISOString() },
  }
}

export async function handleAgentReportBlocker(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.reportBlocker",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const blocker = params.blocker as string | undefined
  if (!blocker) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.reportBlocker missing blocker parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: blocker" }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.reportBlocker",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Blocker reported: ${blocker}`,
    data: { blocker, receivedAt: new Date().toISOString() },
  }
}

export async function handleAgentReportComplete(params: AgentServiceParams): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_start",
    message: "handling agent.reportComplete",
    meta: { agent: params.agent, friendId: params.friendId },
  })

  const summary = params.summary as string | undefined
  if (!summary) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_service_error",
      message: "agent.reportComplete missing summary parameter",
      meta: { agent: params.agent },
    })
    return { ok: false, error: "Missing required parameter: summary" }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_service_end",
    message: "completed agent.reportComplete",
    meta: { agent: params.agent },
  })

  return {
    ok: true,
    message: `Completion reported: ${summary}`,
    data: { summary, receivedAt: new Date().toISOString() },
  }
}
