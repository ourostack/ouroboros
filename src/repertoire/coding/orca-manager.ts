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
    "showWorktree" | "ensureRepo" | "createWorktreeWithAgent" | "launchAgent" | "listTerminals" | "listAgents" | "readTerminal" | "sendText" | "closeTerminal"
  >
  stateFilePath?: string
  nowIso?: () => string
  newId?: () => string
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string, encoding: "utf-8") => string
  writeFileSync?: (target: string, data: string, encoding: "utf-8") => void
  mkdirSync?: (target: string, options: { recursive: true }) => unknown
  pollIntervalMs?: number
  /** How long a launched agent has to show up in its pane before the launch counts as failed. */
  launchStartTimeoutMs?: number
  /** How often to look for the launched agent while waiting. */
  launchStartPollMs?: number
  sleep?: (ms: number) => Promise<void>
  nowMs?: () => number
  /** Hears every session's updates, including sessions restored from the state file. */
  onUpdate?: Listener
}

interface OrcaRecord {
  request: CodingSessionRequest
  session: CodingSession
  /** Refreshes in a row that found no terminal for this session (in memory only). */
  misses?: number
  /** The last state Orca reported for the agent (in memory only). */
  agentState?: string
}

/** Refreshes in a row that must miss a session's terminal before it counts as gone; one miss may be Orca restarting or asleep. */
export const ORCA_MISSES_BEFORE_GONE = 3

/** What a launch left in its pane: the agent running there, or the screen that shows why not. */
type LaunchCheck = { started: true; paneKey: string } | { started: false; screen: string }


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

/**
 * Orca's agent state, as a coding session status. Orca's `done` ends a turn, not the job (an interactive
 * agent waits in its tab for more), so it reads as waiting for input; a session completes only when its
 * terminal closes after `done`. An agent that has not reported yet is running.
 */
export function statusFromOrcaAgent(state: string | undefined): CodingSessionStatus {
  return state === "blocked" || state === "waiting" || state === "done" ? "waiting_input" : "running"
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
  private readonly launchStartTimeoutMs: number
  private readonly launchStartPollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly nowMs: () => number
  private readonly onUpdate?: Listener
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false

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
    this.launchStartTimeoutMs = options.launchStartTimeoutMs ?? 90_000
    this.launchStartPollMs = options.launchStartPollMs ?? 2_000
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.nowMs = options.nowMs ?? Date.now
    this.onUpdate = options.onUpdate
    this.loadState()
    this.syncPolling()
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

    // An Orca worktree already at workdir gets a new agent tab; anything else (a repo's main checkout, or
    // a checkout Orca doesn't know yet, which is registered with Orca first) gets its own new Orca worktree,
    // so parallel jobs never collide.
    const existing = await this.cli.showWorktree(normalized.workdir)
    const inExisting = existing !== null && !existing.isMainWorktree
    let launch: OrcaLaunch = inExisting
      ? await this.cli.launchAgent({ worktree: existing, agent: normalized.runner, prompt })
      : await this.cli.createWorktreeWithAgent({
        repoDir: normalized.workdir,
        repoId: await this.cli.ensureRepo(normalized.workdir),
        name: orcaWorktreeName(normalized.taskRef, id),
        agent: normalized.runner,
        prompt,
      })

    // Orca's "handed-to-terminal" means bytes reached the PTY, not that the agent ran: a shell still in its
    // rc files can eat them (2026-11-24, `laude`). The agent showing up in its pane is the proof; one relaunch
    // in the same worktree covers a lost launch line.
    let check = await this.checkLaunch(launch)
    if (!check.started) {
      await this.cli.closeTerminal(launch.terminalHandle).catch(() => undefined)
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.orca_agent_launch_retried",
        message: "Orca launched no agent; relaunching once in the same worktree",
        meta: { id, runner: normalized.runner, worktreePath: launch.worktree.path, screen: clip(check.screen) },
      })
      launch = await this.cli.launchAgent({ worktree: launch.worktree, agent: normalized.runner, prompt })
      check = await this.checkLaunch(launch)
    }
    if (!check.started) {
      await this.cli.closeTerminal(launch.terminalHandle).catch(() => undefined)
      throw new Error(
        `Orca opened ${normalized.runner} in ${launch.worktree.path} twice but the agent never started, so its tabs were closed; the worktree stays. Its terminal showed: ${clip(check.screen) || "(nothing)"}. Spawn again with workdir ${launch.worktree.path}`,
      )
    }
    const paneKey = check.paneKey

    const session: CodingSession = {
      id,
      runner: normalized.runner,
      backend: "orca",
      orca: {
        requestedWorkdir: normalized.workdir,
        worktreeId: launch.worktree.id,
        worktreePath: launch.worktree.path,
        branch: launch.worktree.branch,
        terminalHandle: launch.terminalHandle,
        paneKey,
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
      meta: { id, runner: session.runner, worktreePath: launch.worktree.path, created: !inExisting },
    })
    this.notify(id, { kind: "spawned", session: cloneSession(session) })
    this.syncPolling()
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
    this.syncPolling()
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
    this.syncPolling()
    return cloneSession(record.session)
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      const current = this.listeners.get(sessionId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(sessionId)
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
      const reason = error instanceof Error ? error.message : String(error)
      // The tab may already be gone; ask Orca before calling the kill failed.
      record.misses = ORCA_MISSES_BEFORE_GONE - 1
      await this.refreshWorktree(record.session.orca!.worktreeId, [record])
      if (isClosed(record.session)) return { ok: true, message: `session ${sessionId} had already ended (${record.session.status})` }
      return { ok: false, message: `Orca could not close ${sessionId}: ${reason}` }
    }
    record.session.status = "killed"
    record.session.endedAt = this.nowIso()
    record.session.checkpoint = `terminated by parent agent; worktree kept at ${record.session.orca!.worktreePath}`
    this.persistState()
    this.notify(sessionId, { kind: "killed", session: cloneSession(record.session) })
    this.syncPolling()
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
    if (!terminal && placement.paneKey) {
      // Orca hands out new terminal handles when it restarts; the pane it sits in keeps its key.
      const heldByOthers = new Set(
        [...this.records.values()].filter((other) => other !== record).map((other) => other.session.orca!.terminalHandle),
      )
      terminal = terminals.find((item) => `${item.tabId}:${item.leafId}` === placement.paneKey && !heldByOthers.has(item.handle))
      if (terminal) placement.terminalHandle = terminal.handle
    }

    const previous = session.status
    if (!terminal) {
      record.misses = (record.misses ?? 0) + 1
      if (record.misses < ORCA_MISSES_BEFORE_GONE) return
      session.endedAt = this.nowIso()
      if (record.agentState === "done") {
        session.status = "completed"
        session.checkpoint = "finished; its Orca terminal has closed"
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
      record.misses = 0
      placement.paneKey = `${terminal.tabId}:${terminal.leafId}`
      const agent = agents.find((item) => item.paneKey === placement.paneKey)
      record.agentState = agent?.state ?? record.agentState
      session.status = statusFromOrcaAgent(agent?.state)
      if (agent?.lastAssistantMessage) session.checkpoint = clip(agent.lastAssistantMessage)
      if (terminal.lastOutputAt) session.lastActivityAt = new Date(terminal.lastOutputAt).toISOString()
    }

    if (session.status !== previous) {
      this.persistState()
      this.notify(session.id, { kind: updateKindFor(session.status), session: cloneSession(session) })
    }
  }

  /** Waits for the launched agent to appear in its pane; Orca's own prompt receipt only rules a launch out. */
  private async checkLaunch(launch: OrcaLaunch): Promise<LaunchCheck> {
    if (launch.promptDelivered !== false) {
      const deadline = this.nowMs() + this.launchStartTimeoutMs
      for (;;) {
        try {
          const terminal = (await this.cli.listTerminals(launch.worktree.id)).find((item) => item.handle === launch.terminalHandle)
          const paneKey = terminal?.tabId && terminal.leafId ? `${terminal.tabId}:${terminal.leafId}` : undefined
          if (paneKey && (await this.cli.listAgents(launch.worktree.id)).some((agent) => agent.paneKey === paneKey)) {
            return { started: true, paneKey }
          }
        } catch {
          // Orca busy or restarting: keep looking until the deadline.
        }
        if (this.nowMs() >= deadline) break
        await this.sleep(this.launchStartPollMs)
      }
    }
    const screen = await this.cli.readTerminal(launch.terminalHandle, 20).then((read) => read.tail, () => "")
    return { started: false, screen }
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

  /**
   * Poll Orca while any session is still open, whether or not anyone subscribed, so a session that finishes or
   * waits for input is heard (and reported through onUpdate) without anyone asking. Stop once none is open.
   */
  private syncPolling(): void {
    if ([...this.records.values()].some((record) => !isClosed(record.session))) this.startPolling()
    else this.stopPolling()
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      if (this.polling) return
      this.polling = true
      void this.refreshSessions().finally(() => {
        this.polling = false
      })
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private notify(sessionId: string, update: CodingSessionUpdate): void {
    for (const listener of [...(this.listeners.get(sessionId) ?? []), ...(this.onUpdate ? [this.onUpdate] : [])]) {
      void Promise.resolve()
        .then(() => listener(update))
        .catch((error) => {
          emitNervesEvent({
            level: "warn",
            component: "repertoire",
            event: "repertoire.orca_coding_listener_error",
            message: "an Orca coding session listener failed",
            meta: { sessionId, kind: update.kind, reason: error instanceof Error ? error.message : String(error) },
          })
        })
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
    try {
      this.mkdirSync(path.dirname(this.stateFilePath), { recursive: true })
      const records = [...this.records.values()].map((record) => ({ request: record.request, session: record.session }))
      this.writeFileSync(this.stateFilePath, `${JSON.stringify({ records }, null, 2)}\n`, "utf-8")
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.orca_coding_state_write_error",
        message: "could not save Orca coding sessions; they are kept in memory",
        meta: { path: this.stateFilePath, reason: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}
