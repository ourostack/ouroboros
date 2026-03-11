import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  createLogger,
  createNdjsonFileSink,
  createTerminalSink,
  type LogLevel,
  type LogSink,
} from "../../nerves"
import { emitNervesEvent, setRuntimeLogger } from "../../nerves/runtime"

export type RuntimeSink = "terminal" | "ndjson"

export interface RuntimeLoggingConfig {
  level: LogLevel
  sinks: RuntimeSink[]
}

export interface ConfigureDaemonRuntimeLoggerOptions {
  homeDir?: string
  configPath?: string
}

type RuntimeProcessName = "daemon" | "ouro" | "ouro-bot" | "bluebubbles"

const DEFAULT_RUNTIME_LOGGING: RuntimeLoggingConfig = {
  level: "info",
  sinks: ["terminal", "ndjson"],
}

function defaultLevelForProcess(processName: RuntimeProcessName): LogLevel {
  return processName === "daemon" ? "info" : "warn"
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function resolveRuntimeLoggingConfig(configPath: string, processName: RuntimeProcessName): RuntimeLoggingConfig {
  const defaultLevel = defaultLevelForProcess(processName)
  let parsed: unknown = null
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_RUNTIME_LOGGING, level: defaultLevel }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_RUNTIME_LOGGING, level: defaultLevel }
  }

  const candidate = parsed as { level?: unknown; sinks?: unknown }
  const level = isLogLevel(candidate.level) ? candidate.level : defaultLevel
  const sinks = Array.isArray(candidate.sinks)
    ? candidate.sinks.filter((entry): entry is RuntimeSink => entry === "terminal" || entry === "ndjson")
    : DEFAULT_RUNTIME_LOGGING.sinks

  return {
    level,
    sinks: sinks.length > 0 ? [...new Set(sinks)] : [...DEFAULT_RUNTIME_LOGGING.sinks],
  }
}

export function configureDaemonRuntimeLogger(
  processName: RuntimeProcessName,
  options: ConfigureDaemonRuntimeLoggerOptions = {},
): void {
  const homeDir = options.homeDir ?? os.homedir()
  const configPath = options.configPath ?? path.join(homeDir, ".agentstate", "daemon", "logging.json")
  const config = resolveRuntimeLoggingConfig(configPath, processName)

  const sinks: LogSink[] = config.sinks.map((sinkName) => {
    if (sinkName === "terminal") {
      return createTerminalSink()
    }
    const ndjsonPath = path.join(homeDir, ".agentstate", "daemon", "logs", `${processName}.ndjson`)
    return createNdjsonFileSink(ndjsonPath)
  })

  const logger = createLogger({
    level: config.level,
    sinks,
  })
  setRuntimeLogger(logger)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_logger_configured",
    message: "configured daemon runtime logger",
    meta: {
      processName,
      level: config.level,
      sinks: config.sinks,
      configPath,
    },
  })
}
