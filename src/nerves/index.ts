import { appendFile, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { dirname } from "path"
import { randomUUID } from "crypto"
import * as zlib from "zlib"
// NOTE: runtime.ts imports `createLogger` and `ensureTraceId` from this file.
// The cycle is safe in CommonJS because runtime.ts only uses those values
// lazily inside `getRuntimeLogger()`, and we only call `emitNervesEvent` from
// inside `rotateIfNeeded` — never at module top level.
import { emitNervesEvent } from "./runtime"
import { redactLogEntry, redactString } from "./redact"

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
  write: (chunk: string) => unknown = (chunk) => { try { process.stderr.write(chunk) } catch { /* EPIPE: daemon detached, no terminal */ } },
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

export function createStderrSink(write?: (chunk: string) => unknown): LogSink {
  return createTerminalSink(write)
}

export const DEFAULT_MAX_LOG_SIZE_BYTES = 25 * 1024 * 1024 // 25 MB per active stream
export const DEFAULT_MAX_GENERATIONS = 5 // keep 5 gzipped historical generations
const DEFAULT_ROTATION_CHECK_INTERVAL_BYTES = 1024 * 1024 // ~1MB between stat checks

export interface RotateOptions {
  /** Threshold in bytes that triggers a rotation. Default: 25 MB. */
  maxSizeBytes?: number
  /** How many historical generations to keep. Default: 5. */
  maxGenerations?: number
  /** Gzip rotated generations on disk. Default: true. */
  compress?: boolean
}

export interface NdjsonSinkOptions extends RotateOptions {
  /**
   * How many bytes to queue up before the sink stat-checks the active file
   * for rotation. Defaults to 1 MB to amortize stat cost over many writes.
   * Tests set this to a tiny value (a few bytes) to exercise the rotation
   * trigger path without having to write 1 MB of fixture data.
   */
  rotationCheckIntervalBytes?: number
}

/** Internal: compute the gzipped generation path for a given ndjson file. */
function generationGzPath(base: string, ext: string, n: number): string {
  return ext === ".ndjson" ? `${base}.${n}.ndjson.gz` : `${base}.${n}.gz`
}

/** Internal: compute the legacy uncompressed generation path for a given file. */
function generationPlainPath(base: string, ext: string, n: number): string {
  return ext === ".ndjson" ? `${base}.${n}.ndjson` : `${base}.${n}`
}

/**
 * Rotate a log file in place.
 *
 * Scheme (25 MB × 5 gzipped generations by default):
 *   active       : foo.ndjson
 *   newest gen   : foo.1.ndjson.gz
 *   oldest gen   : foo.5.ndjson.gz (dropped on next rotation)
 *
 * Legacy tolerance: uncompressed `foo.1.ndjson` / `foo.2.ndjson` files from the
 * old scheme are treated as the corresponding generation and gzipped on first
 * rotation.
 *
 * Concurrent-writer safety: the active file is renamed (inode stays alive for
 * any open writer fd) then gzipped at the renamed path. An active writer
 * continues writing to its original fd; on the next write cycle it sees the
 * old path is missing and creates a fresh file.
 *
 * Backwards-compatible signature: passing a `number` as the second argument
 * (the old API) is still accepted and interpreted as `maxSizeBytes`.
 */
export function rotateIfNeeded(
  filePath: string,
  optionsOrMaxSize?: RotateOptions | number,
): boolean {
  const options: RotateOptions =
    typeof optionsOrMaxSize === "number"
      ? { maxSizeBytes: optionsOrMaxSize }
      : optionsOrMaxSize ?? {}
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES
  const maxGenerations = options.maxGenerations ?? DEFAULT_MAX_GENERATIONS
  const compress = options.compress ?? true

  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return false
  }

  if (size < maxSizeBytes) return false

  const ext = filePath.endsWith(".ndjson") ? ".ndjson" : ""
  const base = ext ? filePath.slice(0, -ext.length) : filePath
  const traceId = randomUUID()

  emitNervesEvent({
    component: "nerves",
    event: "nerves.rotation_start",
    trace_id: traceId,
    message: "rotating log file",
    meta: { path: filePath, currentSize: size, threshold: maxSizeBytes, generation: 1 },
  })

  let completed = false
  try {
    // Step 1: drop / shift existing generations starting from the oldest.
    // For each slot N (maxGenerations..2), find whatever occupies slot (N-1)
    // (as .gz or legacy uncompressed) and move it to slot N. Slot N occupants
    // get overwritten (oldest is dropped). Non-existent slots are skipped.
    for (let n = maxGenerations; n >= 2; n--) {
      const destGz = generationGzPath(base, ext, n)
      const srcGz = generationGzPath(base, ext, n - 1)
      const srcPlain = generationPlainPath(base, ext, n - 1)

      // Drop whatever currently occupies the destination slot (oldest generation).
      if (existsSync(destGz)) {
        unlinkSync(destGz)
      }
      const destPlain = generationPlainPath(base, ext, n)
      if (existsSync(destPlain)) {
        unlinkSync(destPlain)
      }

      // Prefer moving .gz → .gz (cheap rename).
      if (existsSync(srcGz)) {
        renameSync(srcGz, destGz)
        continue
      }

      // Legacy migration: if a plain .ndjson generation file exists from the
      // old scheme, read it, gzip it into the destination slot, and delete
      // the plain source.
      if (existsSync(srcPlain)) {
        if (compress) {
          const buf = readFileSync(srcPlain)
          const compressed = zlib.gzipSync(buf)
          writeFileSync(destGz, compressed)
          unlinkSync(srcPlain)
        } else {
          // compress=false: just rename
          renameSync(srcPlain, destPlain)
        }
      }
    }

    // Step 2: rename the active file to the generation-1 plain path. The
    // active writer keeps its open fd; the file path now points elsewhere.
    const plain1 = generationPlainPath(base, ext, 1)
    // If a stale .1 plain path exists (e.g. a previous compress=false run),
    // remove it so the rename can claim the slot cleanly.
    if (existsSync(plain1)) {
      unlinkSync(plain1)
    }
    renameSync(filePath, plain1)

    // Step 3: gzip (or keep plain) the renamed file into the .1 generation.
    if (compress) {
      const gz1 = generationGzPath(base, ext, 1)
      // Remove any lingering .1.ndjson.gz to avoid "file exists" on write.
      if (existsSync(gz1)) {
        unlinkSync(gz1)
      }
      const buf = readFileSync(plain1)
      const compressed = zlib.gzipSync(buf)
      writeFileSync(gz1, compressed)
      unlinkSync(plain1)
    }

    completed = true
    emitNervesEvent({
      component: "nerves",
      event: "nerves.rotation_end",
      trace_id: traceId,
      message: "log rotation complete",
      meta: { path: filePath, compressedPath: compress ? generationGzPath(base, ext, 1) : plain1, bytesFreed: size },
    })
    return true
  } catch (err) {
    /* v8 ignore next -- defensive: completed=true only reached after the try block's return @preserve */
    if (!completed) {
      /* v8 ignore next -- defensive: fs ops throw real Errors @preserve */
      const reason = err instanceof Error ? err.message : String(err)
      emitNervesEvent({
        component: "nerves",
        event: "nerves.rotation_error",
        trace_id: traceId,
        level: "error",
        message: "log rotation failed",
        meta: { path: filePath, error: reason },
      })
    }
    throw err
  }
}

export function createNdjsonFileSink(
  filePath: string,
  optionsOrMaxSize?: NdjsonSinkOptions | number,
): LogSink {
  mkdirSync(dirname(filePath), { recursive: true })
  const options: NdjsonSinkOptions =
    typeof optionsOrMaxSize === "number"
      ? { maxSizeBytes: optionsOrMaxSize }
      : optionsOrMaxSize ?? {}
  const rotationCheckInterval = options.rotationCheckIntervalBytes ?? DEFAULT_ROTATION_CHECK_INTERVAL_BYTES
  const verbose = process.env.OURO_LOG_VERBOSE === "1"
  const queue: string[] = []
  let flushing = false
  let bytesSinceCheck = 0

  function flush(): void {
    if (flushing || queue.length === 0) return
    flushing = true
    const line = queue.shift() as string

    if (bytesSinceCheck >= rotationCheckInterval) {
      bytesSinceCheck = 0
      try {
        rotateIfNeeded(filePath, options)
      } catch {
        // Rotation errors are surfaced via nerves events; never block writes.
      }
    }

    appendFile(filePath, line, "utf8", () => {
      flushing = false
      flush()
    })
  }

  return (entry: LogEvent): void => {
    const line = verbose
      ? `${JSON.stringify(entry)}\n`
      : `${redactString(JSON.stringify(redactLogEntry(entry)))}\n`
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
