import { spawn as nodeSpawn, type ChildProcess } from "child_process"
import * as path from "path"
import { getRepoRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { RuntimeCredentialBootstrapMessage, RuntimeCredentialConfig } from "../runtime-credentials"
import type { ProviderCredentialRecord } from "../provider-credentials"

export interface RuntimeCredentialBootstrap {
  agentName: string
  runtimeConfig?: RuntimeCredentialConfig
  machineRuntimeConfig?: RuntimeCredentialConfig
  machineId?: string
  providerCredentialRecords?: ProviderCredentialRecord[]
}

export interface DaemonManagedAgent {
  name: string
  agentArg?: string
  entry: string
  channel: string
  autoStart: boolean
  args?: string[]
  env?: Record<string, string>
  getRuntimeCredentialBootstrap?: () => RuntimeCredentialBootstrap | null
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
  startupStaleAfterMs?: number
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess
  now?: () => number
  setTimeoutFn?: (cb: () => void, delay: number) => unknown
  clearTimeoutFn?: (timer: unknown) => void
  existsSync?: (p: string) => boolean
  configCheck?: (agent: string) => { ok: boolean; error?: string; fix?: string; skip?: boolean } | Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>
  /** Human-visible writer for daemon status lines such as config-check
   *  failures. Defaults to stderr; tests can inject a quieter sink. */
  statusWriter?: (text: string) => void
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
  startInFlight: boolean
  startAttemptedAtMs: number | null
  startAttemptId: number
  restartTimer: unknown | null
  crashTimestamps: number[]
  /**
   * Timestamps of daemon-orchestrated `restartAgent` calls (NOT the same as
   * `crashTimestamps`, which records actual process exits). Used by the
   * respawn-loop guard: if anything triggers `restartAgent` too often in a
   * short window, refuse further restarts and emit a loud event.
   *
   * On 2026-05-11, the health-monitor's HTTP probe declared BB sense
   * "critical" every minute because the probe's 5s timeout fired during
   * legitimate VLM work. That triggered `restartAgent` ~60x/hr. The probe
   * itself was the root cause and has since been removed; this guard is
   * the defense-in-depth backstop ensuring no other future cause (a new
   * probe, an over-eager human-triggered restart loop, etc.) can re-enter
   * the same death spiral.
   */
  orchestratedRestartTimestamps: number[]
  /** Set when the respawn-loop guard has tripped. Manual intervention
   *  needed to clear via `stopAgent` + `startAgent` (or daemon restart). */
  respawnLoopTripped: boolean
  stopRequested: boolean
  cooldownTimer: unknown | null
  cooldownRetryCount: number
  fastCrashCount: number
}

function startOfHour(ms: number): number {
  return ms - 60 * 60 * 1000
}

/**
 * Respawn-loop guard: refuse `restartAgent` if we've already orchestrated
 * RESPAWN_GUARD_MAX_RESTARTS in the past RESPAWN_GUARD_WINDOW_MS.
 *
 * Calibrated for the 2026-05-11 BB sense incident: a misconfigured probe
 * was triggering `restartAgent` every ~60s for hours. Five restarts in
 * 10 minutes is well above the rate of legitimate operational restarts
 * (a single human-initiated `ouro down && ouro up` produces one) and well
 * below the rate of a death spiral (60/hr ⇒ 10/10min).
 */
export const RESPAWN_GUARD_MAX_RESTARTS = 5
export const RESPAWN_GUARD_WINDOW_MS = 10 * 60_000

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
  private readonly startupStaleAfterMs: number
  private readonly existsSyncFn: ((p: string) => boolean) | null
  private readonly configCheckFn: ((agent: string) => { ok: boolean; error?: string; fix?: string; skip?: boolean } | Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>) | null
  private readonly statusWriterFn: (text: string) => void
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

  private writeStatus(agent: string, text: string): void {
    try {
      this.statusWriterFn(text)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.status_writer_error",
        message: "daemon status writer threw",
        meta: {
          agent,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private currentTimeMs(): number {
    const value = this.now()
    return Number.isFinite(value) ? value : Date.now()
  }

  private isStartAttemptCurrent(state: AgentRuntimeState, attemptId: number): boolean {
    return state.startAttemptId === attemptId
  }

  private markConfigCheckFailed(
    state: AgentRuntimeState,
    errorReason: string,
    fixHint: string | null,
  ): void {
    const agent = state.config.name
    state.snapshot.status = "crashed"
    state.snapshot.errorReason = errorReason
    state.snapshot.fixHint = fixHint
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.agent_config_invalid",
      message: errorReason,
      meta: { agent, fix: fixHint },
    })
    this.writeStatus(agent,
      `[daemon] ${agent}: ${errorReason}\n` +
      (fixHint ? `  Fix: ${fixHint}\n` : ""),
    )
    this.notifySnapshotChange(state.snapshot)
  }

  constructor(options: DaemonProcessManagerOptions) {
    this.maxRestartsPerHour = options.maxRestartsPerHour ?? 10
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? 60_000
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.cooldownRecoveryMs = options.cooldownRecoveryMs ?? 5 * 60 * 1_000
    this.maxCooldownRetries = options.maxCooldownRetries ?? 3
    this.startupStaleAfterMs = options.startupStaleAfterMs ?? 45_000
    this.spawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.now = options.now ?? (() => Date.now())
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, delay) => setTimeout(cb, delay))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
    this.existsSyncFn = options.existsSync ?? null
    this.configCheckFn = options.configCheck ?? null
    this.statusWriterFn = options.statusWriter ?? ((text) => {
      process.stderr.write(text)
    })
    this.onSnapshotChangeFn = options.onSnapshotChange ?? null

    for (const agent of options.agents) {
      this.agents.set(agent.name, {
        config: agent,
        process: null,
        startInFlight: false,
        startAttemptedAtMs: null,
        startAttemptId: 0,
        restartTimer: null,
        crashTimestamps: [],
        orchestratedRestartTimestamps: [],
        respawnLoopTripped: false,
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

  triggerAutoStartAgents(): void {
    for (const state of this.agents.values()) {
      if (!state.config.autoStart) continue
      void this.startAgent(state.config.name).catch((error) => {
        const errorReason = error instanceof Error ? error.message : String(error)
        this.markConfigCheckFailed(
          state,
          `agent startup threw before the worker could run: ${errorReason}`,
          "Run 'ouro doctor' for diagnostics, then retry 'ouro up'.",
        )
      })
    }
  }

  async startAgent(agent: string): Promise<void> {
    const state = this.requireAgent(agent)
    if (state.process || state.startInFlight) return

    const attemptId = state.startAttemptId + 1
    state.startAttemptId = attemptId
    state.startInFlight = true
    state.startAttemptedAtMs = this.currentTimeMs()
    try {
      this.clearRestartTimer(state)
      state.stopRequested = false
      state.snapshot.status = "starting"

      if (this.configCheckFn) {
        let result: { ok: boolean; error?: string; fix?: string; skip?: boolean }
        try {
          result = await this.configCheckFn(agent)
        } catch (error) {
          const errorReason = error instanceof Error ? error.message : String(error)
          this.markConfigCheckFailed(
            state,
            `agent config validation threw: ${errorReason}`,
            "Run 'ouro doctor' for diagnostics, then retry 'ouro up'.",
          )
          return
        }
        if (!this.isStartAttemptCurrent(state, attemptId)) return
        if (state.stopRequested) {
          state.snapshot.status = "stopped"
          state.snapshot.pid = null
          this.notifySnapshotChange(state.snapshot)
          return
        }
        if (result.skip) {
          state.snapshot.status = "stopped"
          state.snapshot.errorReason = null
          state.snapshot.fixHint = null
          emitNervesEvent({
            component: "daemon",
            event: "daemon.agent_config_skipped",
            message: result.error ?? "agent start skipped by config check",
            meta: { agent, fix: result.fix ?? null },
          })
          this.notifySnapshotChange(state.snapshot)
          return
        }
        if (!result.ok) {
          this.markConfigCheckFailed(
            state,
            result.error ?? "agent config validation failed",
            result.fix ?? null,
          )
          return
        }
        /* v8 ignore next -- defensive duplicate stale-start guard before spawn preparation @preserve */
        if (!this.isStartAttemptCurrent(state, attemptId)) return
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

      /* v8 ignore next -- defensive duplicate stale-start guard immediately before spawn @preserve */
      if (!this.isStartAttemptCurrent(state, attemptId)) return
      if (state.stopRequested) {
        state.snapshot.status = "stopped"
        state.snapshot.pid = null
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
      if (!this.isStartAttemptCurrent(state, attemptId)) {
        try {
          child.kill("SIGTERM")
        } catch {
          emitNervesEvent({
            level: "warn",
            component: "daemon",
            event: "daemon.agent_stop_error",
            message: "failed to stop stale managed agent startup",
            meta: { agent },
          })
        }
        return
      }
      state.process = child
      state.snapshot.status = "running"
      state.snapshot.pid = child.pid ?? null
      state.snapshot.startedAt = new Date(this.currentTimeMs()).toISOString()

      const bootstrap = state.config.getRuntimeCredentialBootstrap?.() ?? null
      if (bootstrap) {
        const message: RuntimeCredentialBootstrapMessage = {
          type: "ouro.runtimeCredentialBootstrap",
          agentName: bootstrap.agentName,
        }
        if (bootstrap.runtimeConfig) message.runtimeConfig = bootstrap.runtimeConfig
        if (bootstrap.machineRuntimeConfig) message.machineRuntimeConfig = bootstrap.machineRuntimeConfig
        if (bootstrap.machineId) message.machineId = bootstrap.machineId
        if (bootstrap.providerCredentialRecords) message.providerCredentialRecords = bootstrap.providerCredentialRecords
        try {
          child.send?.(message)
          emitNervesEvent({
            component: "daemon",
            event: "daemon.agent_runtime_credentials_bootstrap_sent",
            message: "sent runtime credential bootstrap to managed agent process",
            meta: {
              agent,
              runtimeConfig: !!bootstrap.runtimeConfig,
              machineRuntimeConfig: !!bootstrap.machineRuntimeConfig,
              providerCredentialRecords: bootstrap.providerCredentialRecords?.length ?? 0,
            },
          })
        } catch (error) {
          emitNervesEvent({
            level: "warn",
            component: "daemon",
            event: "daemon.agent_ipc_send_error",
            message: "failed to send runtime credential bootstrap to managed agent process",
            meta: { agent, error: error instanceof Error ? error.message : String(error) },
          })
        }
      }

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
    } finally {
      if (this.isStartAttemptCurrent(state, attemptId)) {
        state.startInFlight = false
        state.startAttemptedAtMs = null
      }
    }
  }

  async stopAgent(agent: string): Promise<void> {
    const state = this.requireAgent(agent)
    this.clearRestartTimer(state)
    this.clearCooldownTimer(state)
    state.stopRequested = true
    // NOTE: do not touch state.respawnLoopTripped / orchestratedRestartTimestamps
    // here. restartAgent calls stopAgent internally; clearing the guard here
    // would reset the window every cycle and defeat the loop-detection. The
    // guard self-clears when timestamps age out of the window (handled inside
    // restartAgent at the prune step).

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
    const state = this.requireAgent(agent)

    // Respawn-loop guard: prune timestamps outside the window, then check
    // whether we've already restarted this agent too many times in it.
    const now = this.now()
    const windowStart = now - RESPAWN_GUARD_WINDOW_MS
    state.orchestratedRestartTimestamps = state.orchestratedRestartTimestamps.filter(
      (ts) => ts >= windowStart,
    )

    // If the window is now empty, the trip naturally self-clears. That means
    // after RESPAWN_GUARD_WINDOW_MS of no restart attempts, the daemon is
    // willing to try again (e.g. for a fresh health probe failure that has
    // nothing to do with the original loop).
    if (state.respawnLoopTripped && state.orchestratedRestartTimestamps.length === 0) {
      state.respawnLoopTripped = false
      state.snapshot.errorReason = null
      state.snapshot.fixHint = null
      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_respawn_loop_cleared",
        message: "respawn-loop guard cleared by window-aging",
        meta: { agent, windowMs: RESPAWN_GUARD_WINDOW_MS },
      })
      this.notifySnapshotChange(state.snapshot)
    }

    if (state.respawnLoopTripped) {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_respawn_loop_blocked",
        message: "refused agent restart — respawn-loop guard tripped; manual intervention required",
        meta: {
          agent,
          recentRestartCount: state.orchestratedRestartTimestamps.length,
          windowMs: RESPAWN_GUARD_WINDOW_MS,
        },
      })
      return
    }

    if (state.orchestratedRestartTimestamps.length >= RESPAWN_GUARD_MAX_RESTARTS) {
      state.respawnLoopTripped = true
      state.snapshot.errorReason = `respawn loop detected: ${RESPAWN_GUARD_MAX_RESTARTS}+ restarts in ${Math.round(RESPAWN_GUARD_WINDOW_MS / 60_000)}min — refusing further restarts`
      state.snapshot.fixHint = "investigate the root cause then run `ouro up` to resume"
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_respawn_loop_tripped",
        message: "respawn-loop guard tripped; further restarts blocked",
        meta: {
          agent,
          restartCount: state.orchestratedRestartTimestamps.length,
          windowMs: RESPAWN_GUARD_WINDOW_MS,
          maxRestarts: RESPAWN_GUARD_MAX_RESTARTS,
        },
      })
      this.notifySnapshotChange(state.snapshot)
      return
    }

    state.orchestratedRestartTimestamps.push(now)

    if (state.startInFlight && !state.process) {
      const startedAt = state.startAttemptedAtMs
      /* v8 ignore next -- defensive: startInFlight always records a start timestamp @preserve */
      const elapsedMs = startedAt === null ? 0 : this.currentTimeMs() - startedAt
      if (elapsedMs < this.startupStaleAfterMs) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.agent_restart_deferred",
          message: "managed agent restart skipped while startup is already in flight",
          meta: { agent, elapsedMs, startupStaleAfterMs: this.startupStaleAfterMs },
        })
        return
      }
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.agent_startup_stale_recovered",
        message: "managed agent startup was stale; clearing the pending attempt before restart",
        meta: { agent, elapsedMs, startupStaleAfterMs: this.startupStaleAfterMs },
      })
      state.startAttemptId += 1
      state.startInFlight = false
      state.startAttemptedAtMs = null
    }
    await this.stopAgent(agent)
    await this.startAgent(agent)
  }

  async stopAll(): Promise<void> {
    for (const state of this.agents.values()) {
      await this.stopAgent(state.config.name)
    }
  }

  resetAgentFailureState(agent: string): void {
    const state = this.requireAgent(agent)
    this.clearCooldownTimer(state)
    state.cooldownRetryCount = 0
    state.crashTimestamps = []
    state.fastCrashCount = 0
    state.respawnLoopTripped = false
    state.orchestratedRestartTimestamps = []
    state.snapshot.errorReason = null
    state.snapshot.fixHint = null
    this.notifySnapshotChange(state.snapshot)
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
    state.startInFlight = false
    state.startAttemptedAtMs = null
    state.snapshot.pid = null
    state.snapshot.lastExitCode = code
    state.snapshot.lastSignal = signal

    const crashed = !state.stopRequested && code !== 0
    const now = this.currentTimeMs()
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
