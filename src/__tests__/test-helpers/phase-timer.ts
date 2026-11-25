export interface PhaseTimer {
  mark(phase: string): void
  report(): string
  /** Stops the watchdog. Passing runs print nothing. */
  done(): void
  /** Appends the phase timings to a failure so they travel with it. */
  annotate(error: unknown): unknown
}

/**
 * Per-phase elapsed times for one test. Silent on success. On failure,
 * `annotate` adds them to the error; a test that hangs past `watchdogMs` (set
 * below the test timeout) prints them once to stderr, since a timed-out test
 * never throws. Assertions and timeouts are the caller's, unchanged.
 */
export function createPhaseTimer(label: string, options: { watchdogMs?: number, now?: () => number, write?: (text: string) => void } = {}): PhaseTimer {
  const now = options.now ?? (() => Date.now())
  const write = options.write ?? ((text: string) => { process.stderr.write(text) })
  const start = now()
  const marks: Array<[string, number]> = []
  const report = () => `phase timings for ${label} (ms since start): ${marks.map(([name, at]) => `${name}=${at}`).join(" ") || "no phase reached"}`
  let finished = false
  const watchdog = options.watchdogMs === undefined ? undefined : setTimeout(() => {
    if (!finished) write(`${report()}; still running after ${options.watchdogMs}ms\n`)
  }, options.watchdogMs)
  watchdog?.unref()
  return {
    mark: (phase) => { marks.push([phase, now() - start]) },
    report,
    done: () => { finished = true; if (watchdog) clearTimeout(watchdog) },
    annotate: (error) => {
      if (error instanceof Error) error.message = `${error.message}\n${report()}`
      return error
    },
  }
}
