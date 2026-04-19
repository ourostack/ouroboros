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
  /** Whether raw writes can safely use cursor-control ANSI for in-place rendering. */
  isTTY?: boolean
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** PID of the spawned daemon process. Used to detect early death. */
  daemonPid: number | null
  /** Check if a PID is still alive. */
  isProcessAlive?: (pid: number) => boolean
  /** Read the latest daemon log event message (tail ndjson). Returns null if unavailable. */
  readLatestDaemonEvent?: () => string | null
  /** Progress callback for parent renderers such as `ouro up`'s checklist. */
  onProgress?: (message: string) => void
  /** Whether this poller should render its own TUI. Defaults to true. */
  render?: boolean
}

export interface StartupRenderOptions {
  isTTY?: boolean
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
  options: StartupRenderOptions = {},
): string {
  const isTTY = options.isTTY ?? true
  const frameIndex = Math.floor(elapsed / 100) % SPINNER_FRAMES.length
  const spinner = SPINNER_FRAMES[frameIndex]
  const lines: string[] = []

  const elapsedSec = (elapsed / 1000).toFixed(1)
  lines.push(isTTY
    ? `${spinner} ${BOLD}waiting for agents${RESET} ${DIM}(${elapsedSec}s)${RESET}`
    : `${spinner} waiting for agents (${elapsedSec}s)`)

  for (const worker of payload.workers) {
    const statusText = isTTY ? colorStatus(worker.status) : worker.status
    lines.push(`  ${worker.agent}/${worker.worker}: ${statusText}`)
  }

  return renderStartupLines(lines, prevLineCount, isTTY)
}

/**
 * Render a pre-socket status line showing what the daemon is doing.
 */
export function renderWaitingForDaemon(
  elapsed: number,
  latestEvent: string | null,
  prevLineCount = 0,
  options: StartupRenderOptions = {},
): string {
  const isTTY = options.isTTY ?? true
  const elapsedSec = (elapsed / 1000).toFixed(1)
  const frameIndex = Math.floor(elapsed / 100) % SPINNER_FRAMES.length
  const spinner = SPINNER_FRAMES[frameIndex]
  const lines: string[] = []
  lines.push(isTTY
    ? `${spinner} ${BOLD}starting background service${RESET} ${DIM}(${elapsedSec}s)${RESET}`
    : `${spinner} starting background service (${elapsedSec}s)`)
  if (latestEvent) {
    const detail = `latest daemon event: ${latestEvent}`
    lines.push(isTTY ? `  ${DIM}${detail}${RESET}` : `  ${detail}`)
  }
  return renderStartupLines(lines, prevLineCount, isTTY)
}

/**
 * Render the final summary after all agents have resolved.
 */
function renderFinalSummary(result: StartupResult, isTTY: boolean): string {
  const lines: string[] = []

  for (const agent of result.stable) {
    lines.push(isTTY ? `  ${GREEN}\u2713${RESET} ${agent}: ${GREEN}stable${RESET}` : `  \u2713 ${agent}: stable`)
  }
  for (const d of result.degraded) {
    lines.push(isTTY ? `  ${RED}\u2717${RESET} ${d.agent}: ${RED}degraded${RESET}` : `  \u2717 ${d.agent}: degraded`)
    if (d.errorReason !== "unknown error") {
      lines.push(isTTY ? `    ${DIM}error: ${d.errorReason}${RESET}` : `    error: ${d.errorReason}`)
    }
    if (d.fixHint !== "check daemon logs") {
      lines.push(isTTY ? `    ${DIM}fix:   ${d.fixHint}${RESET}` : `    fix:   ${d.fixHint}`)
    }
  }

  if (!isTTY) return lines.join("\n") + "\n"
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
  const isTTY = deps.isTTY ?? true
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive
  const shouldRender = deps.render ?? true
  let lastProgress: string | null = null
  const reportProgress = (message: string) => {
    if (!deps.onProgress || message === lastProgress) return
    lastProgress = message
    deps.onProgress(message)
  }

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
        if (isTTY && prevLineCount > 0) {
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
      reportProgress([
        "waiting for Ouro to answer",
        latestEvent ? `- latest daemon event: ${latestEvent}` : "- background service is still starting",
      ].join("\n"))
      if (shouldRender) {
        const output = renderWaitingForDaemon(elapsed, latestEvent, prevLineCount, { isTTY })
        deps.writeRaw(output)
        prevLineCount = latestEvent ? 2 : 1
      }
    }

    if (payload) {
      reportProgress(formatStartupProgressDetail(payload))
      if (shouldRender) {
        const output = renderStartupProgress(payload, elapsed, prevLineCount, { isTTY })
        deps.writeRaw(output)
        prevLineCount = payload.workers.length + 1
      }

      const assessment = assessStability(payload, now)
      if (assessment.resolved) {
        const result: StartupResult = {
          stable: assessment.stable,
          degraded: assessment.degraded,
        }
        if (shouldRender) {
          const summary = renderFinalSummary(result, isTTY)
          deps.writeRaw(summary)
        }

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

function formatStartupWorkerLine(payload: StatusPayload["workers"][number]): string {
  const base = `- ${payload.agent}/${payload.worker}: ${payload.status}`
  if (payload.status === "crashed" && payload.errorReason) {
    return `${base} (${payload.errorReason})`
  }
  return base
}

function formatStartupProgressDetail(payload: StatusPayload): string {
  if (payload.workers.length === 0) return "Ouro answered"
  return [
    "Ouro answered",
    ...payload.workers.map((worker) => formatStartupWorkerLine(worker)),
  ].join("\n")
}

function colorStatus(status: string): string {
  const statusColor = status === "running" ? GREEN
    : status === "crashed" ? RED
    : YELLOW
  return `${statusColor}${status}${RESET}`
}

function renderStartupLines(lines: string[], prevLineCount: number, isTTY: boolean): string {
  if (!isTTY) return lines.join("\n") + "\n"

  let output = ""
  if (prevLineCount > 0) {
    output += `\x1b[${prevLineCount}A`
  }
  for (const line of lines) {
    output += `\x1b[2K${line}\n`
  }
  return output
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
