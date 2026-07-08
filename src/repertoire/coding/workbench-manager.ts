import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import { buildCodingPrompt } from "./spawner"
import type {
  CodingActionResult,
  CodingFailureDiagnostics,
  CodingRunner,
  CodingSession,
  CodingSessionManagerApi,
  CodingSessionRequest,
  CodingSessionUpdate,
  RefreshableCodingSessionManagerApi,
} from "./types"
import {
  WorkbenchMcpClient,
  type WorkbenchActionResult,
  type WorkbenchCreateCodingSessionResult,
  type WorkbenchSession,
} from "./workbench-client"

type ReadText = (target: string, encoding: "utf-8") => string

export interface WorkbenchCodingSessionManagerOptions {
  client: Pick<
    WorkbenchMcpClient,
    "createCodingSession" | "listSessions" | "transcriptTail" | "requestAction" | "waitForAction"
  >
  agentName: string
  nowIso?: () => string
  existsSync?: (target: string) => boolean
  readFileSync?: ReadText
  source?: string
}

interface WorkbenchCodingSessionRecord {
  request: CodingSessionRequest
  session: CodingSession
}

function cloneSession(session: CodingSession): CodingSession {
  return {
    ...session,
    originSession: session.originSession ? { ...session.originSession } : undefined,
    failure: session.failure ? { ...session.failure, args: [...session.failure.args] } : null,
  }
}

function sanitizeNamePart(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return sanitized.length > 0 ? sanitized : fallback
}

function timestampPart(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("Z", "Z")
}

function sessionNameForRequest(request: CodingSessionRequest, nowIso: string): string {
  return [
    "coding",
    request.runner,
    sanitizeNamePart(request.taskRef, "task"),
    timestampPart(nowIso),
  ].join("-")
}

function commandForRunner(runner: CodingRunner): string {
  return runner === "claude" ? "claude" : "codex"
}

function runnerFromWorkbenchSession(session: WorkbenchSession, fallback: CodingRunner): CodingRunner {
  const name = session.name.toLowerCase()
  if (name.includes("claude")) return "claude"
  if (name.includes("codex")) return "codex"
  return fallback
}

function mapWorkbenchStatus(session: WorkbenchSession): CodingSession["status"] {
  switch (session.status) {
    case "configured":
    case "running":
      return "running"
    case "waitingForInput":
      return "waiting_input"
    case "exited":
      return session.exitCode === 0 ? "completed" : "failed"
    case "needsRecovery":
    case "manualActionNeeded":
      return "stalled"
    default:
      return "running"
  }
}

function checkpointFor(session: WorkbenchSession, status: CodingSession["status"]): string | null {
  if (session.attentionPrompt?.trim()) return session.attentionPrompt.trim()
  if (session.attentionReason?.trim()) return session.attentionReason.trim()
  if (session.attention?.trim()) return session.attention.trim()
  if (status === "completed") return "completed"
  if (status === "failed") return session.exitCode === undefined ? "exited" : `exit code ${session.exitCode}`
  if (status === "stalled") return "needs Workbench recovery"
  return null
}

function failureFor(session: WorkbenchSession, command: string): CodingFailureDiagnostics | null {
  if (mapWorkbenchStatus(session) !== "failed") return null
  return {
    command,
    args: [],
    code: session.exitCode ?? null,
    signal: null,
    stdoutTail: "",
    stderrTail: checkpointFor(session, "failed")!,
  }
}

function resultToActionResult(action: string, sessionId: string, result: WorkbenchActionResult): CodingActionResult {
  if (result.state === "applied" || result.state === "appliedUnconfirmed") {
    return { ok: true, message: `${action} applied for ${sessionId}` }
  }
  if (result.state === "queued") {
    return { ok: false, message: `${action} queued for ${sessionId} but not confirmed` }
  }
  return { ok: false, message: result.result ?? `${action} ${result.state} for ${sessionId}` }
}

function promptDeliveryFailure(result: WorkbenchCreateCodingSessionResult): string | null {
  const sessionId = result.session.id
  if (result.promptAck.ok === false) {
    return `Workbench denied initial prompt for ${sessionId}`
  }

  switch (result.promptResult?.state) {
    case "applied":
    case "appliedUnconfirmed":
      return null
    case "failed":
      return `Workbench failed initial prompt for ${sessionId}`
    case "queued":
      return `Workbench queued initial prompt for ${sessionId} but did not confirm delivery`
    case "unknown":
    case undefined:
      return `Workbench did not confirm initial prompt delivery for ${sessionId}`
  }
}

export class WorkbenchCodingSessionManager implements CodingSessionManagerApi, RefreshableCodingSessionManagerApi {
  private readonly records = new Map<string, WorkbenchCodingSessionRecord>()
  private readonly listeners = new Map<string, Set<(update: CodingSessionUpdate) => void | Promise<void>>>()
  private readonly client: NonNullable<WorkbenchCodingSessionManagerOptions["client"]>
  private readonly agentName: string
  private readonly nowIso: () => string
  private readonly existsSync: (target: string) => boolean
  private readonly readFileSync: ReadText
  private readonly source: string

  constructor(options: WorkbenchCodingSessionManagerOptions) {
    this.client = options.client
    this.agentName = options.agentName
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.existsSync = options.existsSync ?? fs.existsSync
    this.readFileSync = options.readFileSync ?? fs.readFileSync
    this.source = options.source ?? "ouro-coding"
  }

  async spawnSession(request: CodingSessionRequest): Promise<CodingSession> {
    const now = this.nowIso()
    const name = sessionNameForRequest(request, now)
    const normalizedRequest: CodingSessionRequest & { parentAgent: string } = {
      ...request,
      parentAgent: request.parentAgent ?? this.agentName,
    }
    const prompt = buildCodingPrompt(normalizedRequest, {
      existsSync: this.existsSync,
      readFileSync: this.readFileSync,
    })
    const result = await this.client.createCodingSession({
      owner: normalizedRequest.parentAgent,
      name,
      command: commandForRunner(normalizedRequest.runner),
      workingDirectory: normalizedRequest.workdir,
      prompt,
      group: path.basename(normalizedRequest.workdir),
      trust: "trusted",
      autoResume: normalizedRequest.autoRestartOnCrash !== false,
      source: this.source,
    })
    const promptFailure = promptDeliveryFailure(result)
    if (promptFailure) {
      throw new Error(promptFailure)
    }

    const session = this.toCodingSession(result.session, normalizedRequest)
    this.records.set(session.id, { request: normalizedRequest, session })

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.workbench_coding_session_spawned",
      message: "Workbench coding session spawned",
      meta: { id: session.id, runner: session.runner, workdir: session.workdir },
    })

    this.notifyListeners(session.id, { kind: "spawned", session: cloneSession(session) })
    return cloneSession(session)
  }

  async refreshSessions(): Promise<CodingSession[]> {
    const workbenchSessions = await this.client.listSessions({ owner: this.agentName, includeArchived: true })
    for (const workbenchSession of workbenchSessions) {
      if (!workbenchSession.name.toLowerCase().startsWith("coding-")) continue
      const existing = this.records.get(workbenchSession.id)
      const fallbackRequest = existing?.request ?? this.fallbackRequest(workbenchSession)
      const session = this.toCodingSession(workbenchSession, fallbackRequest, existing?.session)
      this.records.set(session.id, { request: fallbackRequest, session })
    }
    return this.listSessions()
  }

  async refreshSession(sessionId: string): Promise<CodingSession | null> {
    const sessions = await this.refreshSessions()
    const session = sessions.find((item) => item.id === sessionId) ?? null
    if (!session) return null

    const tail = await this.client.transcriptTail(sessionId)
    const record = this.records.get(sessionId)!
    record.session.stdoutTail = tail
    record.session.lastActivityAt = this.nowIso()
    record.session.checkpoint = tail.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? record.session.checkpoint
    return cloneSession(record.session)
  }

  listSessions(): CodingSession[] {
    return [...this.records.values()]
      .map((record) => cloneSession(record.session))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  getSession(sessionId: string): CodingSession | null {
    const record = this.records.get(sessionId)
    return record ? cloneSession(record.session) : null
  }

  subscribe(sessionId: string, listener: (update: CodingSessionUpdate) => void | Promise<void>): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<(update: CodingSessionUpdate) => void | Promise<void>>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      const current = this.listeners.get(sessionId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(sessionId)
    }
  }

  async sendInput(sessionId: string, input: string): Promise<CodingActionResult> {
    return this.queueAction(sessionId, "sendInput", { text: input, appendNewline: true })
  }

  async killSession(sessionId: string): Promise<CodingActionResult> {
    const actionResult = await this.queueAction(sessionId, "terminate", {})
    if (actionResult.ok) {
      const record = this.records.get(sessionId)!
      record.session.status = "killed"
      record.session.endedAt = this.nowIso()
      record.session.checkpoint = "terminated by parent agent"
      this.notifyListeners(sessionId, { kind: "killed", session: cloneSession(record.session) })
    }
    return actionResult
  }

  checkStalls(): number {
    return 0
  }

  shutdown(): void {
    this.listeners.clear()
  }

  private async queueAction(
    sessionId: string,
    action: "sendInput" | "terminate",
    extra: Record<string, unknown>,
  ): Promise<CodingActionResult> {
    let record = this.records.get(sessionId)
    if (!record) {
      await this.refreshSessions()
      record = this.records.get(sessionId)
    }
    if (!record) {
      return { ok: false, message: `session not found: ${sessionId}` }
    }

    const ack = await this.client.requestAction({
      source: this.source,
      action,
      entry: sessionId,
      ...extra,
    })
    if (!ack.requestId) {
      return { ok: ack.ok === true, message: ack.message ?? `${action} queued for ${sessionId}` }
    }

    const result = await this.client.waitForAction(ack.requestId)
    const actionResult = resultToActionResult(action, sessionId, result)
    if (actionResult.ok && action === "sendInput") {
      record.session.status = "running"
      record.session.lastActivityAt = this.nowIso()
      this.notifyListeners(sessionId, { kind: "progress", session: cloneSession(record.session) })
    }
    return actionResult
  }

  private fallbackRequest(session: WorkbenchSession): CodingSessionRequest {
    const runner = runnerFromWorkbenchSession(session, "codex")
    return {
      runner,
      workdir: session.workingDirectory ?? "",
      prompt: "",
      taskRef: session.name,
      parentAgent: this.agentName,
      autoRestartOnCrash: session.autoResume,
    }
  }

  private toCodingSession(
    workbenchSession: WorkbenchSession,
    request: CodingSessionRequest,
    previous?: CodingSession,
  ): CodingSession {
    const runner = runnerFromWorkbenchSession(workbenchSession, request.runner)
    const status = mapWorkbenchStatus(workbenchSession)
    const workdir = workbenchSession.workingDirectory ?? request.workdir
    const lastActivityAt = workbenchSession.lastOutputAt ?? workbenchSession.startedAt ?? previous?.lastActivityAt ?? this.nowIso()
    const startedAt = workbenchSession.startedAt ?? previous?.startedAt ?? this.nowIso()
    const command = commandForRunner(runner)

    return {
      id: workbenchSession.id,
      runner,
      workdir,
      taskRef: request.taskRef,
      originSession: request.originSession ? { ...request.originSession } : undefined,
      obligationId: request.obligationId,
      evolutionCaseId: request.evolutionCaseId,
      scopeFile: request.scopeFile,
      stateFile: request.stateFile,
      checkpoint: checkpointFor(workbenchSession, status),
      artifactPath: workbenchSession.transcriptPath,
      status,
      stdoutTail: previous?.stdoutTail ?? "",
      stderrTail: previous?.stderrTail ?? "",
      pid: workbenchSession.pid ?? null,
      startedAt,
      lastActivityAt,
      endedAt: status === "completed" || status === "failed" ? lastActivityAt : null,
      restartCount: previous?.restartCount ?? 0,
      lastExitCode: workbenchSession.exitCode ?? null,
      lastSignal: null,
      failure: failureFor(workbenchSession, command),
    }
  }

  private notifyListeners(sessionId: string, update: CodingSessionUpdate): void {
    const listeners = this.listeners.get(sessionId)
    if (!listeners || listeners.size === 0) return
    for (const listener of listeners) {
      void Promise.resolve(listener(update))
    }
  }
}
