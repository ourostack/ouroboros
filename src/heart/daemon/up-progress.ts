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
import { renderTerminalOperation, type TerminalOperationStep } from "./terminal-ui"

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

const BASE_UP_PHASE_PLAN = [
  "update check",
  "system setup",
  "provider checks",
  "starting daemon",
  "final daemon check",
] as const

const FRIENDLY_UP_PHASE_LABELS: Record<string, string> = {
  "update check": "Check for updates",
  "system setup": "Prepare this machine",
  "agent updates": "Update installed agents",
  "bundle cleanup": "Clean up stale bundles",
  "provider checks": "Check the providers your agents use right now",
  "starting daemon": "Start the background service",
  "final daemon check": "Confirm the background service stayed up",
}

function splitDetailLines(detail: string | undefined): string[] {
  if (!detail) return []
  return detail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

export interface UpProgressOptions {
  write?: (text: string) => void
  isTTY?: boolean
  columns?: number
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
  private readonly columns: number | undefined
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
  private upPhasePlan: readonly string[] = BASE_UP_PHASE_PLAN
  private prevLineCount = 0
  private ended = false
  private renderTimer: unknown | null = null

  constructor(options?: UpProgressOptions) {
    /* v8 ignore next -- thin wrapper: raw process.stdout.write for ANSI cursor control @preserve */
    this.write = options?.write ?? ((text: string) => process.stdout.write(text))
    /* v8 ignore next -- thin wrapper: real isTTY check injected for testability @preserve */
    this.isTTY = options?.isTTY ?? (process.stdout.isTTY === true)
    this.columns = options?.columns
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

  setPhasePlan(labels: readonly string[]): void {
    const nextPlan = [...new Set(labels.map((label) => label.trim()).filter((label) => label.length > 0))]
    this.upPhasePlan = nextPlan.length > 0 ? nextPlan : BASE_UP_PHASE_PLAN
    if (this.isTTY && this.eventScope === "up") {
      this.flushRender()
    }
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
    for (const line of splitDetailLines(detail)) {
      this.write(`    ${line}\n`)
    }
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

    const lines = this.renderLines(now)

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
    this.write(output)
  }

  private renderLines(now: number): string[] {
    if (this.eventScope === "up") {
      return this.renderUpScreen(now)
    }

    const lines: string[] = []

    for (const phase of this.completed) {
      const detailStr = phase.detail ? ` ${DIM}\u2014 ${phase.detail}${RESET}` : ""
      if (phase.status === "failure") {
        lines.push(`  ${RED}\u2717${RESET} ${phase.label}${detailStr}`)
      } else {
        lines.push(`  ${GREEN}\u2713${RESET} ${phase.label}${detailStr}`)
      }
    }

    if (this.currentPhase) {
      const elapsed = now - this.currentPhase.startedAt
      const elapsedSec = (elapsed / 1000).toFixed(1)
      const frameIndex = Math.floor(elapsed / 80) % SPINNER_FRAMES.length
      const spinner = SPINNER_FRAMES[frameIndex]
      lines.push(`  ${BOLD}${spinner}${RESET} ${this.currentPhase.label} ${DIM}(${elapsedSec}s)${RESET}`)
      for (const detailLine of splitDetailLines(this.currentPhase.detail)) {
        lines.push(`    ${DIM}${detailLine}${RESET}`)
      }
    }

    return lines
  }

  private renderUpStepLabel(label: string): string {
    return FRIENDLY_UP_PHASE_LABELS[label] ?? label
  }

  private renderUpScreen(now: number): string[] {
    const seenLabels = new Set<string>()
    const steps: TerminalOperationStep[] = this.completed.map((phase) => {
      seenLabels.add(phase.label)
      return {
        label: this.renderUpStepLabel(phase.label),
        status: phase.status === "failure" ? "failed" : "done",
        detail: phase.detail,
      }
    })

    let currentStepLabel = this.completed.some((phase) => phase.status === "failure")
      ? "Boot paused."
      : this.completed.length > 0
        ? "Boot checklist complete."
        : "Waiting to begin."
    let currentStepDetails: string[] = []
    if (this.currentPhase) {
      const elapsed = now - this.currentPhase.startedAt
      const elapsedSec = (elapsed / 1000).toFixed(1)
      const frameIndex = Math.floor(elapsed / 80) % SPINNER_FRAMES.length
      const spinner = SPINNER_FRAMES[frameIndex]
      currentStepLabel = `${spinner} ${this.renderUpStepLabel(this.currentPhase.label)} (${elapsedSec}s)`
      currentStepDetails = splitDetailLines(this.currentPhase.detail)
      steps.push({
        label: this.renderUpStepLabel(this.currentPhase.label),
        status: "active",
      })
      seenLabels.add(this.currentPhase.label)
    }

    for (const label of this.upPhasePlan) {
      if (!seenLabels.has(label)) {
        steps.push({
          label: this.renderUpStepLabel(label),
          status: "pending",
        })
      }
    }

    return renderTerminalOperation({
      isTTY: true,
      columns: this.columns,
      masthead: {
        subtitle: "Booting the local agent runtime.",
      },
      title: "Ouro boot checklist",
      summary: "Ouro will check for updates, prepare this machine, verify the providers your agents use right now, start the background service, and make sure it stays up.",
      currentStep: {
        label: currentStepLabel,
        detailLines: currentStepDetails,
      },
      steps,
      currentTitle: "Doing now",
      stepsTitle: "Boot checklist",
      suppressEvent: true,
    }).trimEnd().split("\n")
  }
}

export { UpProgress as CommandProgress }
export type CommandProgressOptions = UpProgressOptions
