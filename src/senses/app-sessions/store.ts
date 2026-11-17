import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { AppSessionsSnapshot } from "./client"

/**
 * What the app-sessions sense keeps in the agent's bundle, under `state/senses/app-sessions/`: the last snapshot
 * (for the prompt and health), and the sessions the agent is watching (a new reply there comes back to it).
 */
export interface WatchEntry {
  name: string | null
  /** Watching ends after the first finished reply, not a day after the last message. */
  once?: boolean
  /** The time (ISO) after which an assistant message is a new reply; later replies are read from this on. */
  after: string
  /** Watching ends after this time (epoch ms) unless the agent writes to the session again. */
  until: number
}

/** A session waiting on a permission prompt or repository-trust decision that only the person can answer in the app. */
export interface WaitingPrompt {
  session: string
  name: string
  /** The app's permission request id, or the repository-trust decision id. */
  requestId: string
  what: string
  /** When the prompt opened (epoch ms): the app's event time, else the first snapshot that saw it. */
  since: number
}

export interface SenseSnapshot extends AppSessionsSnapshot {
  stuck: Array<{ id: string; name: string }>
  /** Absent in a snapshot written before this field existed. */
  waitingPrompts?: WaitingPrompt[]
  error?: string
}

/** How long a watch lasts after the agent last wrote to the session. */
export const WATCH_MS = 24 * 3_600_000
/** A snapshot older than this is shown as stale. */
export const SNAPSHOT_STALE_MS = 5 * 60_000

export function appSessionsStateDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "senses", "app-sessions")
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = `${file}.${process.pid}.next`
  fs.writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(next, file)
}

const watchFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "watch.json")
const snapshotFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "snapshot.json")

export function readWatches(agentRoot: string): Record<string, WatchEntry> {
  return readJson<Record<string, WatchEntry>>(watchFile(agentRoot), {})
}

/** Start (or extend) watching a session for assistant messages after `after` (ISO); the earlier cursor is kept. */
export function watchSession(agentRoot: string, id: string, name: string | null, after: string, now: number, once = false): WatchEntry {
  const watches = readWatches(agentRoot)
  const current = watches[id]
  const entry: WatchEntry = { name: name ?? current?.name ?? null, after: current && Date.parse(current.after) < Date.parse(after) ? current.after : after, until: now + WATCH_MS, ...(once && (current?.once ?? true) ? { once: true } : {}) }
  watches[id] = entry
  writeJson(watchFile(agentRoot), watches)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_watch", message: "watching a Copilot app session for replies", meta: { session: id } })
  return entry
}

export function unwatchSession(agentRoot: string, id: string): boolean {
  const watches = readWatches(agentRoot)
  if (!watches[id]) return false
  delete watches[id]
  writeJson(watchFile(agentRoot), watches)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_unwatch", message: "stopped watching a Copilot app session", meta: { session: id } })
  return true
}

/**
 * Apply the loop's progress to the watch file as it is now, so a watch a tool added meanwhile survives: cursors only move
 * forward, and expired watches go.
 */
export function updateWatches(agentRoot: string, afters: Record<string, string>, now: number, observations: Record<string, { name?: string }> = {}): void {
  const watches = readWatches(agentRoot)
  for (const [id, entry] of Object.entries(watches)) {
    if (entry.until <= now) {
      delete watches[id]
      continue
    }
    const after = afters[id]
    if (after !== undefined && Date.parse(after) > Date.parse(entry.after)) entry.after = after
    const observation = observations[id]
    if (observation?.name !== undefined) entry.name = observation.name
  }
  writeJson(watchFile(agentRoot), watches)
}

export function writeSnapshot(agentRoot: string, snapshot: SenseSnapshot): void {
  writeJson(snapshotFile(agentRoot), snapshot)
}

export function readSnapshot(agentRoot: string): SenseSnapshot | null {
  return readJson<SenseSnapshot | null>(snapshotFile(agentRoot), null)
}

/** One line for the prompt and health: counts, stuck sessions, and how fresh the picture is. */
export function snapshotSummary(snapshot: SenseSnapshot | null, now: number): string {
  if (!snapshot) return "no snapshot yet"
  const age = now - Date.parse(snapshot.at)
  const when = `as of ${snapshot.at}${age > SNAPSHOT_STALE_MS ? " (stale)" : ""}`
  if (snapshot.error) return `could not read the Copilot app: ${snapshot.error}, ${when}`
  const { working, waiting, stuck, idle } = snapshot.counts
  const stuckList = snapshot.stuck.length ? `; stuck: ${snapshot.stuck.slice(0, 8).map(row => `${row.id} (${row.name})`).join(", ")}${snapshot.stuck.length > 8 ? ` and ${snapshot.stuck.length - 8} more` : ""}` : ""
  return `${snapshot.appRunning ? "" : "app not running; "}${working} working, ${waiting} waiting, ${stuck} stuck, ${idle} idle${stuckList}, ${when}`
}

/** The prompt's sense row: disabled, or ready with what the last snapshot saw. */
export function appSessionsSenseStatus(enabled: boolean, agentRoot: string, now: number): string {
  if (!enabled) return "disabled"
  return `ready (${snapshotSummary(readSnapshot(agentRoot), now)}; app_sessions_* tools read and write them)`
}

/**
 * `oversize-idle`, `memory-pressure` and `finished` are archives the size watch and retirement made before Shepherd took
 * them over, kept so the digest can still show them; `handed-off` is a session whose successor took over. `note` says where it left off.
 */
export interface ArchiveLogEntry { id: string; name: string; at: string; reason: "handed-off" | "finished" | "owner-asked" | "oversize-idle" | "memory-pressure"; note?: string }
const archiveLogFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "archive-log.json")

export function readArchiveLog(agentRoot: string): ArchiveLogEntry[] {
  return readJson<ArchiveLogEntry[]>(archiveLogFile(agentRoot), [])
}

/** Sessions archived that this agent did not create; the digest shows the recent ones. */
export function addArchiveLog(agentRoot: string, entry: ArchiveLogEntry): void {
  writeJson(archiveLogFile(agentRoot), [...readArchiveLog(agentRoot), entry].slice(-50))
}
