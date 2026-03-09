import { logPath } from "../heart/config"
import { createLogger, createNdjsonFileSink, createTerminalSink, type LogLevel, type LogSink, type LogEvent } from "../nerves"
import { emitNervesEvent } from "./runtime"
import { setRuntimeLogger } from "./runtime"

const LEVEL_PRIORITY: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Wrap a sink so it only receives events at or above the given level. */
/* v8 ignore start -- internal filter plumbing, exercised via integration @preserve */
function filterSink(sink: LogSink, minLevel: LogLevel): LogSink {
  const minPriority = LEVEL_PRIORITY[minLevel] ?? 0
  return (entry: LogEvent): void => {
    if ((LEVEL_PRIORITY[entry.level] ?? 0) >= minPriority) sink(entry)
  }
}
/* v8 ignore stop */

export type CliRuntimeSink = "terminal" | "ndjson"

export interface CliRuntimeLoggerOptions {
  level?: LogLevel
  sinks?: CliRuntimeSink[]
}

function resolveCliSinks(sinks: CliRuntimeSink[] | undefined): CliRuntimeSink[] {
  const requested: CliRuntimeSink[] = sinks && sinks.length > 0 ? sinks : ["terminal", "ndjson"]
  return [...new Set(requested)]
}

export function configureCliRuntimeLogger(_friendId: string, options: CliRuntimeLoggerOptions = {}): void {
  const sinkKinds = resolveCliSinks(options.sinks)
  const level = options.level ?? "info"
  const sinks: LogSink[] = sinkKinds.map((sinkKind) => {
    if (sinkKind === "terminal") {
      // Terminal only shows warnings and errors — INFO is too noisy
      // for an interactive session. Full detail goes to the ndjson file.
      return filterSink(createTerminalSink(), "warn")
    }
    return createNdjsonFileSink(logPath("cli", "runtime"))
  })

  const logger = createLogger({
    level,
    sinks,
  })
  setRuntimeLogger(logger)
  emitNervesEvent({
    component: "senses",
    event: "senses.cli_logger_configured",
    message: "cli runtime logger configured",
    meta: { sinks: sinkKinds, level: options.level ?? "info" },
  })
}
