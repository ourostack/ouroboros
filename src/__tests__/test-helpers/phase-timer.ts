export interface PhaseTimer {
  /** Completes the current phase (recording its duration) and enters the next. */
  enter(phase: string): void
  report(): string
  /** Completes the current phase and stops the watchdog. */
  done(): void
  /** Appends the final report to a thrown Error so it travels with the failure. */
  annotate(error: unknown): unknown
}

/**
 * Phase timings for one test. Silent while the test finishes within `watchdogMs`
 * (set below the test timeout), whether it passes or fails; a failure also gets
 * the report appended via `annotate`. A test still running when the watchdog
 * fires prints a report to stderr once, even if it later passes. A timed-out
 * test never throws, so that report is the only trace of it. The timer callback
 * can be delayed by synchronous work, so the report states the actual
 * elapsed time when it ran. It samples the latest entered phase at that
 * moment; it does not prove which phase the runner's timeout interrupted.
 * Assertions and timeouts are the caller's, unchanged.
 */
export function createPhaseTimer(label: string, options: { watchdogMs?: number, now?: () => number, write?: (text: string) => void } = {}): PhaseTimer {
  const now = options.now ?? (() => performance.now())
  const write = options.write ?? ((text: string) => { process.stderr.write(text) })
  const start = now()
  const completed: Array<[string, number]> = []
  let current: { phase: string, enteredAt: number } | undefined
  let finished = false
  const complete = () => {
    if (current) completed.push([current.phase, Math.round(now() - start - current.enteredAt)])
    current = undefined
  }
  const report = () => {
    const elapsed = Math.round(now() - start)
    const done = completed.map(([phase, ms]) => `${phase}=${ms}ms`).join(" ") || "none"
    const active = current ? `${current.phase} (entered at ${Math.round(current.enteredAt)}ms, ${elapsed - Math.round(current.enteredAt)}ms so far)` : "none"
    return `phase timings for ${label} at ${elapsed}ms: completed ${done}; latest observed phase ${active}`
  }
  const watchdog = options.watchdogMs === undefined ? undefined : setTimeout(() => {
    if (!finished) write(`${report()}; slow: still running, watchdog scheduled for ${options.watchdogMs}ms\n`)
  }, options.watchdogMs)
  watchdog?.unref()
  return {
    enter: (phase) => { complete(); current = { phase, enteredAt: now() - start } },
    report,
    done: () => { finished = true; complete(); if (watchdog) clearTimeout(watchdog) },
    annotate: (error) => {
      if (error instanceof Error) error.message = `${error.message}\n${report()}`
      return error
    },
  }
}
