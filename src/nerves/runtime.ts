import { createLogger, ensureTraceId } from "./index"
import type { LogLevel, Logger, LogEventInput } from "./index"

export interface NervesEvent {
  level?: LogLevel
  event: string
  trace_id?: string
  component: string
  message: string
  meta?: Record<string, unknown>
}

let runtimeLogger: Logger | null = null

function getRuntimeLogger(): Logger {
  if (!runtimeLogger) {
    // Default logger has no sinks — events emitted before the real logger is
    // configured (e.g. identity resolution during startup) are silently dropped.
    // This prevents INFO lines from leaking to stderr and interleaving with
    // the CLI spinner when the ouro subprocess hasn't configured its logger yet.
    runtimeLogger = createLogger({ level: "info", sinks: [] })
  }
  return runtimeLogger
}

export function setRuntimeLogger(logger: Logger | null): void {
  runtimeLogger = logger
}

export function emitNervesEvent(event: NervesEvent): void {
  const logger = getRuntimeLogger()
  const payload: LogEventInput = {
    event: event.event,
    trace_id: ensureTraceId(event.trace_id),
    component: event.component,
    message: event.message,
    meta: event.meta ?? {},
  }

  const level = event.level ?? "info"
  if (level === "debug") {
    logger.debug(payload)
  } else if (level === "warn") {
    logger.warn(payload)
  } else if (level === "error") {
    logger.error(payload)
  } else {
    logger.info(payload)
  }
}
