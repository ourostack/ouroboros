import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { EnvelopeBindingOptions, SeenLedgerLike } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * A durable, harness-owned friends `SeenLedgerLike` (replay defense) backed by a
 * file home under `<agentRoot>/state/a2a/seen`, mirroring the `FileA2ATaskStore`
 * `state/a2a/tasks` precedent (`task-store.ts:15`).
 *
 * The make-or-break guarantee: a nonce marked seen STAYS marked across a restart
 * — a replayed seal nonce arriving after the a2a sense restarts must STILL be
 * rejected (no reopened replay window). We get this by persisting each marked
 * nonce as its own file (`sha256(nonce).json`, append-only — never a whole-file
 * rewrite) and reloading the set into an in-memory cache at construction.
 *
 * Single-writer: the a2a sense process. Reads fail-open (a corrupt/missing
 * artifact is treated as empty), but the durability guarantee is one-directional
 * — once a nonce is marked, it stays marked. An empty-string nonce is never a
 * matchable key.
 */
export interface DurableSeenLedger extends SeenLedgerLike {
  /** The number of seen nonces currently loaded (diagnostics/tests). */
  readonly size: number
}

/**
 * How long a seen entry must be kept: friends accepts an envelope until 7 days after its `issuedAt`, and an `issuedAt`
 * at most 2 minutes ahead of the clock, so an entry marked longer ago than both can never match an acceptable
 * envelope again (`DEFAULT_MAX_AGE_MS` plus `DEFAULT_MAX_FUTURE_SKEW_MS` in friends `envelope-binding`).
 */
export const MAX_ENVELOPE_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000
export const SEEN_RETENTION_MS = MAX_ENVELOPE_AGE_MS + MAX_FUTURE_SKEW_MS

/** While the agent runs, expired entries are dropped when a new one is marked, at most this often. */
export const SEEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** The binding windows a receive path may set (`rejectUnboundEnvelopes` is always forced on). */
export type BindingWindows = Omit<EnvelopeBindingOptions, "rejectUnboundEnvelopes">

/**
 * Keep configured age windows inside what the seen ledger remembers. An envelope accepted later than the ledger keeps
 * its entry could be replayed, so any age window above 7 days, or a future skew above 2 minutes, is clamped to that
 * limit with a warning.
 */
export function bindingWindowsWithinRetention(options: BindingWindows | undefined): BindingWindows {
  const clamped: BindingWindows = { ...options }
  const changed: string[] = []
  for (const [field, limit] of [["maxAgeMs", MAX_ENVELOPE_AGE_MS], ["delegatedMaxAgeMs", MAX_ENVELOPE_AGE_MS], ["maxFutureSkewMs", MAX_FUTURE_SKEW_MS]] as const) {
    const value = clamped[field]
    if (value !== undefined && value > limit) {
      clamped[field] = limit
      changed.push(field)
    }
  }
  if (changed.length > 0) {
    emitNervesEvent({
      level: "warn",
      component: "channels",
      event: "channel.a2a_binding_window_clamped",
      message: "A2A message age limits were set longer than the replay ledger keeps entries (7 days, plus 2 minutes of clock skew), so they were shortened to those limits",
      meta: { fields: changed },
    })
  }
  return clamped
}

function nonceFileName(nonce: string): string {
  return `${createHash("sha256").update(nonce).digest("hex")}.json`
}

export class FileA2ASeenLedger implements DurableSeenLedger {
  private readonly dir: string
  /** Each seen key with when it was marked (NaN: undated, kept) and the file that holds it. */
  private readonly cache = new Map<string, { markedAt: number; file: string }>()
  private readonly now: () => number
  private lastPrunedAt: number

  constructor(agentRoot: string, options: { now?: () => number } = {}) {
    this.dir = path.join(agentRoot, "state", "a2a", "seen")
    this.now = options.now ?? Date.now
    fs.mkdirSync(this.dir, { recursive: true })
    this.lastPrunedAt = this.now()
    this.loadExisting()
    this.prune(this.lastPrunedAt)
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_seen_ledger_init",
      message: "initialized durable A2A seen ledger",
      meta: { dir: this.dir, seen: this.cache.size },
    })
  }

  get size(): number {
    return this.cache.size
  }

  isSeen(nonce: string): boolean {
    if (!nonce) return false
    const seen = this.cache.has(nonce)
    if (seen) {
      // A nonce we already processed is arriving again — for a seal nonce this is
      // a replay. Loud security signal.
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_replay_rejected",
        message: "A2A replay rejected (nonce already seen)",
        meta: { nonceHash: nonceFileName(nonce).slice(0, 16) },
      })
    }
    return seen
  }

  markSeen(nonce: string): void {
    // An empty-string nonce is never a matchable key — stay inert.
    if (!nonce) return
    if (this.cache.has(nonce)) return
    const now = this.now()
    const file = path.join(this.dir, nonceFileName(nonce))
    fs.writeFileSync(file, `${JSON.stringify({ nonce, markedAt: new Date(now).toISOString() }, null, 2)}\n`, "utf-8")
    this.cache.set(nonce, { markedAt: now, file })
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_seen_marked",
      message: "marked A2A seal nonce as seen (first sight)",
      meta: { nonceHash: nonceFileName(nonce).slice(0, 16) },
    })
    // A long-running agent drops expired entries as it goes, not only when it starts.
    if (now - this.lastPrunedAt >= SEEN_PRUNE_INTERVAL_MS) {
      this.lastPrunedAt = now
      this.prune(now)
    }
  }

  /** Drop entries marked longer ago than `SEEN_RETENTION_MS`: they can never match an acceptable envelope again. An
   * undated entry is kept. */
  private prune(now: number): void {
    let pruned = 0
    for (const [nonce, entry] of this.cache) {
      if (!(now - entry.markedAt > SEEN_RETENTION_MS)) continue
      /* v8 ignore start -- a file that vanished or cannot be removed is simply left; the next prune drops it from disk at restart @preserve */
      try {
        fs.unlinkSync(entry.file)
      } catch {
        // left on disk; it is expired, so dropping it from memory is still safe
      }
      /* v8 ignore stop @preserve */
      this.cache.delete(nonce)
      pruned += 1
    }
    if (pruned > 0) {
      emitNervesEvent({ component: "channels", event: "channel.a2a_seen_pruned", message: "pruned A2A seen entries past the freshness window", meta: { dir: this.dir, pruned } })
    }
  }

  /** Reload every persisted nonce from disk into the in-memory set (the restart
   * replay defense). Corrupt/unreadable artifacts are skipped so one bad file can
   * never reopen the replay window for the rest. */
  private loadExisting(): void {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.dir)
    } catch {
      /* v8 ignore next -- the constructor mkdirSync's the dir before this runs; unreadable dir is unreachable in practice @preserve */
      return
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue
      const file = path.join(this.dir, name)
      let record: { nonce?: unknown; markedAt?: unknown }
      try {
        record = JSON.parse(fs.readFileSync(file, "utf-8")) as { nonce?: unknown; markedAt?: unknown }
      } catch {
        continue
      }
      if (typeof record.nonce === "string" && record.nonce.length > 0) {
        const markedAt = typeof record.markedAt === "string" ? Date.parse(record.markedAt) : Number.NaN
        this.cache.set(record.nonce, { markedAt, file })
      }
    }
  }
}

/**
 * A seen ledger under `root` that only this user can reach (the CLI keeps one for replies). `root` is created 0700 and
 * refused when it is a symlink, not a folder, owned by someone else, or open to group or other, since anyone who can
 * delete entries can replay an old reply.
 */
export function openPrivateSeenLedger(root: string): FileA2ASeenLedger {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(root)
  /* v8 ignore next -- process.getuid exists on every POSIX platform the CLI runs on @preserve */
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`refusing the A2A reply ledger at ${root}: it must be a folder owned by you with mode 0700`)
  }
  return new FileA2ASeenLedger(root)
}

