/**
 * Startup TUI — real-time progress display for `ouro up`.
 *
 * Replaces the old `verifyDaemonAlive()` socket poll with a richer system
 * that shows per-agent status, waits for stability, and reports degraded
 * agents with actionable error information.
 *
 * Pure functions (`renderStartupProgress`, `assessStability`) are fully
 * testable. The polling loop (`pollDaemonStartup`) uses dependency injection
 * for all I/O.
 */

import { parseStatusPayload, type StatusPayload } from "./cli-render"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import { emitNervesEvent } from "../../nerves/runtime"

// ── Constants ──

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const STABILITY_THRESHOLD_MS = 5_000
const POLL_INTERVAL_MS = 500

// ── ANSI helpers ──

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[38;2;46;204;64m"
const RED = "\x1b[38;2;231;76;60m"
const YELLOW = "\x1b[38;2;230;190;50m"

// ── Types ──

export interface StartupResult {
  stable: string[]
  degraded: Array<{ agent: string; errorReason: string; fixHint: string }>
}

export interface StabilityAssessment {
  resolved: boolean
  stable: string[]
  degraded: Array<{ agent: string; errorReason: string; fixHint: string }>
}

export interface PollDaemonStartupDeps {
  sendCommand: (socketPath: string, command: DaemonCommand) => Promise<DaemonResponse>
  socketPath: string
  /** Raw write — must NOT append newlines (use process.stdout.write, not console.log). */
  writeRaw: (text: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** PID of the spawned daemon process. Used to detect early death. */
  daemonPid: number | null
  /** Check if a PID is still alive. */
  isProcessAlive?: (pid: number) => boolean
  /** Read the latest daemon log event message (tail ndjson). Returns null if unavailable. */
  readLatestDaemonEvent?: () => string | null
}

// ── Pure functions ──

/**
 * Assess whether all workers have reached a terminal state (stable or crashed).
 * A worker is "stable" when status is "running" and it has been running for
 * at least STABILITY_THRESHOLD_MS. A worker is "definitively failed" when
 * status is "crashed". All other states are unresolved.
 */
export function assessStability(payload: StatusPayload, now: number): StabilityAssessment {
  const stable: string[] = []
  const degraded: Array<{ agent: string; errorReason: string; fixHint: string }> = []
  let allResolved = true

  for (const worker of payload.workers) {
    if (worker.status === "crashed") {
      degraded.push({
        agent: worker.agent,
        errorReason: worker.errorReason ?? "unknown error",
        fixHint: worker.fixHint ?? "check daemon logs",
      })
    } else if (worker.status === "running" && worker.startedAt !== null) {
      const startedMs = new Date(worker.startedAt).getTime()
      const runningMs = now - startedMs
      if (runningMs >= STABILITY_THRESHOLD_MS) {
        stable.push(worker.agent)
      } else {
        allResolved = false
      }
    } else {
      // starting, stopped, or running with null startedAt — not yet resolved
      allResolved = false
    }
  }

  return { resolved: allResolved, stable, degraded }
}

/**
 * Build an ANSI string for in-place terminal display during polling.
 * Uses cursor-up and line-clear escapes to overwrite previous output.
 */
export function renderStartupProgress(
  payload: StatusPayload,
  elapsed: number,
  prevLineCount = 0,
): string {
  const frameIndex = Math.floor(elapsed / 100) % SPINNER_FRAMES.length
  const spinner = SPINNER_FRAMES[frameIndex]
  const lines: string[] = []

  const elapsedSec = (elapsed / 1000).toFixed(1)
  lines.push(`${spinner} ${BOLD}waiting for agents${RESET} ${DIM}(${elapsedSec}s)${RESET}`)

  for (const worker of payload.workers) {
    const statusColor = worker.status === "running" ? GREEN
      : worker.status === "crashed" ? RED
      : YELLOW
    const statusText = `${statusColor}${worker.status}${RESET}`
    lines.push(`  ${worker.agent}/${worker.worker}: ${statusText}`)
  }

  let output = ""
  if (prevLineCount > 0) {
    output += `\x1b[${prevLineCount}A`
  }
  for (const line of lines) {
    output += `\x1b[2K${line}\n`
  }
  return output
}

/**
 * Render a pre-socket status line showing what the daemon is doing.
 */
export function renderWaitingForDaemon(
  elapsed: number,
  latestEvent: string | null,
  prevLineCount = 0,
): string {
  const elapsedSec = (elapsed / 1000).toFixed(1)
  const frameIndex = Math.floor(elapsed / 100) % SPINNER_FRAMES.length
  const spinner = SPINNER_FRAMES[frameIndex]
  const lines: string[] = []
  lines.push(`${spinner} ${BOLD}waiting for daemon${RESET} ${DIM}(${elapsedSec}s)${RESET}`)
  if (latestEvent) {
    lines.push(`  ${DIM}${latestEvent}${RESET}`)
  }
  let output = ""
  if (prevLineCount > 0) {
    output += `\x1b[${prevLineCount}A`
  }
  for (const line of lines) {
    output += `\x1b[2K${line}\n`
  }
  return output
}

/**
 * Render the final summary after all agents have resolved.
 */
function renderFinalSummary(result: StartupResult): string {
  const lines: string[] = []

  for (const agent of result.stable) {
    lines.push(`  ${GREEN}\u2713${RESET} ${agent}: ${GREEN}stable${RESET}`)
  }
  for (const d of result.degraded) {
    lines.push(`  ${RED}\u2717${RESET} ${d.agent}: ${RED}degraded${RESET}`)
    if (d.errorReason !== "unknown error") {
      lines.push(`    ${DIM}error: ${d.errorReason}${RESET}`)
    }
    if (d.fixHint !== "check daemon logs") {
      lines.push(`    ${DIM}fix:   ${d.fixHint}${RESET}`)
    }
  }

  return lines.map((line) => `\x1b[2K${line}`).join("\n") + "\n"
}

// ── Polling loop ──

/**
 * Poll the daemon's status socket until all agents are stable or definitively
 * failed, rendering real-time progress to the terminal.
 *
 * Detects daemon process death: if the spawned PID is no longer alive and the
 * socket never came up, reports the failure immediately instead of spinning.
 */
export async function pollDaemonStartup(deps: PollDaemonStartupDeps): Promise<StartupResult> {
  const startTime = deps.now()
  let prevLineCount = 0
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive

  emitNervesEvent({
    component: "daemon",
    event: "daemon.startup_poll_start",
    message: "beginning startup stability polling",
    meta: { socketPath: deps.socketPath, daemonPid: deps.daemonPid },
  })

  while (true) {
    const now = deps.now()
    const elapsed = now - startTime

    let payload: StatusPayload | null = null
    try {
      const response = await deps.sendCommand(deps.socketPath, { kind: "daemon.status" })
      payload = parseStatusPayload(response.data)
    } catch {
      // Socket not yet available — check if the daemon process is still alive
      if (deps.daemonPid !== null && !isAlive(deps.daemonPid)) {
        const latestEvent = deps.readLatestDaemonEvent?.() ?? null
        const errorMsg = latestEvent ?? "daemon process died during startup"
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.startup_process_died",
          message: "daemon process died before socket came up",
          meta: { pid: deps.daemonPid, lastEvent: latestEvent },
        })
        // Clear the waiting line
        if (prevLineCount > 0) {
          let clear = `\x1b[${prevLineCount}A`
          for (let i = 0; i < prevLineCount; i++) clear += `\x1b[2K\n`
          deps.writeRaw(clear)
        }
        return {
          stable: [],
          degraded: [{ agent: "daemon", errorReason: errorMsg, fixHint: "check daemon logs or run `ouro doctor`" }],
        }
      }

      // Show what the daemon is doing from its log
      const latestEvent = deps.readLatestDaemonEvent?.() ?? null
      const output = renderWaitingForDaemon(elapsed, latestEvent, prevLineCount)
      deps.writeRaw(output)
      prevLineCount = latestEvent ? 2 : 1
    }

    if (payload) {
      const output = renderStartupProgress(payload, elapsed, prevLineCount)
      deps.writeRaw(output)
      prevLineCount = payload.workers.length + 1

      const assessment = assessStability(payload, now)
      if (assessment.resolved) {
        const result: StartupResult = {
          stable: assessment.stable,
          degraded: assessment.degraded,
        }
        const summary = renderFinalSummary(result)
        deps.writeRaw(summary)

        emitNervesEvent({
          component: "daemon",
          event: "daemon.startup_poll_end",
          message: "startup polling complete",
          meta: {
            stableCount: result.stable.length,
            degradedCount: result.degraded.length,
            elapsedMs: elapsed,
          },
        })
        return result
      }
    }

    await deps.sleep(POLL_INTERVAL_MS)
  }
}

/* v8 ignore start -- process liveness check: uses real process.kill(0), tested via deployment @preserve */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/* v8 ignore stop */
