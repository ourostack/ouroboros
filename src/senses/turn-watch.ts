import * as fs from "node:fs"
import * as path from "node:path"
import type { ChannelCallbacks } from "../heart/core"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Lets status see a turn that has stopped moving, on the senses whose turns run through the shared pipeline and have
 * a status row of their own. Each running turn leaves a record under `state/senses/<sense>/turns-in-flight/`; the
 * daemon reads them and shows the sense as an error once a turn has gone quiet for too long. iMessage keeps its own
 * tracker (`bluebubbles/active-turns.ts`). Mail is not here: its messages are answered by inner turns.
 */

/** A turn with no model output or tool activity for this long counts as stalled. */
export const TURN_STALLED_AFTER_MS = 5 * 60_000
/**
 * While a tool runs, the turn is quiet until it ends. The shell and MCP tools stop a call after at most 10 minutes
 * (`tools-shell.ts`, `mcp-client.ts`), so a tool still running after 15 counts as stalled.
 */
export const TOOL_STALLED_AFTER_MS = 15 * 60_000
/**
 * Progress is written at most this often, so a streaming reply doesn't write a file per chunk. The record can be this
 * far behind, so a turn counts as stalled only this much after the limit, which keeps every stall a real one.
 */
export const PROGRESS_WRITE_EVERY_MS = 30_000

const WATCHED_SENSES = new Set(["teams", "voice", "a2a", "telegram"])

export interface TurnInFlightRecord {
  pid: number
  sessionKey: string
  startedAt: string
  lastProgressAt: string
  /** Tool calls started and not yet ended. */
  toolsRunning: number
}

export interface TurnsInFlightSnapshot {
  activeTurnCount: number
  stalledTurnCount: number
  oldestActiveTurnStartedAt?: string
  oldestActiveTurnAgeMs?: number
  /** How long the quietest stalled turn has gone without recorded progress. Set only when a turn is stalled. */
  longestSilenceMs?: number
  /** The processes running the stalled turns. Set only when a turn is stalled. */
  stalledPids?: number[]
}

export interface TurnProgress {
  /** Notes progress. Cheap to call on every chunk. */
  touch(nowMs?: number): void
  /** A tool call started: the turn may be quiet until it ends. */
  toolStarted(nowMs?: number): void
  /** A tool call ended. */
  toolEnded(nowMs?: number): void
}

export interface TurnInFlight extends TurnProgress {
  /** Removes the record. Safe to call twice. */
  finish(): void
}

/** Whether turns on this channel are watched here. iMessage has its own tracker; the CLI and inner turns have no row. */
export function isWatchedSense(channel: string): boolean {
  return WATCHED_SENSES.has(channel)
}

function turnsDir(agentRoot: string, sense: string): string {
  return path.join(agentRoot, "state", "senses", sense, "turns-in-flight")
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseRecord(raw: string): TurnInFlightRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Partial<TurnInFlightRecord>
  if (typeof record.pid !== "number" || typeof record.sessionKey !== "string" || typeof record.toolsRunning !== "number") return null
  if (!Number.isFinite(Date.parse(String(record.startedAt))) || !Number.isFinite(Date.parse(String(record.lastProgressAt)))) return null
  return record as TurnInFlightRecord
}

function readRecords(dir: string): Array<{ file: string; record: TurnInFlightRecord | null }> {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => {
    const file = path.join(dir, name)
    let raw = ""
    try {
      raw = fs.readFileSync(file, "utf-8")
    } catch {
      // Removed between listing and reading: the turn ended.
    }
    return { file, record: parseRecord(raw) }
  })
}

function reportWriteError(sense: string, action: string, error: unknown): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.turn_watch_write_error",
    message: "could not update a turn's in-flight record; status may not show this turn",
    meta: { sense, action, error: String(error) },
  })
}

/** The records of the turns this process is running now. Any other record of this pid is left from an earlier process. */
const liveTurnFiles = new Set<string>()
let turnSequence = 0

function clearLeftovers(dir: string): void {
  for (const { file, record } of readRecords(dir)) {
    if (liveTurnFiles.has(file)) continue
    if (record && record.pid !== process.pid && pidAlive(record.pid)) continue
    fs.rmSync(file, { force: true })
  }
}

/**
 * Starts recording a turn on `sense`. Never throws: a record that can't be written only means status can't see the
 * turn, which is reported once as a warning.
 */
export function beginTurnInFlight(agentRoot: string, sense: string, sessionKey: string, nowMs = Date.now()): TurnInFlight {
  const dir = turnsDir(agentRoot, sense)
  turnSequence += 1
  const file = path.join(dir, `${process.pid}-${turnSequence}.json`)
  const startedAt = new Date(nowMs).toISOString()
  let lastWrittenMs = nowMs
  let toolsRunning = 0
  let finished = false
  let failed = false

  const write = (progressMs: number): void => {
    lastWrittenMs = progressMs
    const record: TurnInFlightRecord = { pid: process.pid, sessionKey, startedAt, lastProgressAt: new Date(progressMs).toISOString(), toolsRunning }
    const tmp = `${file}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(record) + "\n", "utf-8")
      fs.renameSync(tmp, file)
    } catch (error) {
      if (!failed) reportWriteError(sense, "write", error)
      failed = true
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // The folder itself is gone or unusable; nothing was left in it.
      }
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    clearLeftovers(dir)
  } catch (error) {
    reportWriteError(sense, "prepare", error)
    failed = true
  }
  liveTurnFiles.add(file)
  write(nowMs)
  emitNervesEvent({ component: "senses", event: "senses.turn_watch_started", message: "turn started", meta: { sense, sessionKey } })

  return {
    touch(progressMs = Date.now()) {
      if (finished || progressMs - lastWrittenMs < PROGRESS_WRITE_EVERY_MS) return
      write(progressMs)
    },
    toolStarted(progressMs = Date.now()) {
      if (finished) return
      toolsRunning += 1
      write(progressMs)
    },
    toolEnded(progressMs = Date.now()) {
      if (finished) return
      toolsRunning = Math.max(0, toolsRunning - 1)
      write(progressMs)
    },
    finish() {
      if (finished) return
      finished = true
      liveTurnFiles.delete(file)
      try {
        fs.rmSync(file, { force: true })
      } catch (error) {
        reportWriteError(sense, "remove", error)
      }
      emitNervesEvent({ component: "senses", event: "senses.turn_watch_finished", message: "turn finished", meta: { sense, sessionKey } })
    },
  }
}

/**
 * What status shows about a sense's running turns. Records of processes that are gone don't count, nor records that
 * started before `notBeforeMs` (when the sense's current process started): those are left from an earlier run.
 */
export function snapshotTurnsInFlight(
  agentRoot: string,
  sense: string,
  nowMs = Date.now(),
  isAlive: (pid: number) => boolean = pidAlive,
  notBeforeMs = Number.NEGATIVE_INFINITY,
): TurnsInFlightSnapshot {
  const records = readRecords(turnsDir(agentRoot, sense))
    .map(({ record }) => record)
    .filter((record): record is TurnInFlightRecord => record !== null && Date.parse(record.startedAt) >= notBeforeMs && isAlive(record.pid))
  if (records.length === 0) return { activeTurnCount: 0, stalledTurnCount: 0 }
  const oldest = records.reduce((a, b) => (Date.parse(b.startedAt) < Date.parse(a.startedAt) ? b : a))
  const stalled = records
    .map((record) => ({ pid: record.pid, silenceMs: nowMs - Date.parse(record.lastProgressAt), limitMs: record.toolsRunning > 0 ? TOOL_STALLED_AFTER_MS : TURN_STALLED_AFTER_MS }))
    .filter((turn) => turn.silenceMs >= turn.limitMs + PROGRESS_WRITE_EVERY_MS)
  return {
    activeTurnCount: records.length,
    stalledTurnCount: stalled.length,
    oldestActiveTurnStartedAt: oldest.startedAt,
    oldestActiveTurnAgeMs: Math.max(0, nowMs - Date.parse(oldest.startedAt)),
    ...(stalled.length > 0 ? {
      longestSilenceMs: Math.max(...stalled.map((turn) => turn.silenceMs)),
      stalledPids: [...new Set(stalled.map((turn) => turn.pid))].sort((a, b) => a - b),
    } : {}),
  }
}

const PROGRESS_CALLBACKS = new Set<string | symbol>([
  "onModelStart",
  "onModelStreamStart",
  "onTextChunk",
  "onReasoningChunk",
  "onToolResult",
])

/**
 * The same callbacks, with every model or tool callback also counting as progress, and tool calls marked while they
 * run. Every other field reads and writes through to the original object, and each call runs on it.
 */
export function watchTurnCallbacks(callbacks: ChannelCallbacks, progress: TurnProgress): ChannelCallbacks {
  return new Proxy(callbacks, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown
      if (typeof value !== "function") return value
      const note = key === "onToolStart" ? () => progress.toolStarted()
        : key === "onToolEnd" ? () => progress.toolEnded()
          : PROGRESS_CALLBACKS.has(key) ? () => progress.touch()
            : null
      if (!note) return value
      return (...args: unknown[]) => {
        note()
        return (value as (...callArgs: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}
