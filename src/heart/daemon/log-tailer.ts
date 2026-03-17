import * as path from "path"
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

export function discoverLogFiles(options: Pick<TailLogsOptions, "homeDir" | "agentName" | "existsSync" | "readdirSync" | "agentFilter">): string[] {
  /* v8 ignore start -- integration: default DI stubs for real OS @preserve */
  const existsSync = options.existsSync ?? (() => false)
  const readdirSync = options.readdirSync ?? (() => [])
  /* v8 ignore stop */

  const logDir = options.homeDir
    ? path.join(options.homeDir, "AgentBundles", `${options.agentName ?? "slugger"}.ouro`, "state", "daemon", "logs")
    : getAgentDaemonLogsDir(options.agentName)
  const files: string[] = []

  if (existsSync(logDir)) {
    for (const name of readdirSync(logDir)) {
      if (!name.endsWith(".ndjson")) continue
      if (options.agentFilter && !name.includes(options.agentFilter)) continue
      files.push(path.join(logDir, name))
    }
  }

  return files.sort()
}

export function readLastLines(filePath: string, count: number, readFileSync: (target: string, encoding: "utf-8") => string): string[] {
  let content: string
  try {
    content = readFileSync(filePath, "utf-8")
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

  // Read initial lines
  for (const file of files) {
    const lines = readLastLines(file, lineCount, readFileSync)
    for (const line of lines) {
      writer(`${formatLogLine(line)}\n`)
    }
    try {
      const content = readFileSync(file, "utf-8")
      fileSizes.set(file, content.length)
    } catch {
      fileSizes.set(file, 0)
    }
  }

  // Follow mode
  if (options.follow && watchFile && unwatchFile) {
    for (const file of files) {
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
      for (const file of files) {
        unwatchFile(file)
      }
    }
  }

  return () => {}
}
