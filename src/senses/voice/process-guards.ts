import { emitNervesEvent } from "../../nerves/runtime"

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

export interface VoiceProcessGuardOptions {
  /** Uncaught exceptions tolerated inside the window; one more triggers a restart. */
  limit?: number
  windowMs?: number
  exit?: (code: number) => void
  now?: () => number
}

/**
 * Keep one bad call from taking the voice process down for every other caller. A failure that
 * escapes a call's own handlers is logged and the process keeps serving. A burst of uncaught
 * exceptions means the process is no longer healthy, so it exits and lets the supervisor restart it.
 */
export function installVoiceProcessGuards(proc: NodeJS.Process, options: VoiceProcessGuardOptions = {}): void {
  const limit = options.limit ?? 5
  const windowMs = options.windowMs ?? 60_000
  const exit = options.exit ?? ((code: number) => proc.exit(code))
  const now = options.now ?? Date.now
  const recent: number[] = []
  proc.on("unhandledRejection", (reason) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_process_error",
      message: "Voice process caught an unhandled promise rejection and kept running",
      meta: { kind: "unhandledRejection", error: describeError(reason) },
    })
  })
  proc.on("uncaughtException", (error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_process_error",
      message: "Voice process caught an uncaught exception and kept running",
      meta: { kind: "uncaughtException", error: describeError(error) },
    })
    const at = now()
    recent.push(at)
    while (recent.length > 0 && at - recent[0]! > windowMs) recent.shift()
    if (recent.length > limit) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_process_crash_budget_exhausted",
        message: "Voice process exceeded its uncaught exception budget and is exiting for a supervisor restart",
        meta: { limit, windowMs, count: recent.length },
      })
      exit(1)
    }
  })
}
