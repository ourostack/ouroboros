/**
 * Per-test audit rules for nerves event coverage.
 *
 * Rule 1: every-test-emits -- every captured test must emit at least one event
 * Rule 2: lifecycle start/end pairing -- process-scoped _start events must have matching _end or _error
 * Rule 3: error context -- error-level events must have non-empty meta
 */

export interface PerTestEvent {
  component: string
  event: string
  level?: string
  meta?: Record<string, unknown>
}

export type PerTestData = Record<string, PerTestEvent[]>

export interface EveryTestEmitsResult {
  status: "pass" | "fail"
  total_tests: number
  silent_tests: string[]
}

export interface StartEndPairingResult {
  status: "pass" | "fail"
  unmatched: string[]
}

export interface ErrorContextResult {
  status: "pass" | "fail"
  violations: string[]
}

// Only these starts represent process-scoped lifecycle contracts. Most nerves
// `_start` events are local operation markers that can be legitimately observed
// by a narrow unit test without driving the whole operation to completion.
export const LIFECYCLE_PAIRED_STARTS = new Set<string>([
  "daemon.server_start",
  "daemon.update_checker_start",
  "daemon.apply_pending_updates_start",
])

/**
 * Rule 1: Every captured test must emit at least one nerves event.
 */
export function checkEveryTestEmits(data: PerTestData): EveryTestEmitsResult {
  if (!data || typeof data !== "object") {
    return { status: "fail", total_tests: 0, silent_tests: [] }
  }

  const entries = Object.entries(data)
  const silent = entries
    .filter(([, events]) => !Array.isArray(events) || events.length === 0)
    .map(([name]) => name)

  return {
    status: entries.length > 0 && silent.length === 0 ? "pass" : "fail",
    total_tests: entries.length,
    silent_tests: silent,
  }
}

/**
 * Rule 2: Process-scoped lifecycle _start events must have matching _end or _error within the same test.
 */
export function checkStartEndPairing(data: PerTestData): StartEndPairingResult {
  if (!data || typeof data !== "object") {
    return { status: "fail", unmatched: [] }
  }

  const unmatched: string[] = []

  for (const [testName, events] of Object.entries(data)) {
    if (!Array.isArray(events)) continue

    const eventNames = events.map((e) => e.event)
    const startEvents = eventNames.filter((name) => LIFECYCLE_PAIRED_STARTS.has(name))

    for (const startEvent of startEvents) {
      const prefix = startEvent.slice(0, -"_start".length)
      const hasEnd = eventNames.some((name) => name === `${prefix}_end`)
      const hasError = eventNames.some((name) => name === `${prefix}_error`)
      if (!hasEnd && !hasError) {
        unmatched.push(`${testName}: ${startEvent} has no matching ${prefix}_end or ${prefix}_error`)
      }
    }
  }

  return {
    status: unmatched.length === 0 ? "pass" : "fail",
    unmatched,
  }
}

/**
 * Rule 3: Error-level events must have non-empty meta (at least one key).
 */
export function checkErrorContext(data: PerTestData): ErrorContextResult {
  if (!data || typeof data !== "object") {
    return { status: "fail", violations: [] }
  }

  const violations: string[] = []

  for (const [testName, events] of Object.entries(data)) {
    if (!Array.isArray(events)) continue

    for (const event of events) {
      if (event.level !== "error") continue

      const meta = event.meta
      if (!meta || typeof meta !== "object" || Object.keys(meta).length === 0) {
        violations.push(`${testName}: error event '${event.event}' has empty or missing meta`)
      }
    }
  }

  return {
    status: violations.length === 0 ? "pass" : "fail",
    violations,
  }
}
