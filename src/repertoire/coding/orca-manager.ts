import { randomUUID } from "crypto"
import * as fs from "fs"
import * as path from "path"

import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { OrcaCli, type OrcaAgent, type OrcaLaunch, type OrcaTerminal } from "./orca-client"
import { buildCodingPrompt } from "./spawner"
import type {
  CodingActionResult,
  CodingSession,
  CodingSessionRequest,
  CodingSessionStatus,
  CodingSessionUpdate,
  RefreshableCodingSessionManagerApi,
} from "./types"

type Listener = (update: CodingSessionUpdate) => void | Promise<void>

export interface OrcaCodingSessionManagerOptions {
  agentName: string
  cli?: Pick<
    OrcaCli,
    "showWorktree" | "createWorktreeWithAgent" | "launchAgent" | "listTerminals" | "listAgents" | "readTerminal" | "sendText" | "closeTerminal"
  >
  stateFilePath?: string
  nowIso?: () => string
  newId?: () => string
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string, encoding: "utf-8") => string
  writeFileSync?: (target: string, data: string, encoding: "utf-8") => void
  mkdirSync?: (target: string, options: { recursive: true }) => unknown
  pollIntervalMs?: number
}

interface OrcaRecord {
  request: CodingSessionRequest
  session: CodingSession
}


/** A session is closed once its Orca terminal is gone (killed, failed, or closed after it finished). */
function isClosed(session: CodingSession): boolean {
  return session.endedAt !== null
}

function cloneSession(session: CodingSession): CodingSession {
  return {
    ...session,
    originSession: session.originSession ? { ...session.originSession } : undefined,
    orca: { ...session.orca! },
    failure: session.failure ? { ...session.failure, args: [...session.failure.args] } : null,
  }
}

/** A worktree name Orca accepts, from the task: lowercase words joined by dashes. */
export function orcaWorktreeName(taskRef: string | undefined, id: string): string {
  const slug = (taskRef ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return slug.length > 0 ? slug : id
}

/** Orca's agent state, as a coding session status. An agent that has not reported yet is running. */
export function statusFromOrcaAgent(state: string | undefined): CodingSessionStatus {
  switch (state) {
    case "blocked":
    case "waiting":
      return "waiting_input"
    case "done":
      return "completed"
    default:
      return "running"
  }
}

function updateKindFor(status: CodingSessionStatus): CodingSessionUpdate["kind"] {
  return status === "running" ? "progress" : (status as Exclude<CodingSessionStatus, "running" | "spawning">)
}

function clip(text: string, max = 280): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`
}

export class OrcaCodingSessionManager implements RefreshableCodingSessionManagerApi {
  private readonly records = new Map<string, OrcaRecord>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly cli: NonNullable<OrcaCodingSessionManagerOptions["cli"]>
  private readonly agentName: string
  private readonly stateFilePath: string
  private readonly nowIso: () => string
  private readonly newId: () => string
  private readonly existsSync: (target: string) => boolean
  private readonly readFileSync: (target: string, encoding: "utf-8") => string
  private readonly writeFileSync: (target: string, data: string, encoding: "utf-8") => void
  private readonly mkdirSync: (target: string, options: { recursive: true }) => unknown
  private readonly pollIntervalMs: number
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: OrcaCodingSessionManagerOptions) {
    this.agentName = options.agentName
    this.cli = options.cli ?? new OrcaCli()
    this.stateFilePath = options.stateFilePath ?? path.join(getAgentRoot(options.agentName), "state", "coding", "orca-sessions.json")
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.newId = options.newId ?? (() => `orca-${randomUUID().slice(0, 8)}`)
    this.existsSync = options.existsSync ?? fs.existsSync
    this.readFileSync = options.readFileSync ?? fs.readFileSync
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync
    this.mkdirSync = options.mkdirSync ?? fs.mkdirSync
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000
    this.loadState()
  }

  async spawnSession(request: CodingSessionRequest): Promise<CodingSession> {
    const id = this.newId()
    const now = this.nowIso()
    const normalized: CodingSessionRequest = {
      ...request,
      backend: "orca",
      sessionId: id,
      parentAgent: request.parentAgent ?? this.agentName,
    }
    const prompt = buildCodingPrompt(normalized, { existsSync: this.existsSync, readFileSync: this.readFileSync })

    // An Orca worktree already at workdir gets a new agent tab; anything else (a repo's main checkout,
    // or a folder Orca doesn't manage) gets its own new Orca worktree, so parallel jobs never collide.
    const existing = await this.cli.showWorktree(normalized.workdir)
    const launch: OrcaLaunch = existing && !existing.isMainWorktree
      ? await this.cli.launchAgent({ worktree: existing, agent: normalized.runner, prompt })
      : await this.cli.createWorktreeWithAgent({
        repoDir: normalized.workdir,
        name: orcaWorktreeName(normalized.taskRef, id),
        agent: normalized.runner,
        prompt,
      })

    if (launch.promptDelivered === false) {
      throw new Error(
        `Orca opened ${normalized.runner} in ${launch.worktree.path} (terminal ${launch.terminalHandle}) but did not deliver its task prompt; close that tab and spawn again`,
      )
    }

    const session: CodingSession = {
      id,
      runner: normalized.runner,
      backend: "orca",
      orca: {
        worktreeId: launch.worktree.id,
        worktreePath: launch.worktree.path,
        branch: launch.worktree.branch,
        terminalHandle: launch.terminalHandle,
      },
      workdir: launch.worktree.path,
      taskRef: normalized.taskRef,
      originSession: normalized.originSession ? { ...normalized.originSession } : undefined,
      obligationId: normalized.obligationId,
      evolutionCaseId: normalized.evolutionCaseId,
      scopeFile: normalized.scopeFile,
      stateFile: normalized.stateFile,
      checkpoint: launch.detail,
      status: "running",
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
    this.records.set(id, { request: normalized, session })
    this.persistState()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.orca_coding_session_spawned",
      message: "Orca coding session spawned",
      meta: { id, runner: session.runner, worktreePath: launch.worktree.path, created: !(existing && !existing.isMainWorktree) },
    })
    this.notify(id, { kind: "spawned", session: cloneSession(session) })
    return cloneSession(session)
  }

  listSessions(): CodingSession[] {
    return [...this.records.values()].map((record) => cloneSession(record.session)).sort((a, b) => a.id.localeCompare(b.id))
  }

  getSession(sessionId: string): CodingSession | null {
    const record = this.records.get(sessionId)
    return record ? cloneSession(record.session) : null
  }

  async refreshSessions(): Promise<CodingSession[]> {
    const byWorktree = new Map<string, OrcaRecord[]>()
    for (const record of this.records.values()) {
      if (isClosed(record.session)) continue
      const worktreeId = record.session.orca!.worktreeId
      byWorktree.set(worktreeId, [...(byWorktree.get(worktreeId) ?? []), record])
    }
    for (const [worktreeId, records] of byWorktree) {
      await this.refreshWorktree(worktreeId, records)
    }
    return this.listSessions()
  }

  async refreshSession(sessionId: string): Promise<CodingSession | null> {
    const record = this.records.get(sessionId)
    if (!record) return null
    if (!isClosed(record.session)) {
      await this.refreshWorktree(record.session.orca!.worktreeId, [record])
    }
    if (!isClosed(record.session)) {
      try {
        const read = await this.cli.readTerminal(record.session.orca!.terminalHandle)
        record.session.stdoutTail = read.tail
      } catch (error) {
        this.reportOrcaUnreachable(sessionId, error)
      }
    }
    return cloneSession(record.session)
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(sessionId, set)
    this.startPolling()
    return () => {
      const current = this.listeners.get(sessionId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(sessionId)
      if (this.listeners.size === 0) this.stopPolling()
    }
  }

  async sendInput(sessionId: string, input: string): Promise<CodingActionResult> {
    const record = this.records.get(sessionId)
    if (!record) return { ok: false, message: `session not found: ${sessionId}` }
    if (isClosed(record.session)) {
      return { ok: false, message: `session ${sessionId} has ended (${record.session.status}); its Orca terminal is closed` }
    }
    try {
      await this.cli.sendText(record.session.orca!.terminalHandle, input)
    } catch (error) {
      return { ok: false, message: `Orca refused input for ${sessionId}: ${error instanceof Error ? error.message : String(error)}` }
    }
    record.session.status = "running"
    record.session.lastActivityAt = this.nowIso()
    this.persistState()
    this.notify(sessionId, { kind: "progress", session: cloneSession(record.session) })
    return { ok: true, message: `input sent to ${sessionId}` }
  }

  async killSession(sessionId: string): Promise<CodingActionResult> {
    const record = this.records.get(sessionId)
    if (!record) return { ok: false, message: `session not found: ${sessionId}` }
    if (isClosed(record.session)) return { ok: true, message: `session ${sessionId} has already ended (${record.session.status})` }
    try {
      await this.cli.closeTerminal(record.session.orca!.terminalHandle)
    } catch (error) {
      return { ok: false, message: `Orca could not close ${sessionId}: ${error instanceof Error ? error.message : String(error)}` }
    }
    record.session.status = "killed"
    record.session.endedAt = this.nowIso()
    record.session.checkpoint = `terminated by parent agent; worktree kept at ${record.session.orca!.worktreePath}`
    this.persistState()
    this.notify(sessionId, { kind: "killed", session: cloneSession(record.session) })
    return { ok: true, message: `killed ${sessionId}; its worktree stays at ${record.session.orca!.worktreePath}` }
  }

  checkStalls(): number {
    return 0
  }

  shutdown(): void {
    this.stopPolling()
    this.listeners.clear()
  }

  private async refreshWorktree(worktreeId: string, records: OrcaRecord[]): Promise<void> {
    let terminals: OrcaTerminal[]
    let agents: OrcaAgent[]
    try {
      terminals = await this.cli.listTerminals(worktreeId)
      agents = await this.cli.listAgents(worktreeId)
    } catch (error) {
      for (const record of records) this.reportOrcaUnreachable(record.session.id, error)
      return
    }
    for (const record of records) this.applyOrcaState(record, terminals, agents)
  }

  private applyOrcaState(record: OrcaRecord, terminals: OrcaTerminal[], agents: OrcaAgent[]): void {
    const session = record.session
    const placement = session.orca!
    let terminal = terminals.find((item) => item.handle === placement.terminalHandle)
    if (!terminal) {
      // Orca hands out new terminal handles when it restarts; one terminal running our runner is ours.
      const candidates = terminals.filter((item) => item.agentIdentity === session.runner)
      if (candidates.length === 1) {
        terminal = candidates[0]
        placement.terminalHandle = terminal.handle
      }
    }

    const previous = session.status
    if (!terminal) {
      session.endedAt = this.nowIso()
      if (previous === "completed") {
        session.checkpoint = "finished; its Orca terminal has since closed"
      } else {
        session.status = "failed"
        session.checkpoint = "its Orca terminal closed before the agent reported done"
        session.failure = {
          command: `orca ${session.runner}`,
          args: [],
          code: null,
          signal: null,
          stdoutTail: session.stdoutTail,
          stderrTail: session.checkpoint,
        }
      }
      this.persistState()
    } else {
      const agent = agents.find((item) => item.paneKey === `${terminal!.tabId}:${terminal!.leafId}`)
      session.status = statusFromOrcaAgent(agent?.state)
      if (agent?.lastAssistantMessage) session.checkpoint = clip(agent.lastAssistantMessage)
      if (terminal.lastOutputAt) session.lastActivityAt = new Date(terminal.lastOutputAt).toISOString()
    }

    if (session.status !== previous) {
      this.persistState()
      this.notify(session.id, { kind: updateKindFor(session.status), session: cloneSession(session) })
    }
  }

  private reportOrcaUnreachable(sessionId: string, error: unknown): void {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.orca_coding_refresh_error",
      message: "could not read an Orca coding session; showing its last known state",
      meta: { sessionId, reason: error instanceof Error ? error.message : String(error) },
    })
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refreshSessions()
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private notify(sessionId: string, update: CodingSessionUpdate): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      void Promise.resolve(listener(update))
    }
  }

  private loadState(): void {
    if (!this.existsSync(this.stateFilePath)) return
    try {
      const parsed = JSON.parse(this.readFileSync(this.stateFilePath, "utf-8")) as { records?: OrcaRecord[] }
      for (const record of parsed.records ?? []) {
        if (typeof record?.session?.id !== "string" || !record.session.orca?.terminalHandle) continue
        this.records.set(record.session.id, { request: record.request, session: { ...record.session, backend: "orca" } })
      }
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.orca_coding_state_unreadable",
        message: "Orca coding session state was unreadable; starting with none",
        meta: { path: this.stateFilePath, reason: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private persistState(): void {
    this.mkdirSync(path.dirname(this.stateFilePath), { recursive: true })
    const records = [...this.records.values()].map((record) => ({ request: record.request, session: record.session }))
    this.writeFileSync(this.stateFilePath, `${JSON.stringify({ records }, null, 2)}\n`, "utf-8")
  }
}
