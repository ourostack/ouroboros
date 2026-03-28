import { appendFile, mkdirSync, renameSync, statSync, unlinkSync } from "fs"
import { dirname } from "path"
import { randomUUID } from "crypto"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEventInput {
  event: string
  trace_id: string
  component: string
  message: string
  meta: Record<string, unknown>
}

export interface LogEvent extends LogEventInput {
  ts: string
  level: LogLevel
}

export type LogSink = (entry: LogEvent) => void

export interface Logger {
  debug(entry: LogEventInput): void
  info(entry: LogEventInput): void
  warn(entry: LogEventInput): void
  error(entry: LogEventInput): void
}

export interface LoggerOptions {
  level?: LogLevel
  sinks?: LogSink[]
  now?: () => Date
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}
const GLOBAL_SINKS_KEY = Symbol.for("ouroboros.nerves.global-sinks")

function resolveGlobalSinks(): Set<LogSink> {
  const scope = globalThis as Record<PropertyKey, unknown>
  const existing = scope[GLOBAL_SINKS_KEY]
  if (existing instanceof Set) {
    return existing as Set<LogSink>
  }

  const created = new Set<LogSink>()
  scope[GLOBAL_SINKS_KEY] = created
  return created
}

const globalSinks = resolveGlobalSinks()

function shouldEmit(configuredLevel: LogLevel, eventLevel: LogLevel): boolean {
  return LEVEL_PRIORITY[eventLevel] >= LEVEL_PRIORITY[configuredLevel]
}

export function createTraceId(): string {
  return randomUUID()
}

export function ensureTraceId(traceId?: string): string {
  return traceId && traceId.trim() ? traceId : createTraceId()
}

export function createFanoutSink(sinks: LogSink[]): LogSink {
  return (entry: LogEvent): void => {
    for (const sink of sinks) {
      try {
        sink(entry)
      } catch {
        // Fanout must stay resilient: one sink failure cannot block others.
      }
    }
  }
}

function formatTerminalTime(ts: string): string {
  const parsed = new Date(ts)
  if (Number.isNaN(parsed.getTime())) {
    return ts
  }
  return parsed.toISOString().slice(11, 19)
}

function formatTerminalMeta(meta: Record<string, unknown>): string {
  if (Object.keys(meta).length === 0) return ""
  return ` ${JSON.stringify(meta)}`
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
}

export function formatTerminalEntry(entry: LogEvent): string {
  const level = entry.level.toUpperCase()
  return `${formatTerminalTime(entry.ts)} ${level} [${entry.component}] ${entry.message}${formatTerminalMeta(entry.meta)}`
}

// Spinner coordination: the CLI sense registers these so log output
// doesn't interleave with the active spinner animation.
let _pauseSpinner: (() => void) | null = null
let _resumeSpinner: (() => void) | null = null
export function registerSpinnerHooks(pause: () => void, resume: () => void): void {
  _pauseSpinner = pause
  _resumeSpinner = resume
}

export function createTerminalSink(
  write: (chunk: string) => unknown = (chunk) => process.stderr.write(chunk),
  colorize = true,
): LogSink {
  return (entry: LogEvent): void => {
    _pauseSpinner?.()
    const line = formatTerminalEntry(entry)
    if (!colorize) {
      write(`${line}\n`)
      _resumeSpinner?.()
      return
    }
    const prefix = LEVEL_COLORS[entry.level]
    write(`${prefix}${line}\x1b[0m\n`)
    _resumeSpinner?.()
  }
}

export function createStderrSink(write: (chunk: string) => unknown = (chunk) => process.stderr.write(chunk)): LogSink {
  return createTerminalSink(write)
}

const DEFAULT_MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024 // 50MB
const ROTATION_CHECK_INTERVAL_BYTES = 1024 * 1024 // ~1MB between stat checks

/**
 * Rotate a log file: shift .1 -> .2, delete old .2, rename current -> .1.
 * Uses the ndjson extension pattern: file.ndjson -> file.1.ndjson -> file.2.ndjson
 */
export function rotateIfNeeded(filePath: string, maxSizeBytes: number): boolean {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return false
  }

  if (size < maxSizeBytes) return false

  const ext = filePath.endsWith(".ndjson") ? ".ndjson" : ""
  const base = ext ? filePath.slice(0, -ext.length) : filePath
  const file1 = `${base}.1${ext}`
  const file2 = `${base}.2${ext}`

  try { unlinkSync(file2) } catch { /* may not exist */ }
  try { renameSync(file1, file2) } catch { /* may not exist */ }
  try { renameSync(filePath, file1) } catch { /* best effort */ }

  return true
}

export function createNdjsonFileSink(filePath: string, maxSizeBytes?: number): LogSink {
  mkdirSync(dirname(filePath), { recursive: true })
  const queue: string[] = []
  let flushing = false
  let bytesSinceCheck = 0
  const maxSize = maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES

  function flush(): void {
    if (flushing || queue.length === 0) return
    flushing = true
    const line = queue.shift() as string

    /* v8 ignore start — rotation triggers only after ~1MB of writes @preserve */
    if (bytesSinceCheck >= ROTATION_CHECK_INTERVAL_BYTES) {
      bytesSinceCheck = 0
      rotateIfNeeded(filePath, maxSize)
    }
    /* v8 ignore stop */

    appendFile(filePath, line, "utf8", () => {
      flushing = false
      flush()
    })
  }

  return (entry: LogEvent): void => {
    const line = `${JSON.stringify(entry)}\n`
    bytesSinceCheck += line.length
    queue.push(line)
    flush()
  }
}

export function registerGlobalLogSink(sink: LogSink): () => void {
  globalSinks.add(sink)
  return () => {
    globalSinks.delete(sink)
  }
}

function emitToGlobalSinks(entry: LogEvent): void {
  for (const sink of globalSinks) {
    try {
      sink(entry)
    } catch {
      // Never fail runtime logging if an auxiliary sink errors.
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const configuredLevel = options.level ?? "info"
  const sinks = options.sinks ?? [createStderrSink()]
  const sink = createFanoutSink(sinks)
  const now = options.now ?? (() => new Date())

  function emit(level: LogLevel, entry: LogEventInput): void {
    if (!shouldEmit(configuredLevel, level)) {
      return
    }

    const payload: LogEvent = {
      ts: now().toISOString(),
      level,
      event: entry.event,
      trace_id: entry.trace_id,
      component: entry.component,
      message: entry.message,
      meta: entry.meta,
    }

    sink(payload)
    emitToGlobalSinks(payload)
  }

  return {
    debug: (entry: LogEventInput) => emit("debug", entry),
    info: (entry: LogEventInput) => emit("info", entry),
    warn: (entry: LogEventInput) => emit("warn", entry),
    error: (entry: LogEventInput) => emit("error", entry),
  }
}
