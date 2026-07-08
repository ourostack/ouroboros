import type OpenAI from "openai"

import { attachCodingSessionFeedback, formatCodingTail, getCodingSessionManager } from "./index"
import { prepareCodingContextPack } from "./context-pack"
import type { ToolContext, ToolDefinition } from "../tools-base"
import { getAgentRoot } from "../../heart/identity"
import { advanceObligation, createObligation, findPendingObligationForOrigin } from "../../arc/obligations"
import { consumeEvolutionBudget, evaluateEvolutionAction, type EvolutionActionDecision } from "../../arc/evolution"
import { emitNervesEvent } from "../../nerves/runtime"
import { getCodingCompletionScrutiny } from "../../mind/scrutiny"
import type { CodingActionResult, CodingRunner, CodingSession, CodingSessionManagerApi, CodingSessionRequest, RefreshableCodingSessionManagerApi } from "./types"

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

function optionalArg(args: Record<string, string>, key: string): string | undefined {
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

function isRefreshableCodingSessionManager(manager: CodingSessionManagerApi): manager is RefreshableCodingSessionManagerApi {
  return typeof (manager as Partial<RefreshableCodingSessionManagerApi>).refreshSessions === "function"
    && typeof (manager as Partial<RefreshableCodingSessionManagerApi>).refreshSession === "function"
}

async function listCodingSessions(manager: CodingSessionManagerApi): Promise<CodingSession[]> {
  return isRefreshableCodingSessionManager(manager) ? manager.refreshSessions() : manager.listSessions()
}

async function getCodingSession(manager: CodingSessionManagerApi, sessionId: string): Promise<CodingSession | null> {
  return isRefreshableCodingSessionManager(manager) ? manager.refreshSession(sessionId) : manager.getSession(sessionId)
}

async function sendCodingInput(manager: CodingSessionManagerApi, sessionId: string, input: string): Promise<CodingActionResult> {
  return manager.sendInput(sessionId, input)
}

async function killCodingSession(manager: CodingSessionManagerApi, sessionId: string): Promise<CodingActionResult> {
  return manager.killSession(sessionId)
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
  const evolutionCaseMatches = request.evolutionCaseId ? session.evolutionCaseId === request.evolutionCaseId : true

  return (
    session.runner === request.runner &&
    session.workdir === request.workdir &&
    session.taskRef === request.taskRef &&
    scopeMatches &&
    stateMatches &&
    evolutionCaseMatches &&
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

function blockedEvolutionSpawnResult(evolutionCaseId: string, decision: EvolutionActionDecision): string {
  return JSON.stringify({
    ok: false,
    blocked: true,
    action: "spawn_coding",
    evolutionCaseId,
    code: decision.code,
    reason: decision.reason,
  })
}

function recordBlockedEvolutionSpawn(agentRoot: string, evolutionCaseId: string, decision: EvolutionActionDecision): void {
  if (decision.code === "case_not_found") return
  try {
    consumeEvolutionBudget(agentRoot, evolutionCaseId, "spawn_coding", {
      reason: `coding_spawn blocked: ${decision.reason}`,
    })
  } catch {
    // consumeEvolutionBudget records the block before throwing.
  }
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
        evolutionCaseId: { type: "string" },
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

export const codingToolDefinitions: ToolDefinition[] = [
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
      const evolutionCaseId = optionalArg(args, "evolutionCaseId")
      if (evolutionCaseId) request.evolutionCaseId = evolutionCaseId

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
      const existingSessions = await listCodingSessions(manager)
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

      if (request.evolutionCaseId) {
        const decision = evaluateEvolutionAction(getAgentRoot(), request.evolutionCaseId, "spawn_coding")
        if (!decision.allowed) {
          recordBlockedEvolutionSpawn(getAgentRoot(), request.evolutionCaseId, decision)
          return blockedEvolutionSpawnResult(request.evolutionCaseId, decision)
        }
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
      if (request.evolutionCaseId) {
        consumeEvolutionBudget(getAgentRoot(), request.evolutionCaseId, "spawn_coding", {
          target: session.id,
          reason: `coding session ${session.id} spawned`,
        })
      }
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
    riskProfile: {
      mutates: ["durable_state_write", "external_side_effect"] as const,
      risk: "high",
      reason: "spawns a separate coding process and may create obligations",
    },
  },
  {
    tool: codingStatusTool,
    handler: async (args: Record<string, string>, ctx?: ToolContext): Promise<string> => {
      emitCodingToolEvent("coding_status")
      const manager = getCodingSessionManager()
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) {
        return JSON.stringify(selectCodingStatusSessions(await listCodingSessions(manager), ctx?.currentSession))
      }

      const session = await getCodingSession(manager, sessionId)
      if (!session) return `session not found: ${sessionId}`
      return appendCompletionScrutiny(JSON.stringify(session), session)
    },
    summaryKeys: ["sessionId"],
  },
  {
    tool: codingTailTool,
    handler: async (args: Record<string, string>): Promise<string> => {
      emitCodingToolEvent("coding_tail")
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) return "sessionId is required"

      const session = await getCodingSession(getCodingSessionManager(), sessionId)
      if (!session) return `session not found: ${sessionId}`
      return appendCompletionScrutiny(formatCodingTail(session), session)
    },
    summaryKeys: ["sessionId"],
  },
  {
    tool: codingSendInputTool,
    handler: async (args: Record<string, string>): Promise<string> => {
      emitCodingToolEvent("coding_send_input")
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) return "sessionId is required"

      const input = requireArg(args, "input")
      if (!input) return "input is required"

      return JSON.stringify(await sendCodingInput(getCodingSessionManager(), sessionId, input))
    },
    summaryKeys: ["sessionId", "input"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends input to a live coding process" },
  },
  {
    tool: codingKillTool,
    handler: async (args: Record<string, string>): Promise<string> => {
      emitCodingToolEvent("coding_kill")
      const sessionId = requireArg(args, "sessionId")
      if (!sessionId) return "sessionId is required"

      return JSON.stringify(await killCodingSession(getCodingSessionManager(), sessionId))
    },
    summaryKeys: ["sessionId"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "terminates a live coding process" },
  },
]
