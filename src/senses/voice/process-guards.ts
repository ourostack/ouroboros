import { emitNervesEvent } from "../../nerves/runtime"

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

/**
 * Keep one bad call from taking the voice process down for every other caller. A failure that
 * escapes a call's own handlers is logged and the process keeps serving; it never exits here.
 */
export function installVoiceProcessGuards(proc: NodeJS.Process): void {
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
  })
}
