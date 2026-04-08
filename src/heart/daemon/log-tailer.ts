import * as path from "path"
import * as zlib from "zlib"
import { formatTerminalEntry, type LogEvent } from "../../nerves"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentDaemonLogsDir } from "../identity"

const LEVEL_COLORS: Record<string, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
}

export interface TailLogsOptions {
  follow?: boolean
  lines?: number
  agentFilter?: string
  writer?: (text: string) => void
  homeDir?: string
  agentName?: string
  existsSync?: (target: string) => boolean
  readdirSync?: (target: string) => string[]
  readFileSync?: (target: string, encoding: "utf-8") => string
  watchFile?: (target: string, listener: () => void) => void
  unwatchFile?: (target: string) => void
}

/**
 * Parse a log filename into a (streamBase, generationRank) tuple.
 *
 * - `daemon.ndjson`          → { streamBase: "daemon", rank: 0 }   (active, newest)
 * - `daemon.1.ndjson.gz`     → { streamBase: "daemon", rank: 1 }
 * - `daemon.5.ndjson.gz`     → { streamBase: "daemon", rank: 5 }   (oldest)
 * - Anything else            → null (not a log file).
 *
 * Higher rank = older. Used to sort so the oldest generation is read first
 * and the active stream is read last, producing chronological output.
 */
function parseLogFilename(name: string): { streamBase: string; rank: number } | null {
  if (name.endsWith(".ndjson.gz")) {
    // e.g. daemon.1.ndjson.gz → base "daemon.1", strip ".gz" then ".ndjson" then ".<n>"
    const withoutGz = name.slice(0, -".gz".length) // daemon.1.ndjson
    const withoutNdjson = withoutGz.slice(0, -".ndjson".length) // daemon.1
    const genMatch = withoutNdjson.match(/^(.+)\.(\d+)$/)
    if (!genMatch) return null
    return { streamBase: genMatch[1] as string, rank: parseInt(genMatch[2] as string, 10) }
  }
  if (name.endsWith(".ndjson")) {
    const withoutNdjson = name.slice(0, -".ndjson".length)
    // Active file: daemon.ndjson → base "daemon", rank 0
    // Legacy numeric gen: daemon.1.ndjson → base "daemon", rank 1 (treat same as gzipped)
    const legacyMatch = withoutNdjson.match(/^(.+)\.(\d+)$/)
    if (legacyMatch) {
      return { streamBase: legacyMatch[1] as string, rank: parseInt(legacyMatch[2] as string, 10) }
    }
    return { streamBase: withoutNdjson, rank: 0 }
  }
  return null
}

export function discoverLogFiles(options: Pick<TailLogsOptions, "homeDir" | "agentName" | "existsSync" | "readdirSync" | "agentFilter">): string[] {
  /* v8 ignore start -- integration: default DI stubs for real OS @preserve */
  const existsSync = options.existsSync ?? (() => false)
  const readdirSync = options.readdirSync ?? (() => [])
  /* v8 ignore stop */

  const logDir = options.homeDir
    ? path.join(options.homeDir, "AgentBundles", `${options.agentName ?? "slugger"}.ouro`, "state", "daemon", "logs")
    : getAgentDaemonLogsDir(options.agentName)
  const entries: Array<{ name: string; parsed: { streamBase: string; rank: number } }> = []

  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir)) {
      const parsed = parseLogFilename(name)
      if (!parsed) continue
      if (options.agentFilter && !name.includes(options.agentFilter)) continue
      entries.push({ name, parsed })
    }
  }

  // Sort chronologically: for each stream, oldest generation first, active last.
  // Across streams, sort alphabetically by streamBase so output is stable.
  entries.sort((a, b) => {
    if (a.parsed.streamBase !== b.parsed.streamBase) {
      return a.parsed.streamBase < b.parsed.streamBase ? -1 : 1
    }
    // Same stream: higher rank = older = read first.
    return b.parsed.rank - a.parsed.rank
  })

  return entries.map((e) => path.join(logDir, e.name))
}

/**
 * Read a log file as a string, transparently handling gzipped rotations.
 *
 * For `.ndjson.gz` files we read the raw bytes via `fs.readFileSync` (ignoring
 * any caller-supplied DI `readFileSync`, since that stub returns a `string`
 * and would corrupt gzip bytes) and then `zlib.gunzipSync` to recover the
 * original text. For plain `.ndjson` files we defer to the DI stub so tests
 * can keep mocking fs.
 */
function readNdjsonFileContents(
  filePath: string,
  readFileSync: (target: string, encoding: "utf-8") => string,
): string {
  if (filePath.endsWith(".gz")) {
    // Binary path: tests can mock readFileSync to return a Buffer (typed as
    // string) via `as unknown as string` — we accept both Buffer and Uint8Array.
    const raw = (readFileSync as unknown as (target: string) => Buffer | string)(filePath)
    const buf = typeof raw === "string" ? Buffer.from(raw, "binary") : Buffer.from(raw as Buffer)
    return zlib.gunzipSync(buf).toString("utf-8")
  }
  return readFileSync(filePath, "utf-8")
}

export function readLastLines(filePath: string, count: number, readFileSync: (target: string, encoding: "utf-8") => string): string[] {
  let content: string
  try {
    content = readNdjsonFileContents(filePath, readFileSync)
  } catch {
    return []
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0)
  return lines.slice(-count)
}

export function formatLogLine(ndjsonLine: string): string {
  try {
    const entry = JSON.parse(ndjsonLine) as LogEvent
    const formatted = formatTerminalEntry(entry)
    const color = LEVEL_COLORS[entry.level] ?? ""
    return `${color}${formatted}\x1b[0m`
  } catch {
    return ndjsonLine
  }
}

export function tailLogs(options: TailLogsOptions = {}): () => void {
  /* v8 ignore start -- integration: default DI stubs for real OS @preserve */
  const writer = options.writer ?? ((text: string) => process.stdout.write(text))
  const lineCount = options.lines ?? 20
  const readFileSync = options.readFileSync ?? (() => "")
  /* v8 ignore stop */
  const watchFile = options.watchFile
  const unwatchFile = options.unwatchFile

  const files = discoverLogFiles(options)
  emitNervesEvent({ component: "daemon", event: "daemon.log_tailer_started", message: "log tailer started", meta: { fileCount: files.length, follow: !!options.follow } })
  const fileSizes = new Map<string, number>()

  // Read initial lines from each discovered file (oldest gz → newest gz → active).
  // Gzipped files are historical and never tailed in follow mode.
  for (const file of files) {
    const lines = readLastLines(file, lineCount, readFileSync)
    for (const line of lines) {
      writer(`${formatLogLine(line)}\n`)
    }
    if (file.endsWith(".gz")) {
      // Historical rotation — skip size tracking, never followed.
      continue
    }
    try {
      const content = readFileSync(file, "utf-8")
      fileSizes.set(file, content.length)
    } catch {
      fileSizes.set(file, 0)
    }
  }

  // Follow mode: only the active (non-gzipped) stream is watched.
  if (options.follow && watchFile && unwatchFile) {
    const activeFiles = files.filter((f) => !f.endsWith(".gz"))
    for (const file of activeFiles) {
      watchFile(file, () => {
        let content: string
        try {
          content = readFileSync(file, "utf-8")
        } catch {
          return
        }
        /* v8 ignore next -- defensive: fileSizes always populated above @preserve */
        const prevSize = fileSizes.get(file) ?? 0
        if (content.length <= prevSize) return
        fileSizes.set(file, content.length)
        const newContent = content.slice(prevSize)
        const newLines = newContent.split("\n").filter((l) => l.trim().length > 0)
        for (const line of newLines) {
          writer(`${formatLogLine(line)}\n`)
        }
      })
    }

    return () => {
      for (const file of activeFiles) {
        unwatchFile(file)
      }
    }
  }

  return () => {}
}
