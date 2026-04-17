/**
 * UpProgress — accumulated-checklist progress renderer.
 *
 * Displays completed phases with checkmarks, the current phase with a
 * spinner and elapsed time, and pending phases as plain text. Uses ANSI
 * cursor control for in-place overwriting in TTY mode, and falls back to
 * static line-per-phase output in non-TTY mode.
 *
 * The caller can drive animation by calling `render(now)`. In production CLI
 * use, `autoRender` starts a short-lived timer while a TTY phase is active so
 * long operations never leave a dead-looking cursor.
 */

import { emitNervesEvent } from "../../nerves/runtime"

// ── ANSI constants (shared with startup-tui.ts pattern) ──

const SPINNER_FRAMES = "\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[38;2;46;204;64m"
const RED = "\x1b[38;2;255;106;106m"

// ── Types ──

interface CompletedPhase {
  status: "success" | "failure"
  label: string
  detail?: string
}

interface CurrentPhase {
  label: string
  startedAt: number
  detail?: string
}

export interface UpProgressOptions {
  write?: (text: string) => void
  isTTY?: boolean
  now?: () => number
  autoRender?: boolean
  renderIntervalMs?: number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  eventScope?: "up" | "command"
  commandName?: string
}

// ── UpProgress class ──

export class UpProgress {
  private readonly write: (text: string) => void
  private readonly isTTY: boolean
  private readonly now: () => number
  private readonly autoRender: boolean
  private readonly renderIntervalMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly eventScope: "up" | "command"
  private readonly commandName: string | null
  private completed: CompletedPhase[] = []
  private currentPhase: CurrentPhase | null = null
  private currentDetail: string | null = null
  private prevLineCount = 0
  private ended = false
  private renderTimer: unknown | null = null

  constructor(options?: UpProgressOptions) {
    /* v8 ignore next -- thin wrapper: raw process.stdout.write for ANSI cursor control @preserve */
    this.write = options?.write ?? ((text: string) => process.stdout.write(text))
    /* v8 ignore next -- thin wrapper: real isTTY check injected for testability @preserve */
    this.isTTY = options?.isTTY ?? (process.stdout.isTTY === true)
    /* v8 ignore next -- thin wrapper: real Date.now injected for testability @preserve */
    this.now = options?.now ?? (() => Date.now())
    this.autoRender = options?.autoRender ?? false
    this.renderIntervalMs = options?.renderIntervalMs ?? 80
    /* v8 ignore start -- real timers are injected in tests when needed @preserve */
    this.setTimer = options?.setInterval ?? ((callback, ms) => setInterval(callback, ms))
    this.clearTimer = options?.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    /* v8 ignore stop */
    this.eventScope = options?.eventScope ?? "up"
    this.commandName = options?.commandName ?? null
  }

  /**
   * Begin a new phase with spinner. If a phase is already active, it is
   * auto-completed (no detail text).
   */
  startPhase(label: string): void {
    if (this.currentPhase) {
      this.completePhase(this.currentPhase.label)
    }
    this.currentPhase = { label, startedAt: this.now() }
    this.currentDetail = null
    if (this.isTTY) {
      this.ensureAutoRender()
      this.flushRender()
    } else {
      this.write(`  ... ${label}\n`)
    }
  }

  /**
   * Emit a one-line status breadcrumb in non-TTY mode without affecting the
   * accumulated checklist state. Used for daemon startup sub-steps.
   */
  announceStep(label: string): void {
    if (this.currentPhase) {
      this.updateDetail(label)
      return
    }
    if (this.isTTY) return
    this.write(`    ${label}\n`)
  }

  /**
   * Update the sub-step detail on the current spinner phase. Rendered as
   * "label (Xs) -- detail" in TTY mode. In non-TTY mode, writes changed
   * detail lines so long operations remain visible in logs and captured output.
   */
  updateDetail(detail: string): void {
    if (!this.currentPhase || detail === this.currentDetail) return
    this.currentDetail = detail
    this.currentPhase.detail = detail
    if (this.isTTY) {
      this.flushRender()
      return
    }
    this.write(`    ${detail}\n`)
  }

  /**
   * Mark the current phase as done. In non-TTY mode, immediately writes
   * a static line. Emits a nerves event for observability.
   */
  completePhase(label: string, detail?: string): void {
    if (!this.currentPhase) {
      return
    }

    const elapsedMs = this.now() - this.currentPhase.startedAt
    this.completed.push({ status: "success", label, detail })
    this.currentPhase = null
    this.currentDetail = null
    this.stopAutoRender()

    if (this.eventScope === "command") {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.cli_progress_phase_complete",
        message: `phase complete: ${label}`,
        meta: { command: this.commandName, phase: label, detail: detail ?? null, elapsedMs },
      })
    } else {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.up_phase_complete",
        message: `phase complete: ${label}`,
        meta: { phase: label, detail: detail ?? null, elapsedMs },
      })
    }

    if (this.isTTY) {
      this.flushRender()
    } else {
      const detailStr = detail ? ` \u2014 ${detail}` : ""
      this.write(`  \u2713 ${label}${detailStr}\n`)
    }
  }

  failPhase(label: string, detail?: string): void {
    if (!this.currentPhase) {
      return
    }

    const elapsedMs = this.now() - this.currentPhase.startedAt
    this.completed.push({ status: "failure", label, detail })
    this.currentPhase = null
    this.currentDetail = null
    this.stopAutoRender()

    if (this.eventScope === "command") {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.cli_progress_phase_failed",
        message: `phase failed: ${label}`,
        meta: { command: this.commandName, phase: label, detail: detail ?? null, elapsedMs },
      })
    } else {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.up_phase_failed",
        message: `phase failed: ${label}`,
        meta: { phase: label, detail: detail ?? null, elapsedMs },
      })
    }

    if (this.isTTY) {
      this.flushRender()
    } else {
      const detailStr = detail ? ` \u2014 ${detail}` : ""
      this.write(`  \u2717 ${label}${detailStr}\n`)
    }
  }

  /**
   * Build an ANSI string for in-place terminal display. Returns empty
   * string in non-TTY mode (output is written eagerly in completePhase).
   */
  render(now: number): string {
    if (!this.isTTY) {
      return ""
    }

    const lines: string[] = []

    // Completed phases
    for (const phase of this.completed) {
      const detailStr = phase.detail ? ` ${DIM}\u2014 ${phase.detail}${RESET}` : ""
      if (phase.status === "failure") {
        lines.push(`  ${RED}\u2717${RESET} ${phase.label}${detailStr}`)
      } else {
        lines.push(`  ${GREEN}\u2713${RESET} ${phase.label}${detailStr}`)
      }
    }

    // Current phase with spinner
    if (this.currentPhase) {
      const elapsed = now - this.currentPhase.startedAt
      const elapsedSec = (elapsed / 1000).toFixed(1)
      const frameIndex = Math.floor(elapsed / 80) % SPINNER_FRAMES.length
      const spinner = SPINNER_FRAMES[frameIndex]
      const detailSuffix = this.currentPhase.detail ? ` \u2014 ${this.currentPhase.detail}` : ""
      lines.push(`  ${BOLD}${spinner}${RESET} ${this.currentPhase.label} ${DIM}(${elapsedSec}s)${detailSuffix}${RESET}`)
    }

    let output = ""
    if (this.prevLineCount > 0) {
      output += `\x1b[${this.prevLineCount}A`
    }
    for (const line of lines) {
      output += `\x1b[2K${line}\n`
    }
    // Clear any leftover lines from previous render that are no longer needed
    if (lines.length < this.prevLineCount) {
      for (let i = 0; i < this.prevLineCount - lines.length; i++) {
        output += `\x1b[2K\n`
      }
    }
    this.prevLineCount = lines.length

    return output
  }

  /**
   * Finalize the progress display. Clears the current phase (if any) and
   * writes the final checklist state. Idempotent.
   */
  end(): void {
    if (this.ended) {
      return
    }
    this.ended = true

    if (this.currentPhase) {
      this.currentPhase = null
      this.currentDetail = null
    }
    this.stopAutoRender()

    if (this.isTTY) {
      this.flushRender()
    }
  }

  private ensureAutoRender(): void {
    if (!this.autoRender || !this.isTTY || this.renderTimer !== null) {
      return
    }
    this.renderTimer = this.setTimer(() => this.flushRender(), this.renderIntervalMs)
  }

  private stopAutoRender(): void {
    if (this.renderTimer === null) {
      return
    }
    this.clearTimer(this.renderTimer)
    this.renderTimer = null
  }

  private flushRender(): void {
    const output = this.render(this.now())
    if (output) {
      this.write(output)
    }
  }
}

export { UpProgress as CommandProgress }
export type CommandProgressOptions = UpProgressOptions
