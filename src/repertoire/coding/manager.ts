import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { getAgentName } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { spawnCodingProcess, type CodingProcess, type SpawnCodingResult } from "./spawner"
import type { CodingActionResult, CodingFailureDiagnostics, CodingSession, CodingSessionRequest } from "./types"

interface CodingSessionRecord {
  request: CodingSessionRequest
  session: CodingSession
  process: CodingProcess | null
  command: string
  args: string[]
  stdoutTail: string
  stderrTail: string
}

interface PersistedCodingSessionRecord {
  request: CodingSessionRequest
  session: CodingSession
}

interface PersistedCodingState {
  sequence: number
  records: PersistedCodingSessionRecord[]
}

type SpawnProcessResult = CodingProcess | SpawnCodingResult

type ReadText = (target: string, encoding: "utf-8") => string
type WriteText = (target: string, content: string, encoding: "utf-8") => void
type Mkdir = (target: string, options: { recursive?: boolean }) => void

export interface CodingSessionManagerOptions {
  spawnProcess?: (request: CodingSessionRequest) => SpawnProcessResult
  nowIso?: () => string
  maxRestarts?: number
  defaultStallThresholdMs?: number
  stateFilePath?: string
  existsSync?: (target: string) => boolean
  readFileSync?: ReadText
  writeFileSync?: WriteText
  mkdirSync?: Mkdir
  pidAlive?: (pid: number) => boolean
  agentName?: string
}

function safeAgentName(): string {
  try {
    return getAgentName()
  } catch {
    return "default"
  }
}

function defaultStateFilePath(agentName: string): string {
  return path.join(os.homedir(), ".agentstate", agentName, "coding", "sessions.json")
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function cloneSession(session: CodingSession): CodingSession {
  return {
    ...session,
    stdoutTail: session.stdoutTail,
    stderrTail: session.stderrTail,
    failure: session.failure
      ? {
          ...session.failure,
          args: [...session.failure.args],
        }
      : null,
  }
}

function extractSequence(id: string): number {
  const match = /^coding-(\d+)$/.exec(id)
  if (!match) return 0
  return Number.parseInt(match[1], 10)
}

function isActiveSessionStatus(status: CodingSession["status"]): boolean {
  return status === "spawning" || status === "running" || status === "waiting_input" || status === "stalled"
}

function appendTail(existing: string, nextChunk: string, maxLength = 2000): string {
  const combined = `${existing}${nextChunk}`
  return combined.length <= maxLength ? combined : combined.slice(combined.length - maxLength)
}

function isSpawnCodingResult(value: SpawnProcessResult): value is SpawnCodingResult {
  return typeof value === "object" && value !== null && "process" in value
}

function normalizeSpawnResult(result: SpawnProcessResult): SpawnCodingResult {
  if (isSpawnCodingResult(result)) {
    return {
      process: result.process,
      command: result.command,
      args: [...result.args],
      prompt: result.prompt,
    }
  }

  return {
    process: result,
    command: "unknown",
    args: [],
    prompt: "",
  }
}

function defaultFailureDiagnostics(
  code: number | null,
  signal: NodeJS.Signals | null,
  command: string,
  args: string[],
  stdoutTail: string,
  stderrTail: string,
): CodingFailureDiagnostics {
  return {
    command,
    args: [...args],
    code,
    signal,
    stdoutTail: stdoutTail.trim(),
    stderrTail: stderrTail.trim(),
  }
}

export class CodingSessionManager {
  private readonly records = new Map<string, CodingSessionRecord>()
  private readonly spawnProcess: (request: CodingSessionRequest) => SpawnProcessResult
  private readonly nowIso: () => string
  private readonly maxRestarts: number
  private readonly defaultStallThresholdMs: number
  private readonly stateFilePath: string
  private readonly existsSync: (target: string) => boolean
  private readonly readFileSync: ReadText
  private readonly writeFileSync: WriteText
  private readonly mkdirSync: Mkdir
  private readonly pidAlive: (pid: number) => boolean
  private readonly agentName: string
  private sequence = 0

  constructor(options: CodingSessionManagerOptions) {
    this.spawnProcess = options.spawnProcess ?? ((request) => spawnCodingProcess(request))
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.maxRestarts = options.maxRestarts ?? 1
    this.defaultStallThresholdMs = options.defaultStallThresholdMs ?? 5 * 60_000
    this.existsSync = options.existsSync ?? fs.existsSync
    this.readFileSync = options.readFileSync ?? fs.readFileSync
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync
    this.mkdirSync = options.mkdirSync ?? fs.mkdirSync
    this.pidAlive = options.pidAlive ?? isPidAlive
    this.agentName = options.agentName ?? safeAgentName()
    this.stateFilePath = options.stateFilePath ?? defaultStateFilePath(this.agentName)

    this.loadPersistedState()
  }

  async spawnSession(request: CodingSessionRequest): Promise<CodingSession> {
    this.sequence += 1
    const id = `coding-${String(this.sequence).padStart(3, "0")}`
    const now = this.nowIso()

    const normalizedRequest: CodingSessionRequest = {
      ...request,
      sessionId: id,
      parentAgent: request.parentAgent ?? this.agentName,
    }

    const session: CodingSession = {
      id,
      runner: normalizedRequest.runner,
      workdir: normalizedRequest.workdir,
      taskRef: normalizedRequest.taskRef,
      scopeFile: normalizedRequest.scopeFile,
      stateFile: normalizedRequest.stateFile,
      status: "spawning",
      stdoutTail: "",
      stderrTail: "",
      pid: null,
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    }

    const spawned = normalizeSpawnResult(this.spawnProcess(normalizedRequest))
    session.pid = spawned.process.pid ?? null
    session.status = "running"

    const record: CodingSessionRecord = {
      request: normalizedRequest,
      session,
      process: spawned.process,
      command: spawned.command,
      args: [...spawned.args],
      stdoutTail: "",
      stderrTail: "",
    }
    this.records.set(id, record)

    this.attachProcessListeners(record)

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_session_spawned",
      message: "coding session spawned",
      meta: { id, runner: normalizedRequest.runner, pid: session.pid },
    })

    this.persistState()
    return cloneSession(session)
  }

  listSessions(): CodingSession[] {
    return [...this.records.values()]
      .map((record) => cloneSession(record.session))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  getSession(sessionId: string): CodingSession | null {
    const record = this.records.get(sessionId)
    return record ? cloneSession(record.session) : null
  }

  sendInput(sessionId: string, input: string): CodingActionResult {
    const record = this.records.get(sessionId)
    if (!record || !record.process) {
      return { ok: false, message: `session not found: ${sessionId}` }
    }

    record.process.stdin.write(`${input}\n`)
    record.session.lastActivityAt = this.nowIso()
    if (record.session.status === "waiting_input" || record.session.status === "stalled") {
      record.session.status = "running"
    }

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_session_input",
      message: "forwarded input to coding session",
      meta: { id: sessionId },
    })

    this.persistState()
    return { ok: true, message: `input sent to ${sessionId}` }
  }

  killSession(sessionId: string): CodingActionResult {
    const record = this.records.get(sessionId)
    if (!record || !record.process) {
      return { ok: false, message: `session not found: ${sessionId}` }
    }

    record.process.kill("SIGTERM")
    record.process = null
    record.session.status = "killed"
    record.session.endedAt = this.nowIso()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_session_killed",
      message: "coding session terminated",
      meta: { id: sessionId },
    })

    this.persistState()
    return { ok: true, message: `killed ${sessionId}` }
  }

  checkStalls(nowMs = Date.now()): number {
    let stalled = 0
    for (const record of this.records.values()) {
      if (record.session.status !== "running") continue
      const threshold = record.request.stallThresholdMs ?? this.defaultStallThresholdMs
      const elapsed = nowMs - Date.parse(record.session.lastActivityAt)
      if (elapsed <= threshold) continue

      stalled += 1
      record.session.status = "stalled"

      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.coding_session_stalled",
        message: "coding session stalled",
        meta: { id: record.session.id, elapsedMs: elapsed },
      })

      if (record.request.autoRestartOnStall !== false && record.session.restartCount < this.maxRestarts) {
        this.restartSession(record, "stalled")
      }
    }

    if (stalled > 0) {
      this.persistState()
    }

    return stalled
  }

  shutdown(): void {
    for (const record of this.records.values()) {
      if (!record.process) continue
      record.process.kill("SIGTERM")
      record.process = null
      if (record.session.status === "running" || record.session.status === "spawning") {
        record.session.status = "killed"
        record.session.endedAt = this.nowIso()
      }
    }

    this.persistState()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_manager_shutdown",
      message: "coding session manager shutdown complete",
      meta: { sessionCount: this.records.size },
    })
  }

  private attachProcessListeners(record: CodingSessionRecord): void {
    if (!record.process) return

    record.process.stdout.on("data", (chunk: Buffer | string) => {
      this.onOutput(record, chunk.toString(), "stdout")
    })
    record.process.stderr.on("data", (chunk: Buffer | string) => {
      this.onOutput(record, chunk.toString(), "stderr")
    })
    record.process.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.onExit(record, code, signal)
    })
  }

  private onOutput(record: CodingSessionRecord, text: string, stream: "stdout" | "stderr"): void {
    record.session.lastActivityAt = this.nowIso()

    if (stream === "stdout") {
      record.stdoutTail = appendTail(record.stdoutTail, text)
      record.session.stdoutTail = record.stdoutTail
    } else {
      record.stderrTail = appendTail(record.stderrTail, text)
      record.session.stderrTail = record.stderrTail
    }

    if (text.includes("status: NEEDS_REVIEW") || text.includes("❌ blocked")) {
      record.session.status = "waiting_input"
    }
    if (text.includes("✅ all units complete")) {
      record.session.status = "completed"
      record.session.endedAt = this.nowIso()
    }

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_session_output",
      message: "received coding session output",
      meta: { id: record.session.id, status: record.session.status },
    })

    this.persistState()
  }

  private onExit(record: CodingSessionRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (!record.process) return
    record.process = null
    record.session.pid = null
    record.session.lastExitCode = code
    record.session.lastSignal = signal

    if (record.session.status === "killed" || record.session.status === "completed") {
      record.session.endedAt = this.nowIso()
      this.persistState()
      return
    }

    if (code === 0) {
      record.session.status = "completed"
      record.session.endedAt = this.nowIso()
      this.persistState()
      return
    }

    if (record.request.autoRestartOnCrash !== false && record.session.restartCount < this.maxRestarts) {
      this.restartSession(record, "crash")
      return
    }

    record.session.status = "failed"
    record.session.endedAt = this.nowIso()
    record.session.failure = defaultFailureDiagnostics(
      code,
      signal,
      record.command,
      record.args,
      record.stdoutTail,
      record.stderrTail,
    )

    emitNervesEvent({
      level: "error",
      component: "repertoire",
      event: "repertoire.coding_session_failed",
      message: "coding session failed without restart",
      meta: { id: record.session.id, code, signal, command: record.command },
    })

    this.persistState()
  }

  private restartSession(record: CodingSessionRecord, reason: "stalled" | "crash"): void {
    const replacement = normalizeSpawnResult(this.spawnProcess(record.request))
    record.process = replacement.process
    record.command = replacement.command
    record.args = [...replacement.args]
    record.stdoutTail = ""
    record.stderrTail = ""
    record.session.stdoutTail = ""
    record.session.stderrTail = ""

    record.session.pid = replacement.process.pid ?? null
    record.session.restartCount += 1
    record.session.status = "running"
    record.session.lastActivityAt = this.nowIso()
    record.session.endedAt = null
    record.session.failure = null

    this.attachProcessListeners(record)

    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.coding_session_restarted",
      message: "coding session restarted",
      meta: { id: record.session.id, reason, restartCount: record.session.restartCount },
    })

    this.persistState()
  }

  private loadPersistedState(): void {
    if (!this.existsSync(this.stateFilePath)) {
      return
    }

    let raw: string
    try {
      raw = this.readFileSync(this.stateFilePath, "utf-8")
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.coding_state_load_error",
        message: "failed reading coding session state",
        meta: { path: this.stateFilePath, reason: error instanceof Error ? error.message : String(error) },
      })
      return
    }

    let parsed: PersistedCodingState
    try {
      parsed = JSON.parse(raw) as PersistedCodingState
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.coding_state_load_error",
        message: "invalid coding session state JSON",
        meta: { path: this.stateFilePath, reason: error instanceof Error ? error.message : String(error) },
      })
      return
    }

    if (!Array.isArray(parsed.records)) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.coding_state_load_error",
        message: "coding session state missing records array",
        meta: { path: this.stateFilePath },
      })
      return
    }

    this.sequence = Number.isInteger(parsed.sequence) && parsed.sequence >= 0 ? parsed.sequence : 0

    for (const item of parsed.records) {
      const request = item?.request
      const session = item?.session
      if (!request || !session || typeof session.id !== "string") {
        continue
      }

      const normalizedRequest: CodingSessionRequest = {
        ...request,
        sessionId: request.sessionId ?? session.id,
        parentAgent: request.parentAgent ?? this.agentName,
      }

      const normalizedSession: CodingSession = {
        ...session,
        taskRef: session.taskRef ?? normalizedRequest.taskRef,
        failure: session.failure ?? null,
        stdoutTail: session.stdoutTail ?? session.failure?.stdoutTail ?? "",
        stderrTail: session.stderrTail ?? session.failure?.stderrTail ?? "",
      }

      if (typeof normalizedSession.pid === "number") {
        const alive = this.pidAlive(normalizedSession.pid)
        if (!alive && isActiveSessionStatus(normalizedSession.status)) {
          normalizedSession.status = "failed"
          normalizedSession.endedAt = normalizedSession.endedAt ?? this.nowIso()
          normalizedSession.failure =
            normalizedSession.failure ??
            defaultFailureDiagnostics(
              normalizedSession.lastExitCode,
              normalizedSession.lastSignal,
              "restored",
              [],
              "",
              "process not running during manager restore",
            )
          normalizedSession.pid = null
        }
      }

      this.records.set(normalizedSession.id, {
        request: normalizedRequest,
        session: normalizedSession,
        process: null,
        command: normalizedSession.failure?.command ?? "restored",
        args: normalizedSession.failure ? [...normalizedSession.failure.args] : [],
        stdoutTail: normalizedSession.stdoutTail,
        stderrTail: normalizedSession.stderrTail,
      })

      this.sequence = Math.max(this.sequence, extractSequence(normalizedSession.id))
    }

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_state_loaded",
      message: "loaded persisted coding sessions",
      meta: { count: this.records.size },
    })
  }

  private persistState(): void {
    const payload: PersistedCodingState = {
      sequence: this.sequence,
      records: [...this.records.values()].map((record) => ({
        request: record.request,
        session: record.session,
      })),
    }

    try {
      this.mkdirSync(path.dirname(this.stateFilePath), { recursive: true })
      this.writeFileSync(this.stateFilePath, JSON.stringify(payload, null, 2) + "\n", "utf-8")
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.coding_state_persist_error",
        message: "failed persisting coding sessions",
        meta: { path: this.stateFilePath, reason: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}
