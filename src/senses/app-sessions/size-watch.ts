import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { plain } from "../shepherd/owner-notice"
import { archiveRow, deliverMessage, type Asked } from "./app-interface"
import { eventLogPath, eventLogSize, type AppSessionRow, type AppSessionsOptions } from "./client"
import { appSessionsStateDir, readJson, writeJson, type ArchiveLogEntry } from "./store"
import type { NotifyOwner } from "./waiting-prompts"

/**
 * A session's event log is loaded whole into memory when the app resumes it, and a log of several GB (almost all of it
 * inline images) has frozen the machine. Each minute, with no model turn, every local session's `events.jsonl` is
 * measured, listed in the sidebar or not, and one over the limit is flagged never-resume. A listed one is asked to hand
 * off to a fresh successor: its coordinator, and the session itself while it runs, are asked again each time its history
 * grows by half, because one ask is easily ignored. A flagged session that then sits idle for 30 minutes (or at once,
 * when memory runs short) is archived through the app, reversibly and keeping its worktree, to free its runtime, and its
 * coordinator is told where it left off. A session that is not running and has no smaller coordinator is never messaged,
 * because the message would reload it; the owner is told instead.
 */
export const OVERSIZE_BYTES = 500 * 1024 * 1024
/** A flagged session that keeps running is asked again each time its history reaches this multiple of its size at the last ask. */
export const RENUDGE_GROWTH = 1.5
/** A flagged session idle this long after its last ask is archived. */
export const IDLE_ARCHIVE_MS = 30 * 60_000
/** Swap use above this, or free memory below the next, means the machine is short of memory: idle giants go at once. */
export const PRESSURE_SWAP_BYTES = 8 * 1024 ** 3
export const PRESSURE_FREE_BYTES = 1024 ** 3
/** How far back from the end of a log to look for where the session last pushed, in chunks. */
const PUSH_SCAN_BYTES = 64 * 1024 * 1024
const PUSH_CHUNK_BYTES = 4 * 1024 * 1024

export interface OversizeEntry {
  bytes: number
  name: string
  /** When the last ask went out (or the owner was told). */
  nudgedAt?: string
  /** The history's size at the last ask; the next waits for it to grow by `RENUDGE_GROWTH`. */
  nudgedBytes?: number
  nudges?: number
  /** Who was asked last: session ids joined by commas, or "owner". */
  to?: string
  /** Not in the sidebar (archived, or never an app session): flagged so nothing resumes it, and never messaged. */
  unlisted?: true
  archivedAt?: string
}
interface OversizeState { sessions: Record<string, OversizeEntry> }

const stateFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "oversize.json")
export const readOversize = (agentRoot: string): Record<string, OversizeEntry> => readJson<OversizeState>(stateFile(agentRoot), { sessions: {} }).sessions

/** The ids of sessions flagged never-resume: a resume path asks this before it wakes one. */
export const neverResume = (agentRoot: string): string[] => Object.keys(readOversize(agentRoot))

const mb = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`

export function handoffNudge(name: string, bytes: number, asked = 0, askedAtBytes?: number): string {
  const again = asked ? ` This is ask ${asked + 1}${askedAtBytes ? `: it was ${mb(askedAtBytes)} at the last one and is still growing` : ""}.` : ""
  return `The session "${plain(name, 60)}" has a ${mb(bytes)} history, over the ${mb(OVERSIZE_BYTES)} limit: the app loads all of it into memory every time that session resumes, and a few like it froze this Mac.${again} Please hand it off now: write a checkpoint of its purpose and open work, start a fresh successor session that reads that checkpoint plus the tail of the old log, then archive the old one. This goes to the session and to its coordinator; the coordinator starts the successor when there is one. Once it has been idle for ${IDLE_ARCHIVE_MS / 60_000} minutes it is archived for you (reversibly) to free its memory. Keep images out of chat (save screenshots and art as files and link the path): inline images are nearly all of the size.`
}

export function archivedNote(name: string, id: string, bytes: number, where: string): string {
  return `I archived the session "${plain(name, 60)}" (${id}) to free memory: its ${mb(bytes)} history is over the ${mb(OVERSIZE_BYTES)} limit and it sat idle after the hand-off ask. The archive is reversible from the app, and its worktree was kept. Where it left off: ${where}. If its work is not finished, start a fresh successor session from there and the tail of its log (~/.copilot/session-state/${id}/events.jsonl).`
}

export interface Memory { swapUsedBytes: number; freeBytes: number }

/** Swap in use and free memory: `sysctl vm.swapusage` on macOS, `/proc/meminfo` elsewhere. An unreadable swap counts as none. */
export function readMemory(platform: NodeJS.Platform = process.platform, read: (what: "swapusage" | "meminfo") => string = what => what === "swapusage"
  ? execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8", timeout: 5_000 })
  : fs.readFileSync("/proc/meminfo", "utf8")): Memory {
  let swapUsedBytes = 0
  try {
    if (platform === "darwin") swapUsedBytes = Number(/used = ([\d.]+)M/.exec(read("swapusage"))?.[1] ?? 0) * 1024 ** 2
    else {
      const info = read("meminfo")
      const kb = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0) * 1024
      swapUsedBytes = kb("SwapTotal") - kb("SwapFree")
    }
  } catch {
    swapUsedBytes = 0
  }
  return { swapUsedBytes, freeBytes: os.freemem() }
}

export const shortOfMemory = (memory: Memory): boolean => memory.swapUsedBytes > PRESSURE_SWAP_BYTES || memory.freeBytes < PRESSURE_FREE_BYTES

const sessionsRoot = (client: AppSessionsOptions): string => path.dirname(path.dirname(eventLogPath("x", client)))

/** Every local session's history size, whether or not the sidebar lists it. */
function localLogSizes(client: AppSessionsOptions): Map<string, number> {
  const sizes = new Map<string, number>()
  let names: string[]
  try {
    names = fs.readdirSync(sessionsRoot(client))
  } catch {
    return sizes
  }
  for (const name of names) sizes.set(name, eventLogSize(name, client))
  return sizes
}

/** The name the session saved for itself, for one the sidebar no longer lists. */
function savedName(id: string, client: AppSessionsOptions): string | null {
  try {
    const head = fs.readFileSync(path.join(sessionsRoot(client), id, "workspace.yaml"), "utf8").slice(0, 4096)
    return /^name: ['"]?(.*?)['"]?$/m.exec(head)?.[1] || null
  } catch {
    return null
  }
}

const last = (text: string, pattern: RegExp): string | undefined => text.match(pattern)?.at(-1)

/**
 * Where a session left off, for its coordinator: its workspace branch, and the last `git push` and pull request in the
 * end of its history (credentials in a push URL are cut). Only the last 64 MB is read, a chunk at a time.
 */
export function whereItLeftOff(row: Pick<AppSessionRow, "id" | "branch" | "projectRepo">, client: AppSessionsOptions = {}): string {
  let push: string | undefined
  let pr: string | undefined
  let fd: number | null = null
  try {
    fd = fs.openSync(eventLogPath(row.id, client), "r")
    const size = fs.fstatSync(fd).size
    for (let end = size; end > 0 && size - end < PUSH_SCAN_BYTES && !(push && pr); end -= PUSH_CHUNK_BYTES) {
      const start = Math.max(0, end - PUSH_CHUNK_BYTES - 512)
      const buffer = Buffer.alloc(end - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      const text = buffer.toString("utf8")
      push ??= last(text, /git push\b[^"\\\n]{0,200}/g)
      pr ??= last(text, /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
    }
  } catch {
    // No log: say what the sidebar knows.
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
  const parts = [
    ...(row.branch ? [`branch ${row.branch}${row.projectRepo ? ` in ${row.projectRepo}` : ""}`] : []),
    ...(push ? [`last push \`${push.split(/\s(?:2>|\||;|&&)/)[0]!.replace(/\/\/[^/@\s]*@/, "//").trim()}\``] : []),
    ...(pr ? [`last pull request ${pr}`] : []),
  ]
  return parts.length ? parts.join("; ") : "no push or pull request in the end of its history"
}

export interface SizeWatchDeps {
  notify: NotifyOwner
  now: number
  send?: (id: string, text: string) => Promise<Asked>
  archive?: (row: AppSessionRow, reason: ArchiveLogEntry["reason"], note: string) => Promise<boolean>
  memory?: () => Memory
  client: AppSessionsOptions
}

const failed = (error: Error): Asked => ({ ok: false, frame: null, error: error.message })

/** Flag every over-limit session, ask again as one grows, and archive the idle ones. Returns what this pass did. */
export async function noticeOversizedSessions(agentRoot: string, rows: AppSessionRow[], deps: SizeWatchDeps): Promise<{ nudged: number; archived: number }> {
  const client = deps.client
  const send = deps.send ?? ((id: string, text: string) => deliverMessage(id, text, "immediate", deps.client))
  const archive = deps.archive ?? (async (row: AppSessionRow, reason: ArchiveLogEntry["reason"], note: string) => (await archiveRow(agentRoot, row, reason, client, { note, keepWorktree: true })).ok === true)
  const at = new Date(deps.now).toISOString()
  const before = readOversize(agentRoot)
  const sizes = localLogSizes(client)
  const listed = new Map(rows.filter(row => !row.remote).map(row => [row.id, row]))
  const next: Record<string, OversizeEntry> = {}
  for (const [id, bytes] of sizes) {
    if (bytes <= OVERSIZE_BYTES) continue
    const { unlisted: _unlisted, ...kept } = before[id] ?? {}
    const row = listed.get(id)
    next[id] = { ...kept, bytes, name: row?.name ?? kept.name ?? savedName(id, client) ?? id, ...(row ? {} : { unlisted: true as const }) }
  }
  const big = [...listed.values()].filter(row => next[row.id])
  // A coordinator that is itself a giant is only messaged while it runs, since a message would reload it.
  const reachable = (id: string | null): AppSessionRow | undefined => {
    const row = id ? listed.get(id) : undefined
    return row && (row.isRunning || !next[row.id]) ? row : undefined
  }

  let nudged = 0
  const ownerRows: AppSessionRow[] = []
  for (const row of big) {
    const entry = next[row.id]!
    const due = row.isRunning ? entry.nudgedBytes === undefined || entry.bytes >= entry.nudgedBytes * RENUDGE_GROWTH : !entry.nudgedAt
    if (!due) continue
    const boss = reachable(row.coordinatingCreatorSessionId)
    const to = [...(boss && boss.id !== row.id ? [boss.id] : []), ...(row.isRunning ? [row.id] : [])]
    if (!to.length) {
      ownerRows.push(row)
      continue
    }
    // An entry from before asks were counted had one ask.
    const asked = entry.nudges ?? (entry.nudgedAt ? 1 : 0)
    const text = handoffNudge(row.name, entry.bytes, asked, entry.nudgedBytes)
    const reached: string[] = []
    for (const id of to) if ((await send(id, text).catch(failed)).ok) reached.push(id)
    if (!reached.length) continue
    Object.assign(entry, { nudgedAt: at, nudgedBytes: entry.bytes, nudges: asked + 1, to: reached.join(",") })
    nudged += 1
  }
  if (ownerRows.length) {
    const lines = ownerRows.map(row => `- "${plain(row.name, 60)}" (${mb(next[row.id]!.bytes)})`)
    const outcome = await deps.notify(`These sessions have histories over ${mb(OVERSIZE_BYTES)} and cannot be nudged without reloading them. They need a hand-off to a fresh successor session (checkpoint, tail, archive); keep images out of chat:\n${lines.join("\n")}`, ownerRows.map(row => `oversize:${row.id}`))
    for (const row of ownerRows) {
      next[row.id]!.to = "owner"
      if (outcome !== "pending") {
        Object.assign(next[row.id]!, { nudgedAt: at, nudgedBytes: next[row.id]!.bytes, nudges: (next[row.id]!.nudges ?? 0) + 1 })
        nudged += 1
      }
    }
  }

  const quiet = big.filter(row => !row.isRunning && row.state !== "waiting")
  const pressed = quiet.length > 0 && shortOfMemory((deps.memory ?? readMemory)())
  const idle = quiet.filter(row => {
    const entry = next[row.id]!
    if (pressed) return true
    if (!entry.nudgedAt) return false
    return deps.now - Math.max(Date.parse(entry.nudgedAt), Date.parse(row.lastActivity ?? "") || 0) >= IDLE_ARCHIVE_MS
  }).sort((a, b) => next[b.id]!.bytes - next[a.id]!.bytes)
  let archived = 0
  for (const row of idle) {
    const entry = next[row.id]!
    const where = whereItLeftOff(row, client)
    const reason = pressed ? "memory-pressure" : "oversize-idle"
    if (!(await archive(row, reason, `${mb(entry.bytes)}; ${where}`).catch(() => false))) continue
    entry.archivedAt = at
    archived += 1
    const boss = reachable(row.coordinatingCreatorSessionId)
    if (boss && boss.id !== row.id) await send(boss.id, archivedNote(row.name, row.id, entry.bytes, where)).catch(failed)
    emitNervesEvent({ component: "senses", event: "senses.app_sessions_oversize_archived", message: "archived an idle Copilot app session whose history is over the limit", meta: { session: row.id, bytes: entry.bytes, reason } })
  }

  writeJson(stateFile(agentRoot), { sessions: next } satisfies OversizeState)
  if (nudged) emitNervesEvent({ component: "senses", event: "senses.app_sessions_oversize_nudge", message: "asked for a hand-off of Copilot app sessions whose history is over the limit", meta: { sessions: nudged } })
  return { nudged, archived }
}
