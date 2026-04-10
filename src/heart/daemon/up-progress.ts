/**
 * UpProgress — accumulated-checklist progress renderer for `ouro up`.
 *
 * Displays completed phases with checkmarks, the current phase with a
 * spinner and elapsed time, and pending phases as plain text. Uses ANSI
 * cursor control for in-place overwriting in TTY mode, and falls back to
 * static line-per-phase output in non-TTY mode.
 *
 * The caller drives animation by calling `render(now)` on a setInterval.
 * This module owns no timers.
 */

import { emitNervesEvent } from "../../nerves/runtime"

// ── ANSI constants (shared with startup-tui.ts pattern) ──

const SPINNER_FRAMES = "\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[38;2;46;204;64m"

// ── Types ──

interface CompletedPhase {
  label: string
  detail?: string
}

interface CurrentPhase {
  label: string
  startedAt: number
}

export interface UpProgressOptions {
  write?: (text: string) => void
  isTTY?: boolean
}

// ── UpProgress class ──

export class UpProgress {
  private readonly write: (text: string) => void
  private readonly isTTY: boolean
  private completed: CompletedPhase[] = []
  private currentPhase: CurrentPhase | null = null
  private prevLineCount = 0
  private ended = false

  constructor(options?: UpProgressOptions) {
    /* v8 ignore next -- thin wrapper: raw process.stdout.write for ANSI cursor control @preserve */
    this.write = options?.write ?? ((text: string) => process.stdout.write(text))
    /* v8 ignore next -- thin wrapper: real isTTY check injected for testability @preserve */
    this.isTTY = options?.isTTY ?? (process.stdout.isTTY === true)
  }

  /**
   * Begin a new phase with spinner. If a phase is already active, it is
   * auto-completed (no detail text).
   */
  startPhase(label: string): void {
    if (this.currentPhase) {
      this.completePhase(this.currentPhase.label)
    }
    this.currentPhase = { label, startedAt: Date.now() }
  }

  /**
   * Emit a one-line status breadcrumb in non-TTY mode without affecting the
   * accumulated checklist state. Used for daemon startup sub-steps.
   */
  announceStep(label: string): void {
    if (this.isTTY) return
    this.write(label)
  }

  /**
   * Mark the current phase as done. In non-TTY mode, immediately writes
   * a static line. Emits a nerves event for observability.
   */
  completePhase(label: string, detail?: string): void {
    if (!this.currentPhase) {
      return
    }

    const elapsedMs = Date.now() - this.currentPhase.startedAt
    this.completed.push({ label, detail })
    this.currentPhase = null

    emitNervesEvent({
      component: "daemon",
      event: "daemon.up_phase_complete",
      message: `phase complete: ${label}`,
      meta: { phase: label, detail: detail ?? null, elapsedMs },
    })

    if (!this.isTTY) {
      const detailStr = detail ? ` \u2014 ${detail}` : ""
      this.write(`  \u2713 ${label}${detailStr}\n`)
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
      lines.push(`  ${GREEN}\u2713${RESET} ${phase.label}${detailStr}`)
    }

    // Current phase with spinner
    if (this.currentPhase) {
      const elapsed = now - this.currentPhase.startedAt
      const elapsedSec = (elapsed / 1000).toFixed(1)
      const frameIndex = Math.floor(elapsed / 80) % SPINNER_FRAMES.length
      const spinner = SPINNER_FRAMES[frameIndex]
      lines.push(`  ${BOLD}${spinner}${RESET} ${this.currentPhase.label} ${DIM}(${elapsedSec}s)${RESET}`)
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
    }

    if (this.isTTY) {
      const output = this.render(Date.now())
      if (output) {
        this.write(output)
      }
    }
  }
}
