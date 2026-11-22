import { emitNervesEvent } from "../nerves/runtime"

/** How long a sense may spend ending its in-flight turns after SIGTERM before it exits anyway. */
export const SENSE_SHUTDOWN_GRACE_MS = 10_000

type ShutdownProcess = Pick<NodeJS.Process, "once" | "removeListener" | "exit">

export interface SenseShutdownOptions {
  sense: string
  /** Abort in-flight turns (leaving their inbounds pending) and release the sense's resources. */
  stop: () => unknown
  graceMs?: number
  process?: ShutdownProcess
}

/**
 * Exit within a bounded time on SIGTERM or SIGINT. The sense's `stop` gets
 * `graceMs` to finish; if it hangs, the process exits anyway so the daemon can
 * start a replacement that replays whatever was left pending.
 */
export function installSenseShutdown(options: SenseShutdownOptions): () => void {
  const target = options.process ?? process
  const graceMs = options.graceMs ?? SENSE_SHUTDOWN_GRACE_MS

  const onSignal = (signal: NodeJS.Signals): void => {
    uninstall()
    emitNervesEvent({
      component: "senses",
      event: "senses.shutdown_started",
      message: "sense shutting down",
      meta: { sense: options.sense, signal, graceMs },
    })
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const graceExpired = new Promise<"grace_expired">((resolve) => {
      graceTimer = setTimeout(() => resolve("grace_expired"), graceMs)
    })
    const stopped = Promise.resolve()
      .then(options.stop)
      .then(() => "stopped" as const, (error: unknown) => {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.shutdown_error",
          message: "sense stop failed during shutdown",
          meta: { sense: options.sense, error: error instanceof Error ? error.message : String(error) },
        })
        return "stop_failed" as const
      })
    void Promise.race([stopped, graceExpired]).then((result) => {
      clearTimeout(graceTimer)
      if (result === "grace_expired") {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.shutdown_grace_expired",
          message: "sense did not stop within its shutdown grace period; exiting anyway",
          meta: { sense: options.sense, graceMs },
        })
      } else {
        emitNervesEvent({
          component: "senses",
          event: "senses.shutdown_complete",
          message: "sense stopped",
          meta: { sense: options.sense, result },
        })
      }
      target.exit(result === "stopped" ? 0 : 1)
    })
  }

  function uninstall(): void {
    target.removeListener("SIGTERM", onSignal)
    target.removeListener("SIGINT", onSignal)
  }

  target.once("SIGTERM", onSignal)
  target.once("SIGINT", onSignal)
  return uninstall
}
