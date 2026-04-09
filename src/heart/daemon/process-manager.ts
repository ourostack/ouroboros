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
  lastExitCode: number | null
  lastSignal: string | null
  /** Human-readable description of the most recent config-check failure
   *  for this agent, or null when the most recent config check passed.
   *  Populated by checkAgentConfig in startAgent; cleared when a later
   *  startAgent call sees a passing check. Surfaced via the pulse so
   *  sibling agents can read each other's broken state. */
  errorReason: string | null
  /** Actionable command/instruction to fix the config error, or null
   *  when there is no current error. Same lifecycle as errorReason. */
  fixHint: string | null
}

export interface DaemonProcessManagerOptions {
  agents: DaemonManagedAgent[]
  maxRestartsPerHour?: number
  stabilityThresholdMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  cooldownRecoveryMs?: number
  maxCooldownRetries?: number
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess
  now?: () => number
  setTimeoutFn?: (cb: () => void, delay: number) => unknown
  clearTimeoutFn?: (timer: unknown) => void
  existsSync?: (p: string) => boolean
  configCheck?: (agent: string) => { ok: boolean; error?: string; fix?: string }
  /** Called after every snapshot mutation (start, exit, config-failure,
   *  recovery, etc.) so external observers (currently: the pulse writer)
   *  can react to state changes without polling. The callback is invoked
   *  synchronously after the mutation; if it throws, we swallow the error
   *  to avoid breaking the lifecycle path. */
  onSnapshotChange?: (snapshot: DaemonAgentSnapshot) => void
}

interface AgentRuntimeState {
  config: DaemonManagedAgent
  snapshot: DaemonAgentSnapshot
  process: ChildProcess | null
  restartTimer: unknown | null
  crashTimestamps: number[]
  stopRequested: boolean
  cooldownTimer: unknown | null
  cooldownRetryCount: number
  fastCrashCount: number
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
  private readonly cooldownRecoveryMs: number
  private readonly maxCooldownRetries: number
  private readonly existsSyncFn: ((p: string) => boolean) | null
  private readonly configCheckFn: ((agent: string) => { ok: boolean; error?: string; fix?: string }) | null
  private readonly onSnapshotChangeFn: ((snapshot: DaemonAgentSnapshot) => void) | null

  /**
   * Notify the snapshot-change observer (if registered). Swallows any
   * errors from the observer so process lifecycle code never fails
   * because the observer threw.
   */
  private notifySnapshotChange(snapshot: DaemonAgentSnapshot): void {
    if (!this.onSnapshotChangeFn) return
    try {
      this.onSnapshotChangeFn(snapshot)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.snapshot_change_observer_error",
        message: "snapshot-change observer threw",
        meta: {
          agent: snapshot.name,
          error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error),
        },
      })
    }
  }

  constructor(options: DaemonProcessManagerOptions) {
    this.maxRestartsPerHour = options.maxRestartsPerHour ?? 10
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? 60_000
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.cooldownRecoveryMs = options.cooldownRecoveryMs ?? 5 * 60 * 1_000
    this.maxCooldownRetries = options.maxCooldownRetries ?? 3
    this.spawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.now = options.now ?? (() => Date.now())
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, delay) => setTimeout(cb, delay))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
    this.existsSyncFn = options.existsSync ?? null
    this.configCheckFn = options.configCheck ?? null
    this.onSnapshotChangeFn = options.onSnapshotChange ?? null

    for (const agent of options.agents) {
      this.agents.set(agent.name, {
        config: agent,
        process: null,
        restartTimer: null,
        crashTimestamps: [],
        stopRequested: false,
        cooldownTimer: null,
        cooldownRetryCount: 0,
        fastCrashCount: 0,
        snapshot: {
          name: agent.name,
          channel: agent.channel,
          status: "stopped",
          pid: null,
          restartCount: 0,
          startedAt: null,
          lastCrashAt: null,
          backoffMs: this.initialBackoffMs,
          lastExitCode: null,
          lastSignal: null,
          errorReason: null,
          fixHint: null,
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

    if (this.configCheckFn) {
      const result = this.configCheckFn(agent)
      if (!result.ok) {
        state.snapshot.status = "crashed"
        // Surface the error and fix to the snapshot so sibling agents can
        // read it via the pulse. Without this, the diagnosis stayed
        // trapped in the nerves event and stderr — visible to humans
        // running `ouro status` or grepping logs, but invisible to
        // peer agents trying to coordinate around the broken state.
        state.snapshot.errorReason = result.error ?? "agent config validation failed"
        state.snapshot.fixHint = result.fix ?? null
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.agent_config_invalid",
          message: result.error ?? "agent config validation failed",
          meta: { agent, fix: result.fix ?? null },
        })
        process.stderr.write(
          `[daemon] ${agent}: ${result.error}\n` +
          (result.fix ? `  Fix: ${result.fix}\n` : ""),
        )
        this.notifySnapshotChange(state.snapshot)
        return
      }
      // Config check passed — clear any prior error so the pulse stops
      // reporting the broken state. This is the recovery path: the user
      // fixed their secrets/config, the next startAgent attempt sees a
      // valid config, and the pulse goes quiet.
      state.snapshot.errorReason = null
      state.snapshot.fixHint = null
    }

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
      this.notifySnapshotChange(state.snapshot)
      return
    }

    const args = [entryScript, "--agent", state.config.agentArg ?? agent, ...(state.config.args ?? [])]
    const child = this.spawnFn("node", args, {
      cwd: runCwd,
      env: state.config.env ? { ...process.env, ...state.config.env } : process.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })

    /* v8 ignore next 7 -- defensive: spawn should always return a ChildProcess @preserve */
    if (!child) {
      state.snapshot.status = "crashed"
      emitNervesEvent({ level: "error", component: "daemon", event: "daemon.agent_spawn_failed", message: "spawn returned null", meta: { agent } })
      return
    }
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
    this.notifySnapshotChange(state.snapshot)

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
    this.clearCooldownTimer(state)
    state.stopRequested = true

    if (!state.process) {
      state.snapshot.status = "stopped"
      state.snapshot.pid = null
      this.notifySnapshotChange(state.snapshot)
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
    this.notifySnapshotChange(state.snapshot)
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
    state.snapshot.lastExitCode = code
    state.snapshot.lastSignal = signal

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
      this.notifySnapshotChange(state.snapshot)
      return
    }

    state.snapshot.lastCrashAt = new Date(now).toISOString()

    // Fast-crash detection: if the agent dies within 5 seconds of starting, it's likely
    // a configuration issue (missing credentials, bad provider, etc.) not a transient failure.
    // After 3 consecutive fast crashes, stop retrying and mark as config-failed.
    const FAST_CRASH_THRESHOLD_MS = 5000
    const FAST_CRASH_MAX = 3
    if (runDuration < FAST_CRASH_THRESHOLD_MS) {
      state.fastCrashCount = state.fastCrashCount + 1
      if (state.fastCrashCount >= FAST_CRASH_MAX) {
        state.snapshot.status = "crashed"
        // Capture the fast-crash diagnosis on the snapshot so it surfaces
        // via the pulse. The error message is prescriptive: it tells the
        // user (and their sibling agents) exactly what to do.
        state.snapshot.errorReason = `agent crashed ${FAST_CRASH_MAX} times within ${FAST_CRASH_THRESHOLD_MS}ms of startup — likely a configuration issue (missing credentials, bad provider).`
        state.snapshot.fixHint = `Fix the config and run \`ouro up\` to restart, or check daemon logs for the underlying error.`
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.agent_config_failure",
          message: `agent crashed ${FAST_CRASH_MAX} times within ${FAST_CRASH_THRESHOLD_MS}ms of startup — likely a configuration issue (missing credentials, bad provider). Not retrying. Fix the config and run \`ouro up\` to restart.`,
          meta: { agent: state.config.name, fastCrashCount: state.fastCrashCount, avgRunDurationMs: runDuration },
        })
        this.notifySnapshotChange(state.snapshot)
        return // Don't schedule cooldown recovery — this needs human/agent intervention
      }
    } else {
      // Reset fast-crash counter on a stable run
      state.fastCrashCount = 0
    }

    state.crashTimestamps = state.crashTimestamps.filter((crashTs) => crashTs >= startOfHour(now))
    state.crashTimestamps.push(now)

    if (state.crashTimestamps.length > this.maxRestartsPerHour) {
      state.snapshot.status = "crashed"
      state.snapshot.errorReason = `agent exceeded restart limit (${this.maxRestartsPerHour}/hr) — entering cooldown`
      state.snapshot.fixHint = "investigate why the agent keeps crashing; cooldown will retry shortly"
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_restart_exhausted",
        message: "managed agent exceeded restart limit and is marked crashed",
        meta: { agent: state.config.name, maxRestartsPerHour: this.maxRestartsPerHour },
      })
      this.notifySnapshotChange(state.snapshot)
      this.scheduleCooldownRecovery(state)
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
    this.notifySnapshotChange(state.snapshot)
  }

  private clearRestartTimer(state: AgentRuntimeState): void {
    if (state.restartTimer === null) return
    this.clearTimeoutFn(state.restartTimer)
    state.restartTimer = null
  }

  private scheduleCooldownRecovery(state: AgentRuntimeState): void {
    if (state.cooldownRetryCount >= this.maxCooldownRetries) {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_permanent_failure",
        message: "managed agent exhausted all cooldown retries — permanently stopped",
        meta: { agent: state.config.name, cooldownRetryCount: state.cooldownRetryCount, maxCooldownRetries: this.maxCooldownRetries },
      })
      return
    }

    this.clearCooldownTimer(state)
    state.cooldownTimer = this.setTimeoutFn(() => {
      state.cooldownRetryCount += 1
      state.crashTimestamps = []
      state.snapshot.backoffMs = this.initialBackoffMs
      state.snapshot.status = "starting"
      state.snapshot.restartCount += 1

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_cooldown_recovery",
        message: "attempting cooldown recovery for managed agent",
        meta: { agent: state.config.name, cooldownRetryCount: state.cooldownRetryCount },
      })

      void this.startAgent(state.config.name)
    }, this.cooldownRecoveryMs)

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_cooldown_scheduled",
      message: `scheduled cooldown recovery in ${this.cooldownRecoveryMs}ms`,
      meta: { agent: state.config.name, cooldownRecoveryMs: this.cooldownRecoveryMs, cooldownRetryCount: state.cooldownRetryCount },
    })
  }

  private clearCooldownTimer(state: AgentRuntimeState): void {
    if (state.cooldownTimer === null) return
    this.clearTimeoutFn(state.cooldownTimer)
    state.cooldownTimer = null
  }

  private requireAgent(agent: string): AgentRuntimeState {
    const state = this.agents.get(agent)
    if (!state) {
      throw new Error(`Unknown managed agent '${agent}'.`)
    }
    return state
  }
}
