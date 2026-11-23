/**
 * One Watch run over a live agent's logs: read only the lines each nerves log gained since the last run, keep each
 * `engine.turn_summary` as a private row, and return counts a day by channel.
 *
 * Watch reads logs and nothing else. It never opens a session file, sends nothing, starts no process and makes no
 * model call. All its writes go through the guarded file access into its private folder: `cursor.json` (byte offsets,
 * keyed by a salted hash of each log's path), `rows.ndjson` and `salt`. It reads a log in parts of at most `maxBytes`,
 * checks its CPU before each part, stops after `cpuBudgetMs` of CPU and picks up where it stopped on the next run.
 * A log it can't read is counted by error code and skipped; no path or message reaches the report. A failed or refused
 * write to its private folder stops the run with an error.
 */
import crypto from "node:crypto"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { GuardedFs } from "./guarded-fs"
import { readNewLines, type FileCursor } from "./log-reader"
import { dailyCounts, rowFromLine, type DailyCounts, type WatchRow } from "./rows"

export interface WatchOptions {
  agentRoot: string
  gfs: GuardedFs
  /** CPU a run may use. Default 30 s. */
  cpuBudgetMs?: number
  cpuUsedMs?: () => number
  /** Most bytes of one log read between CPU checks. */
  maxBytes?: number
}

export interface WatchReport {
  filesRead: number
  newTurns: number
  rejected: { parse: number; schema: number }
  gaps: number
  /** Logs that couldn't be read, by error code. */
  unreadable: Record<string, number>
  stoppedEarly: boolean
  bundleCommitKnown: boolean
  days: DailyCounts
}

const COMMIT = /^[0-9a-f]{40}$/

/** The bundle's checked-out commit, read from `.git` without running git; `unknown` if it can't be read. */
export function readBundleCommit(gfs: GuardedFs, agentRoot: string): string {
  const git = path.join(agentRoot, ".git")
  const text = (file: string): string => gfs.readWhole(file)?.toString("utf8") ?? ""
  const head = text(path.join(git, "HEAD")).trim()
  if (COMMIT.test(head)) return head
  const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1]
  if (!ref || ref.split("/").includes("..")) return "unknown"
  const loose = text(path.join(git, ref)).trim()
  if (COMMIT.test(loose)) return loose
  for (const line of text(path.join(git, "packed-refs")).split("\n")) {
    const [sha, name] = line.split(" ")
    if (name === ref && COMMIT.test(sha)) return sha
  }
  return "unknown"
}

/**
 * Every nerves log of the agent, by its active name: the daemon's process logs and each sense's runtime log. A log
 * that has just rotated may have only its generation 1 for now, so that names it too.
 */
function activeLogs(gfs: GuardedFs, agentRoot: string): string[] {
  const daemonLogs = path.join(agentRoot, "state", "daemon", "logs")
  const senseLogs = path.join(agentRoot, "state", "logs")
  const activeNames = (dir: string): string[] => {
    const names = new Set<string>()
    for (const name of gfs.list(dir)) {
      const generationOne = /^(.+)\.1\.ndjson(\.gz)?$/.exec(name)
      if (generationOne) names.add(`${generationOne[1]}.ndjson`)
      else if (name.endsWith(".ndjson") && !/\.\d+\.ndjson$/.test(name)) names.add(name)
    }
    return [...names].sort().map((name) => path.join(dir, name))
  }
  return [daemonLogs, ...gfs.list(senseLogs).map((dir) => path.join(senseLogs, dir))].flatMap(activeNames)
}

function loadSalt(gfs: GuardedFs): string {
  const existing = gfs.readPrivate("salt")
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing
  const salt = crypto.randomBytes(32).toString("hex")
  gfs.writePrivate("salt", salt)
  return salt
}

function loadCursors(gfs: GuardedFs): Record<string, FileCursor> {
  try {
    const parsed = JSON.parse(gfs.readPrivate("cursor.json") ?? "{}") as unknown
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, FileCursor> : {}
  } catch {
    return {}
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "other"
}

export function runWatch(options: WatchOptions): WatchReport {
  const { gfs, agentRoot } = options
  const cpuBudgetMs = options.cpuBudgetMs ?? 30_000
  const cpuUsedMs = options.cpuUsedMs ?? (() => {
    const usage = process.cpuUsage()
    return (usage.user + usage.system) / 1000
  })
  const cpuAtStart = cpuUsedMs()
  const salt = loadSalt(gfs)
  const cursors = loadCursors(gfs)
  const bundleCommitAtWatch = readBundleCommit(gfs, agentRoot)
  const report: WatchReport = {
    filesRead: 0, newTurns: 0, rejected: { parse: 0, schema: 0 }, gaps: 0, unreadable: {}, stoppedEarly: false,
    bundleCommitKnown: bundleCommitAtWatch !== "unknown", days: {},
  }
  const rows: WatchRow[] = []
  let parts = 0
  const outOfCpu = (): boolean => parts > 0 && cpuUsedMs() - cpuAtStart >= cpuBudgetMs

  /** Reads one part of `file` and saves its rows and cursor: `more`, `done`, or `unreadable` (counted by code). */
  const readPart = (file: string, key: string): "more" | "done" | "unreadable" => {
    let result: ReturnType<typeof readNewLines>
    try {
      result = readNewLines(gfs, file, cursors[key], options.maxBytes)
    } catch (error) {
      const code = errorCode(error)
      report.unreadable[code] = (report.unreadable[code] ?? 0) + 1
      return "unreadable"
    }
    parts += 1
    const fileRows: WatchRow[] = []
    for (const line of result.lines) {
      const parsed = rowFromLine(line, { salt, bundleCommitAtWatch })
      if (parsed.kind === "row") fileRows.push(parsed.row)
      else if (parsed.kind === "rejected") report.rejected[parsed.reason] += 1
    }
    // Rows first, then the cursor: a crash in between counts these turns again rather than losing them.
    if (fileRows.length > 0) gfs.appendPrivate("rows.ndjson", fileRows.map((row) => `${JSON.stringify(row)}\n`).join(""))
    if (result.cursor) cursors[key] = result.cursor
    else delete cursors[key]
    gfs.writePrivate("cursor.json", JSON.stringify(cursors))
    rows.push(...fileRows)
    if (result.gap) report.gaps += 1
    return result.more ? "more" : "done"
  }

  files: for (const file of activeLogs(gfs, agentRoot)) {
    const key = crypto.createHash("sha256").update(salt).update(path.relative(agentRoot, file)).digest("hex").slice(0, 32)
    // Only reading a log is allowed to fail and be counted; a refused or failed private write stops the run.
    let state: ReturnType<typeof readPart> = "more"
    while (state === "more") {
      if (outOfCpu()) {
        report.stoppedEarly = true
        break files
      }
      state = readPart(file, key)
    }
    if (state === "done") report.filesRead += 1
  }

  report.newTurns = rows.length
  report.days = dailyCounts(rows)
  emitNervesEvent({
    component: "eval",
    event: "eval.watch_run",
    message: "Watch read an agent's logs",
    meta: { filesRead: report.filesRead, newTurns: report.newTurns, gaps: report.gaps, stoppedEarly: report.stoppedEarly },
  })
  return report
}
