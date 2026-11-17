import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { restartStatus, type AppSessionsOptions } from "./client"
import { writeJson, readJson } from "./store"
import type { RunCommand } from "./run-command"

/**
 * The facts the status digest reads besides the app's sessions: the machine's health from Housesitter, the drains' status
 * and the pull requests merged today. Every one is read with no model turn; a source that fails says so and nothing else.
 */
export type Heartbeat = "ok" | "stale" | "bad" | "unknown"

export interface MachineFacts {
  installed: boolean
  heartbeat: Heartbeat
  beatAgeS: number | null
  /** What the heartbeat says is wrong, if it says so. */
  bad: string | null
  restartedAt: string | null
  resumedAt: string | null
  /** Sessions the health watch is following, and the ones it found broken. */
  watched: number
  watchBad: Array<{ id: string; title: string; status: string }>
  error?: string
}

export interface DrainFacts {
  polling: number
  waiting: number
  relays: number
  /** Drains whose last good poll is old, as "owner/repo: 40 min". */
  stale: string[]
  quota: string[]
  error?: string
}

export interface MergedFacts {
  label: string
  count: number
  prs: Array<{ repo: string; number: number; title: string }>
  error?: string
}

/** A heartbeat older than this is the watcher itself gone quiet. */
export const HEARTBEAT_STALE_S = 180
/** A drain whose last good poll is older than this is not polling. */
export const DRAIN_STALE_MS = 15 * 60_000
const MAX_MERGED_LISTED = 8

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** The machine's health, from `housesitter restart-copilot --status --json`. */
export async function readMachine(options: AppSessionsOptions): Promise<MachineFacts> {
  const empty: MachineFacts = { installed: false, heartbeat: "unknown", beatAgeS: null, bad: null, restartedAt: null, resumedAt: null, watched: 0, watchBad: [] }
  let result: Awaited<ReturnType<typeof restartStatus>>
  try {
    result = await restartStatus(options)
  } catch (error) {
    return { ...empty, error: (error as Error).message }
  }
  if (!result.installed) return empty
  const status = record(result.status)
  const recovery = record(status.recovery)
  const watch = record(record(recovery.watch).sessions)
  const beatAge = typeof recovery.beat_age_s === "number" ? recovery.beat_age_s : null
  const bad = text(recovery.bad)
  const watchBad = Object.entries(watch)
    .map(([id, entry]) => ({ id, title: text(record(entry).title) ?? id.slice(0, 8), status: text(record(entry).status) ?? "ok" }))
    .filter(entry => entry.status !== "ok")
  return {
    installed: true,
    heartbeat: bad ? "bad" : beatAge === null ? "unknown" : beatAge > HEARTBEAT_STALE_S ? "stale" : "ok",
    beatAgeS: beatAge,
    bad,
    restartedAt: text(record(status.result).restarted_at),
    resumedAt: text(record(status.resumer).at),
    watched: Object.keys(watch).length,
    watchBad,
  }
}

/** The drains' status lines as counts and the ones that are not polling. A line this does not know is left out. */
export function parseDrains(lines: string[], now: number): DrainFacts {
  const facts: DrainFacts = { polling: 0, waiting: 0, relays: 0, stale: [], quota: [] }
  for (const line of lines) {
    const drain = /^issue drain (\S+) -> \S+: last ok poll (\S+) .*?, (\d+) open, (\d+) waiting/.exec(line)
    if (drain) {
      const at = Date.parse(drain[2]!)
      const age = Number.isNaN(at) ? Infinity : now - at
      if (age > DRAIN_STALE_MS) facts.stale.push(`${drain[1]}: ${Number.isFinite(age) ? `${Math.round(age / 60_000)} min` : "never polled"}`)
      else facts.polling += 1
      facts.waiting += Number(drain[4])
      continue
    }
    if (line.startsWith("relay ")) {
      facts.relays += 1
      continue
    }
    const quota = /^quota (\S+): (\d+)\/(\d+) calls left/.exec(line)
    if (quota) facts.quota.push(`${quota[1]} ${quota[2]}/${quota[3]}`)
  }
  return facts
}

/** The drains' status from the configured command, which prints `{ "status": ["…"] }`. */
export async function readDrains(command: string[] | undefined, run: RunCommand, now: number): Promise<DrainFacts | null> {
  if (!command) return null
  const result = await run(command, 60_000)
  if (!result.ok) return { polling: 0, waiting: 0, relays: 0, stale: [], quota: [], error: result.error ?? "the drains command failed" }
  try {
    const status = record(JSON.parse(result.stdout)).status
    return parseDrains(Array.isArray(status) ? status.filter((line): line is string => typeof line === "string") : [], now)
  } catch {
    return { polling: 0, waiting: 0, relays: 0, stale: [], quota: [], error: "the drains command did not print JSON" }
  }
}

/** The headers and body of `gh api -i` output. A 304 has no body. */
export function parseHttp(stdout: string): { status: number; etag: string | null; body: string } {
  const split = stdout.search(/\r?\n\r?\n/)
  const head = split < 0 ? stdout : stdout.slice(0, split)
  const body = split < 0 ? "" : stdout.slice(split).trim()
  const lines = head.split(/\r?\n/)
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines[0]!)?.[1] ?? 0)
  const etag = lines.map(line => /^etag:\s*(.+)$/i.exec(line)?.[1]?.trim()).find(Boolean) ?? null
  return { status, etag, body }
}

interface MergedCache { since: string; at: number; etag: string | null; count: number; prs: MergedFacts["prs"] }

/** A search answered this recently is reused: GitHub's search has its own small quota, and asking more often tells nothing new. */
export const MERGED_TTL_MS = 4 * 60_000

/** Midnight today in this machine's time zone, as an instant GitHub's search takes. */
export function startOfToday(now: number): string {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * Pull requests the account merged today. An answer under four minutes old is reused, and the search is conditional when
 * GitHub gave an ETag (a 304 costs nothing). Search draws on its own quota, never the one the drains use.
 */
export async function readMergedToday(account: { label: string; command: string[] }, run: RunCommand, cacheFile: string, now: number): Promise<MergedFacts> {
  const since = startOfToday(now)
  const caches = readJson<Record<string, MergedCache>>(cacheFile, {})
  const cached = caches[account.label]?.since === since ? caches[account.label] : undefined
  if (cached && now - cached.at < MERGED_TTL_MS) return { label: account.label, count: cached.count, prs: cached.prs }
  const query = `search/issues?q=${encodeURIComponent(`is:pr is:merged author:@me merged:>=${since}`)}&per_page=100`
  const result = await run([...account.command, "api", "-i", ...(cached?.etag ? ["-H", `If-None-Match: ${cached.etag}`] : []), query], 60_000)
  const http = parseHttp(result.stdout)
  if (http.status === 304 && cached) {
    caches[account.label] = { ...cached, at: now }
    writeJson(cacheFile, caches)
    return { label: account.label, count: cached.count, prs: cached.prs }
  }
  if (http.status !== 200) return { label: account.label, count: cached?.count ?? 0, prs: cached?.prs ?? [], error: result.error ?? `GitHub answered ${http.status || "nothing"}` }
  try {
    const body = record(JSON.parse(http.body))
    const items = (Array.isArray(body.items) ? body.items : []).map(record)
    const prs = items.map(item => ({
      repo: (text(item.repository_url) ?? "").replace(/^.*\/repos\//, ""),
      number: typeof item.number === "number" ? item.number : 0,
      title: text(item.title) ?? "",
    })).slice(0, MAX_MERGED_LISTED)
    const count = typeof body.total_count === "number" ? body.total_count : items.length
    caches[account.label] = { since, at: now, etag: http.etag, count, prs }
    writeJson(cacheFile, caches)
    return { label: account.label, count, prs }
  } catch {
    return { label: account.label, count: 0, prs: [], error: "GitHub's answer was not JSON" }
  }
}

/** One source's failure, kept short, as a nerves event and a line the digest shows. */
export function sourceFailed(source: string, error: string): string {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.app_sessions_digest_source_error", message: "a status digest source could not be read", meta: { source, error } })
  return `${source}: ${error}`.slice(0, 200)
}

export function mergedCacheFile(stateDir: string): string {
  return path.join(stateDir, "digest-merged.json")
}

/** Whether a folder exists: a desk root that is not there is skipped, not an error. */
export function isFolder(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory()
  } catch {
    return false
  }
}
