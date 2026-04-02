/**
 * Imperative snake-themed spinner for the CLI.
 *
 * Writes directly to stderr via setInterval — no React, no Ink.
 * Features:
 * - Ouroboros snake animation frames (serpent eating its own tail)
 * - Elapsed time display
 * - Stall detection with color interpolation: green -> amber (15s) -> red (45s)
 * - Phrase rotation from agent.json phrase pools
 * - Pause/resume for log coordination
 */

import { pickPhrase } from "../../mind/phrases"
import { emitNervesEvent } from "../../nerves/runtime"

// Ring spinner frames (growing/shrinking — option #6)
const SNAKE_FRAMES = [
  "\u2219",      // ∙ (small dot)
  "\u25CB",      // ○ (white circle)
  "\u25CE",      // ◎ (bullseye)
  "\u25CF",      // ● (black circle)
  "\u25CE",      // ◎ (bullseye)
  "\u25CB",      // ○ (white circle)
]

// ANSI color helpers — RGB escape sequences
const RGB_GREEN = "\x1b[38;2;46;204;64m"   // #2ecc40 — ouroboros green
const RGB_AMBER = "\x1b[38;2;243;156;18m"  // #f39c12
const RGB_RED = "\x1b[38;2;231;76;60m"     // #e74c3c
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

function stallColor(seconds: number): string {
  if (seconds >= 45) return RGB_RED
  if (seconds >= 15) return RGB_AMBER
  return RGB_GREEN
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

export class ImperativeSpinner {
  private frames = SNAKE_FRAMES
  private frameIdx = 0
  private iv: NodeJS.Timeout | null = null
  private phraseIv: NodeJS.Timeout | null = null
  private msg: string
  private phrases: readonly string[] | null = null
  private lastPhrase = ""
  private stopped = false
  private startTime = 0
  private paused = false

  constructor(message = "working", phrases?: readonly string[]) {
    this.msg = message
    if (phrases && phrases.length > 0) this.phrases = phrases
  }

  start(): void {
    this.stopped = false
    this.paused = false
    this.startTime = Date.now()
    process.stderr.write("\r\x1b[K")
    this.render()
    this.iv = setInterval(() => this.render(), 120)
    if (this.phrases) {
      this.phraseIv = setInterval(() => this.rotatePhrase(), 1500)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.spinner_start",
      message: "imperative spinner started",
      meta: { phrase: this.msg },
    })
  }

  private render(): void {
    /* v8 ignore next -- race guard: timer callback fires after stop() @preserve */
    if (this.stopped || this.paused) return
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000)
    const color = stallColor(elapsed)
    const timeStr = formatTime(elapsed)
    const frame = this.frames[this.frameIdx % this.frames.length]
    process.stderr.write(`\r\x1b[K${color}${frame} ${this.msg}${RESET} ${DIM}${timeStr}${RESET} `)
    this.frameIdx++
  }

  private rotatePhrase(): void {
    /* v8 ignore next -- race guard: timer callback fires after stop() @preserve */
    if (this.stopped) return
    const next = pickPhrase(this.phrases!, this.lastPhrase)
    this.lastPhrase = next
    this.msg = next
  }

  /* v8 ignore start -- pause/resume: exercised at runtime via log sink coordination @preserve */
  pause(): void {
    if (this.stopped) return
    this.paused = true
    process.stderr.write("\r\x1b[K")
  }

  resume(): void {
    if (this.stopped) return
    this.paused = false
    this.render()
  }
  /* v8 ignore stop */

  stop(ok?: string): void {
    this.stopped = true
    if (this.iv) { clearInterval(this.iv); this.iv = null }
    if (this.phraseIv) { clearInterval(this.phraseIv); this.phraseIv = null }
    process.stderr.write("\r\x1b[K")
    /* v8 ignore next -- ok parameter currently unused by callers @preserve */
    if (ok) process.stderr.write(`\x1b[32m\u2713\x1b[0m ${ok}\n`)
  }

  fail(msg: string): void {
    this.stop()
    process.stderr.write(`\x1b[31m\u2717\x1b[0m ${msg}\n`)
  }
}
