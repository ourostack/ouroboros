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

const LEGACY_SHARED_RUNTIME_LOGGING: RuntimeLoggingConfig = {
  level: "info",
  sinks: ["terminal", "ndjson"],
}

function defaultLoggingForProcess(processName: RuntimeProcessName): RuntimeLoggingConfig {
  if (processName === "ouro" || processName === "ouro-bot") {
    return {
      level: "info",
      sinks: ["ndjson"],
    }
  }

  if (processName === "bluebubbles") {
    return {
      level: "warn",
      sinks: ["terminal", "ndjson"],
    }
  }

  return { ...LEGACY_SHARED_RUNTIME_LOGGING }
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function normalizeSinks(value: unknown, fallback: RuntimeSink[]): RuntimeSink[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }
  const sinks = value.filter((entry): entry is RuntimeSink => entry === "terminal" || entry === "ndjson")
  return sinks.length > 0 ? [...new Set(sinks)] : [...fallback]
}

function isLegacySharedDefaultConfig(
  candidate: { level?: unknown; sinks?: unknown },
  normalizedLevel: LogLevel,
  normalizedSinks: RuntimeSink[],
): boolean {
  return normalizedLevel === LEGACY_SHARED_RUNTIME_LOGGING.level
    && normalizedSinks.length === LEGACY_SHARED_RUNTIME_LOGGING.sinks.length
    && LEGACY_SHARED_RUNTIME_LOGGING.sinks.every((sink) => normalizedSinks.includes(sink))
    && Object.keys(candidate).every((key) => key === "level" || key === "sinks")
}

function resolveRuntimeLoggingConfig(configPath: string, processName: RuntimeProcessName): RuntimeLoggingConfig {
  const processDefault = defaultLoggingForProcess(processName)
  let parsed: unknown = null
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    parsed = JSON.parse(raw)
  } catch {
    return { ...processDefault }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ...processDefault }
  }

  const candidate = parsed as { level?: unknown; sinks?: unknown }
  const level = isLogLevel(candidate.level) ? candidate.level : processDefault.level
  const sinks = normalizeSinks(candidate.sinks, processDefault.sinks)

  if ((processName === "ouro" || processName === "ouro-bot")
    && isLegacySharedDefaultConfig(candidate, level, sinks)) {
    return { ...processDefault }
  }

  return {
    level,
    sinks,
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
