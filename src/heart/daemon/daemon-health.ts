import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { LogEvent } from "../../nerves"
import type { DriftFinding } from "./drift-detection"

export interface DegradedComponent {
  component: string
  reason: string
  since: string
}

export interface AgentHealth {
  status: string
  pid: number | null
  crashes: number
}

export interface HabitHealth {
  cronStatus: string
  lastFired: string | null
  fallback: boolean
}

export interface SafeModeState {
  active: boolean
  reason: string
  enteredAt: string
}

/**
 * Daemon-wide rollup vocabulary — locked layer-1 contract.
 *
 * - `RollupStatus` is what `computeDaemonRollup` returns (post-inventory,
 *   four-state). The function never returns `"down"` because by the time
 *   the rollup is reachable the daemon has already started, opened its
 *   socket, and read its agent inventory — pre-inventory failure is the
 *   caller's domain.
 * - `DaemonStatus` is what `DaemonHealthState.status` accepts. The caller
 *   widens the rollup result with `"down"` along the daemon-entry failure
 *   path (e.g. when the daemon process can't read inventory at all).
 *
 * `isRollupStatus` and `isDaemonStatus` are runtime guards used both by
 * `readHealth` (validating cached health files on disk) and by render-side
 * consumers that want to narrow `unknown` JSON into the typed union before
 * branching on it.
 */
// Single source of truth — the literal lists below are the runtime
// projection of the type unions. A future literal added to RollupStatus
// MUST also be added to ROLLUP_STATUS_LITERALS or `satisfies` blows up
// at tsc. That tightens the Layer 1 contract: producer + consumer +
// guard all stay in lockstep.
const ROLLUP_STATUS_LITERALS = ["healthy", "partial", "degraded", "safe-mode"] as const
const DAEMON_STATUS_LITERALS = [...ROLLUP_STATUS_LITERALS, "down"] as const

export type RollupStatus = typeof ROLLUP_STATUS_LITERALS[number]
export type DaemonStatus = typeof DAEMON_STATUS_LITERALS[number]

const ROLLUP_STATUS_VALUES: ReadonlySet<RollupStatus> = new Set<RollupStatus>(ROLLUP_STATUS_LITERALS)
const DAEMON_STATUS_VALUES: ReadonlySet<DaemonStatus> = new Set<DaemonStatus>(DAEMON_STATUS_LITERALS)

export function isRollupStatus(value: unknown): value is RollupStatus {
  return typeof value === "string" && ROLLUP_STATUS_VALUES.has(value as RollupStatus)
}

export function isDaemonStatus(value: unknown): value is DaemonStatus {
  return typeof value === "string" && DAEMON_STATUS_VALUES.has(value as DaemonStatus)
}

export interface DaemonHealthState {
  status: DaemonStatus
  mode: string
  pid: number
  startedAt: string
  uptimeSeconds: number
  safeMode: SafeModeState | null
  degraded: DegradedComponent[]
  /**
   * Per-lane drift findings between intent (`agent.json`) and observation
   * (`state/providers.json`) for each enabled agent. Populated by Layer 4
   * during `buildDaemonHealthState`. Surfaced to the operator at the
   * daemon-down render path (`renderRollupStatusLine`'s `partial` branch)
   * so a drift-induced `partial` rollup carries an explanation rather than
   * an opaque "some agents unhealthy" copy. Empty array when no drift.
   */
  drift: DriftFinding[]
  agents: Record<string, AgentHealth>
  habits: Record<string, HabitHealth>
}

export class DaemonHealthWriter {
  private readonly healthPath: string

  constructor(healthPath: string) {
    this.healthPath = healthPath
  }

  writeHealth(state: DaemonHealthState): void {
    try {
      const dir = path.dirname(this.healthPath)
      fs.mkdirSync(dir, { recursive: true })

      const tmpPath = `${this.healthPath}.tmp.${process.pid}`
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8")
      fs.renameSync(tmpPath, this.healthPath)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.health_written",
        message: "daemon health file written",
        meta: { path: this.healthPath, status: state.status },
      })
    } catch {
      // Best-effort: if we can't write, don't crash the daemon.
    }
  }
}

export function getDefaultHealthPath(): string {
  return path.join(os.homedir(), ".ouro-cli", "daemon-health.json")
}

/** Events that trigger a debounced health file write */
export const HEALTH_TRACKED_EVENTS: ReadonlySet<string> = new Set([
  "daemon.habit_cron_verification_failed",
  "daemon.habit_fire",
  "daemon.agent_exit",
  "daemon.agent_started",
  "daemon.agent_config_invalid",
  "daemon.agent_config_failure",
  "daemon.agent_entry_missing",
  "daemon.agent_spawn_failed",
  "daemon.agent_restart_exhausted",
  "daemon.agent_permanent_failure",
  "daemon.agent_cooldown_recovery",
  "daemon.bootstrap_degraded",
  "daemon.safe_mode_entered",
  "daemon.habit_scheduler_start",
])

/**
 * Creates a nerves LogSink that triggers debounced health writes on relevant events.
 * Components don't know about the health writer — they just emit events.
 */
export function createHealthNervesSink(
  writer: DaemonHealthWriter,
  getState: () => DaemonHealthState,
): (entry: LogEvent) => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  return (entry: LogEvent): void => {
    if (!HEALTH_TRACKED_EVENTS.has(entry.event)) {
      return
    }

    // Debounce: max once per second
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const state = getState()
      writer.writeHealth(state)
    }, 1000)
  }
}

export function readHealth(healthPath: string): DaemonHealthState | null {
  try {
    const raw = fs.readFileSync(healthPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>

    if (
      !isDaemonStatus(parsed.status) ||
      typeof parsed.mode !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.uptimeSeconds !== "number" ||
      !Array.isArray(parsed.degraded) ||
      typeof parsed.agents !== "object" ||
      parsed.agents === null ||
      typeof parsed.habits !== "object" ||
      parsed.habits === null
    ) {
      return null
    }

    // `drift` is required in DaemonHealthState but absent from cached
    // health files written by pre-Layer-4 daemons. Tolerate that legacy
    // shape by defaulting to []; the rest of the file is still valid.
    const drift: DriftFinding[] = Array.isArray(parsed.drift)
      ? (parsed.drift as DriftFinding[])
      : []

    return {
      status: parsed.status,
      mode: parsed.mode,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      uptimeSeconds: parsed.uptimeSeconds,
      safeMode: parsed.safeMode as SafeModeState | null,
      degraded: parsed.degraded as DegradedComponent[],
      drift,
      agents: parsed.agents as Record<string, AgentHealth>,
      habits: parsed.habits as Record<string, HabitHealth>,
    }
  } catch {
    return null
  }
}
