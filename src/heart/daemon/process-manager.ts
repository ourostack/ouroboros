import { spawn as nodeSpawn, type ChildProcess } from "child_process"
import * as path from "path"
import { getRepoRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface DaemonManagedAgent {
  name: string
  agentArg?: string
  entry: string
  channel: string
  autoStart: boolean
  args?: string[]
  env?: Record<string, string>
}

export interface DaemonAgentSnapshot {
  name: string
  channel: string
  status: "starting" | "running" | "stopped" | "crashed"
  pid: number | null
  restartCount: number
  startedAt: string | null
  lastCrashAt: string | null
  backoffMs: number
}

export interface DaemonProcessManagerOptions {
  agents: DaemonManagedAgent[]
  maxRestartsPerHour?: number
  stabilityThresholdMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess
  now?: () => number
  setTimeoutFn?: (cb: () => void, delay: number) => unknown
  clearTimeoutFn?: (timer: unknown) => void
  existsSync?: (p: string) => boolean
}

interface AgentRuntimeState {
  config: DaemonManagedAgent
  snapshot: DaemonAgentSnapshot
  process: ChildProcess | null
  restartTimer: unknown | null
  crashTimestamps: number[]
  stopRequested: boolean
}

function startOfHour(ms: number): number {
  return ms - 60 * 60 * 1000
}

export class DaemonProcessManager {
  private readonly agents = new Map<string, AgentRuntimeState>()
  private readonly maxRestartsPerHour: number
  private readonly stabilityThresholdMs: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly spawnFn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess
  private readonly now: () => number
  private readonly setTimeoutFn: (cb: () => void, delay: number) => unknown
  private readonly clearTimeoutFn: (timer: unknown) => void
  private readonly existsSyncFn: ((p: string) => boolean) | null

  constructor(options: DaemonProcessManagerOptions) {
    this.maxRestartsPerHour = options.maxRestartsPerHour ?? 10
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? 60_000
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.spawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.now = options.now ?? (() => Date.now())
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, delay) => setTimeout(cb, delay))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
    this.existsSyncFn = options.existsSync ?? null

    for (const agent of options.agents) {
      this.agents.set(agent.name, {
        config: agent,
        process: null,
        restartTimer: null,
        crashTimestamps: [],
        stopRequested: false,
        snapshot: {
          name: agent.name,
          channel: agent.channel,
          status: "stopped",
          pid: null,
          restartCount: 0,
          startedAt: null,
          lastCrashAt: null,
          backoffMs: this.initialBackoffMs,
        },
      })
    }
  }

  async startAutoStartAgents(): Promise<void> {
    for (const state of this.agents.values()) {
      if (state.config.autoStart) {
        await this.startAgent(state.config.name)
      }
    }
  }

  async startAgent(agent: string): Promise<void> {
    const state = this.requireAgent(agent)
    if (state.process) return

    this.clearRestartTimer(state)
    state.stopRequested = false
    state.snapshot.status = "starting"

    const runCwd = getRepoRoot()
    const entryScript = path.join(getRepoRoot(), "dist", state.config.entry)

    if (this.existsSyncFn && !this.existsSyncFn(entryScript)) {
      state.snapshot.status = "crashed"
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_entry_missing",
        message: "agent entry script does not exist — cannot spawn. Run 'ouro daemon install' from the correct location.",
        meta: { agent, entryScript },
      })
      return
    }

    const args = [entryScript, "--agent", state.config.agentArg ?? agent, ...(state.config.args ?? [])]
    const child = this.spawnFn("node", args, {
      cwd: runCwd,
      env: state.config.env ? { ...process.env, ...state.config.env } : process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })

    state.process = child
    state.snapshot.status = "running"
    state.snapshot.pid = child.pid ?? null
    state.snapshot.startedAt = new Date(this.now()).toISOString()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_started",
      message: "daemon started managed agent process",
      meta: { agent, pid: child.pid ?? null, cwd: runCwd },
    })

    /* v8 ignore start — child process error handler; requires real spawn to trigger */
    child.on("error", (err) => {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.agent_process_error",
        message: "managed agent process emitted error",
        meta: { agent, error: err.message },
      })
    })
    /* v8 ignore stop */

    child.once("exit", (code, signal) => {
      this.onExit(state, code, signal)
    })
  }

  async stopAgent(agent: string): Promise<void> {
    const state = this.requireAgent(agent)
    this.clearRestartTimer(state)
    state.stopRequested = true

    if (!state.process) {
      state.snapshot.status = "stopped"
      state.snapshot.pid = null
      return
    }

    const child = state.process
    state.process = null
    state.snapshot.status = "stopped"
    state.snapshot.pid = null

    try {
      child.kill("SIGTERM")
    } catch {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.agent_stop_error",
        message: "failed to send SIGTERM to managed agent",
        meta: { agent },
      })
    }
  }

  async restartAgent(agent: string): Promise<void> {
    await this.stopAgent(agent)
    await this.startAgent(agent)
  }

  async stopAll(): Promise<void> {
    for (const state of this.agents.values()) {
      await this.stopAgent(state.config.name)
    }
  }

  sendToAgent(agent: string, message: Record<string, unknown>): void {
    const state = this.requireAgent(agent)
    if (!state.process) return
    try {
      state.process.send(message)
    } catch {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.agent_ipc_send_error",
        message: "failed to send IPC message to managed agent",
        meta: { agent },
      })
    }
  }

  getAgentSnapshot(agent: string): DaemonAgentSnapshot | undefined {
    return this.agents.get(agent)?.snapshot
  }

  listAgentSnapshots(): DaemonAgentSnapshot[] {
    return [...this.agents.values()].map((state) => state.snapshot)
  }

  private onExit(state: AgentRuntimeState, code: number | null, signal: NodeJS.Signals | null): void {
    if (!state.process) return
    state.process = null
    state.snapshot.pid = null

    const crashed = !state.stopRequested && code !== 0
    const now = this.now()
    const startedAt = state.snapshot.startedAt ? Date.parse(state.snapshot.startedAt) : now
    const runDuration = Math.max(0, now - startedAt)

    emitNervesEvent({
      level: crashed ? "warn" : "info",
      component: "daemon",
      event: "daemon.agent_exit",
      message: "managed agent process exited",
      meta: { agent: state.config.name, code, signal, crashed, runDurationMs: runDuration },
    })

    if (!crashed) {
      state.snapshot.status = "stopped"
      if (runDuration >= this.stabilityThresholdMs) {
        state.snapshot.backoffMs = this.initialBackoffMs
      }
      return
    }

    state.snapshot.lastCrashAt = new Date(now).toISOString()
    state.crashTimestamps = state.crashTimestamps.filter((crashTs) => crashTs >= startOfHour(now))
    state.crashTimestamps.push(now)

    if (state.crashTimestamps.length > this.maxRestartsPerHour) {
      state.snapshot.status = "crashed"
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_restart_exhausted",
        message: "managed agent exceeded restart limit and is marked crashed",
        meta: { agent: state.config.name, maxRestartsPerHour: this.maxRestartsPerHour },
      })
      return
    }

    state.snapshot.status = "starting"
    state.snapshot.restartCount += 1
    const waitMs = state.snapshot.backoffMs
    state.snapshot.backoffMs = Math.min(state.snapshot.backoffMs * 2, this.maxBackoffMs)

    this.clearRestartTimer(state)
    state.restartTimer = this.setTimeoutFn(() => {
      void this.startAgent(state.config.name)
    }, waitMs)
  }

  private clearRestartTimer(state: AgentRuntimeState): void {
    if (state.restartTimer === null) return
    this.clearTimeoutFn(state.restartTimer)
    state.restartTimer = null
  }

  private requireAgent(agent: string): AgentRuntimeState {
    const state = this.agents.get(agent)
    if (!state) {
      throw new Error(`Unknown managed agent '${agent}'.`)
    }
    return state
  }
}
