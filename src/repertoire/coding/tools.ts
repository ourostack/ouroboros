import type OpenAI from "openai"

import { attachCodingSessionFeedback, formatCodingTail, getCodingSessionManager } from "./index"
import { prepareCodingContextPack } from "./context-pack"
import type { ToolContext } from "../tools-base"
import { getAgentRoot } from "../../heart/identity"
import { advanceObligation, createObligation, findPendingObligationForOrigin } from "../../heart/obligations"
import { emitNervesEvent } from "../../nerves/runtime"
import { getCodingCompletionScrutiny } from "../../mind/scrutiny"
import type { CodingRunner, CodingSession, CodingSessionRequest } from "./types"

const RUNNERS: CodingRunner[] = ["claude", "codex"]

function requireArg(args: Record<string, string>, key: string): string | null {
  const value = args[key]
  if (!value || value.trim().length === 0) {
    return null
  }
  return value.trim()
}

function parseRunner(value: string): CodingRunner | null {
  return RUNNERS.includes(value as CodingRunner) ? (value as CodingRunner) : null
}

function optionalArg(args: Record<string, string>, key: "taskRef" | "scopeFile" | "stateFile"): string | undefined {
  const raw = args[key]
  if (!raw) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function emitCodingToolEvent(toolName: string): void {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_tool_call",
    message: "coding tool handler invoked",
    meta: { toolName },
  })
}

/**
 * Count distinct file paths mentioned in a coding session's stdout output.
 * Looks for path-like tokens (containing / and a file extension).
 * Returns the count of unique paths found.
 */
export function countFilesInSessionOutput(session: CodingSession): number {
  const text = `${session.stdoutTail}\n${session.stderrTail}`
  // Match path-like tokens: contain at least one / and a file extension
  const pathPattern = /(?:^|\s)((?:\/|\.\/|\.\.\/)?(?:[\w.@-]+\/)+[\w.-]+\.[\w]+)/gm
  const paths = new Set<string>()
  let match
  while ((match = pathPattern.exec(text)) !== null) {
    paths.add(match[1])
  }
  return paths.size
}

/**
 * If a coding session is completed, append scrutiny to the result.
 * Returns the original result with scrutiny appended, or unchanged if
 * the session is not completed or has no file changes.
 */
function appendCompletionScrutiny(result: string, session: CodingSession): string {
  if (session.status !== "completed") return result
  const fileCount = countFilesInSessionOutput(session)
  const scrutiny = getCodingCompletionScrutiny(fileCount)
  return scrutiny ? `${result}\n\n${scrutiny}` : result
}

function sameOriginSession(
  left: CodingSessionRequest["originSession"],
  right: CodingSession["originSession"],
): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.friendId === right.friendId && left.channel === right.channel && left.key === right.key
}

function matchesReusableCodingSession(session: CodingSession, request: CodingSessionRequest): boolean {
  if (session.status !== "spawning" && session.status !== "running" && session.status !== "waiting_input" && session.status !== "stalled") {
    return false
  }

  const scopeMatches = request.scopeFile ? session.scopeFile === request.scopeFile : true
  const stateMatches = request.stateFile ? session.stateFile === request.stateFile : true

  return (
    session.runner === request.runner &&
    session.workdir === request.workdir &&
    session.taskRef === request.taskRef &&
    scopeMatches &&
    stateMatches &&
    session.obligationId === request.obligationId &&
    sameOriginSession(request.originSession, session.originSession)
  )
}

function latestSessionFirst(left: CodingSession, right: CodingSession): number {
  const lastActivityDelta = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
  if (lastActivityDelta !== 0) return lastActivityDelta
  return right.id.localeCompare(left.id)
}

function findReusableCodingSession(sessions: CodingSession[], request: CodingSessionRequest): CodingSession | null {
  const matches = sessions.filter((session) => matchesReusableCodingSession(session, request)).sort(latestSessionFirst)
  return matches[0] ?? null
}

function isLiveCodingStatus(status: CodingSession["status"]): boolean {
  return status === "spawning" || status === "running" || status === "waiting_input" || status === "stalled"
}

function rankCodingStatusSession(
  session: CodingSession,
  currentSession: NonNullable<ToolContext["currentSession"]>,
): number {
  return sameOriginSession(
    {
      friendId: currentSession.friendId,
      channel: currentSession.channel,
      key: currentSession.key,
    },
    session.originSession,
  )
    ? 0
    : 1
}

function selectCodingStatusSessions(
  sessions: CodingSession[],
  currentSession?: ToolContext["currentSession"],
): CodingSession[] {
  if (sessions.length === 0) return []
  if (!currentSession) {
    return sessions
  }

  const activeSessions = sessions.filter((session) => isLiveCodingStatus(session.status)).sort(latestSessionFirst)
  if (activeSessions.length > 0) {
    return activeSessions.sort((left, right) => {
      const rankDelta = rankCodingStatusSession(left, currentSession) - rankCodingStatusSession(right, currentSession)
      if (rankDelta !== 0) return rankDelta
      return latestSessionFirst(left, right)
    })
  }

  const matchingClosedSessions = sessions
    .filter((session) =>
      sameOriginSession(
        {
          friendId: currentSession.friendId,
          channel: currentSession.channel,
          key: currentSession.key,
        },
        session.originSession,
      ),
    )
    .sort(latestSessionFirst)
  if (matchingClosedSessions.length > 0) {
    return matchingClosedSessions
  }

  return [...sessions].sort(latestSessionFirst)
}

function buildCodingObligationContent(taskRef: string): string {
  return `finish ${taskRef} and bring the result back`
}

const codingSpawnTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "coding_spawn",
    description: "Spawn a coding session using claude or codex with task-threaded guidance. The coding session runs as a separate process with its own context. Give it a COMPLETE, SELF-CONTAINED task description -- it cannot see this conversation, doesn't know what you've tried, doesn't understand the broader context. Include: what to do, why, what files are involved, what 'done' looks like. Never delegate understanding -- don't write 'based on the conversation, fix the bug.' Write the specific file paths, line numbers, and what to change. Include any required verification steps or tests in the task description so the coding session knows how to prove the work is done.",
    parameters: {
      type: "object",
      properties: {
        runner: { type: "string", enum: ["claude", "codex"] },
        workdir: { type: "string" },
        prompt: { type: "string" },
        taskRef: { type: "string" },
        scopeFile: { type: "string" },
        stateFile: { type: "string" },
      },
      required: ["runner", "workdir", "prompt", "taskRef"],
    },
  },
}

const codingStatusTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "coding_status",
    description: "Inspect coding sessions. Omit sessionId to list all active/known sessions with their status. Use this to check progress before asking the human for a status update.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
    },
  },
}

const codingTailTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "coding_tail",
    description: "Show recent stdout/stderr output from a coding session. Use this to understand what the session is doing or why it might be stuck. Read the actual output before reporting status -- don't guess.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
}

const codingSendInputTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "coding_send_input",
    description: "send stdin text to an existing coding session",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        input: { type: "string" },
      },
      required: ["sessionId", "input"],
    },
  },
}

const codingKillTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "coding_kill",
    description: "terminate an existing coding session",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
}

export const codingToolDefinitions = [
  {
    tool: codingSpawnTool,
    handler: async (args: Record<string, string>, ctx?: ToolContext): Promise<string> => {
      emitCodingToolEvent("coding_spawn")
      const rawRunner = requireArg(args, "runner")
      if (!rawRunner) return "runner is required"
      const runner = parseRunner(rawRunner)
      if (!runner) return `invalid runner: ${rawRunner}`

      const workdir = requireArg(args, "workdir")
      if (!workdir) return "workdir is required"

      const prompt = requireArg(args, "prompt")
      if (!prompt) return "prompt is required"

      const taskRef = requireArg(args, "taskRef")
      if (!taskRef) return "taskRef is required"

      const request: CodingSessionRequest = {
        runner,
        workdir,
        prompt,
        taskRef,
      }

      if (ctx?.currentSession && ctx.currentSession.channel !== "inner") {
        request.originSession = {
          friendId: ctx.currentSession.friendId,
          channel: ctx.currentSession.channel,
          key: ctx.currentSession.key,
        }
        const obligation = findPendingObligationForOrigin(getAgentRoot(), request.originSession)
        if (obligation) {
          request.obligationId = obligation.id
        }
      }

      const scopeFile = optionalArg(args, "scopeFile")
      if (scopeFile) request.scopeFile = scopeFile
      const stateFile = optionalArg(args, "stateFile")
      if (stateFile) request.stateFile = stateFile

      const manager = getCodingSessionManager()
      const existingSessions = manager.listSessions()
      const existingSession = findReusableCodingSession(existingSessions, request)
      if (existingSession) {
        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.coding_session_reused",
          message: "reused active coding session",
          meta: { id: existingSession.id, runner: existingSession.runner, taskRef: existingSession.taskRef },
        })
        if (ctx?.codingFeedback) {
          attachCodingSessionFeedback(manager, existingSession, ctx.codingFeedback)
        }
        return JSON.stringify({ ...existingSession, reused: true })
      }

      if (request.originSession && !request.obligationId) {
        const created = createObligation(getAgentRoot(), {
          origin: request.originSession,
          content: buildCodingObligationContent(taskRef),
        })
        request.obligationId = created.id
      }

      if (!request.scopeFile || !request.stateFile) {
        const generated = prepareCodingContextPack({
          request: { ...request },
          existingSessions,
          activeWorkFrame: ctx?.activeWorkFrame,
        })
        if (!request.scopeFile) request.scopeFile = generated.scopeFile
        if (!request.stateFile) request.stateFile = generated.stateFile
      }

      const session = await manager.spawnSession(request)
      if (session.obligationId) {
        advanceObligation(getAgentRoot(), session.obligationId, {
          status: "investigating",
          currentSurface: { kind: "coding", label: `${session.runner} ${session.id}` },
          latestNote: session.originSession
            ? `coding session started for ${session.originSession.channel}/${session.originSession.key}`
            : "coding session started",
        })
      }
      if (args.runner === "codex" && args.taskRef) {
        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.coding_codex_spawned",
          message: "spawned codex coding session",
          meta: { sessionId: session.id, taskRef: args.taskRef },
        })
      }
      if (ctx?.codingFeedback) {
        attachCodingSessionFeedback(manager, session, ctx.codingFeedback)
      }
      return JSON.stringify(session)
    },
    summaryKeys: ["runner", "workdir", "taskRef"],
  },
  {
    tool: codingStatusTool,
    handler: (args: Record<string, string>, ctx?: ToolContext): string => {
      emitCodingToolEvent("coding_status")
      const manager = getCodingSessionManager()
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) {
        return JSON.stringify(selectCodingStatusSessions(manager.listSessions(), ctx?.currentSession))
      }

      const session = manager.getSession(sessionId)
      if (!session) return `session not found: ${sessionId}`
      return appendCompletionScrutiny(JSON.stringify(session), session)
    },
    summaryKeys: ["sessionId"],
  },
  {
    tool: codingTailTool,
    handler: (args: Record<string, string>): string => {
      emitCodingToolEvent("coding_tail")
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) return "sessionId is required"

      const session = getCodingSessionManager().getSession(sessionId)
      if (!session) return `session not found: ${sessionId}`
      return appendCompletionScrutiny(formatCodingTail(session), session)
    },
    summaryKeys: ["sessionId"],
  },
  {
    tool: codingSendInputTool,
    handler: (args: Record<string, string>): string => {
      emitCodingToolEvent("coding_send_input")
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) return "sessionId is required"

      const input = requireArg(args, "input")
      if (!input) return "input is required"

      return JSON.stringify(getCodingSessionManager().sendInput(sessionId, input))
    },
    summaryKeys: ["sessionId", "input"],
  },
  {
    tool: codingKillTool,
    handler: (args: Record<string, string>): string => {
      emitCodingToolEvent("coding_kill")
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) return "sessionId is required"

      return JSON.stringify(getCodingSessionManager().killSession(sessionId))
    },
    summaryKeys: ["sessionId"],
  },
]
