import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { SeenLedgerLike } from "@ouro.bot/friends/a2a-client"
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
export const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 1000

function nonceFileName(nonce: string): string {
  return `${createHash("sha256").update(nonce).digest("hex")}.json`
}

export class FileA2ASeenLedger implements DurableSeenLedger {
  private readonly dir: string
  private readonly cache = new Set<string>()

  constructor(agentRoot: string, options: { now?: number } = {}) {
    this.dir = path.join(agentRoot, "state", "a2a", "seen")
    fs.mkdirSync(this.dir, { recursive: true })
    this.loadExisting(options.now ?? Date.now())
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
    fs.writeFileSync(
      path.join(this.dir, nonceFileName(nonce)),
      `${JSON.stringify({ nonce, markedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf-8",
    )
    this.cache.add(nonce)
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_seen_marked",
      message: "marked A2A seal nonce as seen (first sight)",
      meta: { nonceHash: nonceFileName(nonce).slice(0, 16) },
    })
  }

  /** Reload every persisted nonce from disk into the in-memory set (the restart
   * replay defense). Corrupt/unreadable artifacts are skipped so one bad file can
   * never reopen the replay window for the rest. */
  private loadExisting(now: number): void {
    let pruned = 0
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
      // Entries past the freshness window can never match an acceptable envelope again, so they are dropped
      // (the ledger would otherwise grow forever). An undated entry is kept.
      const markedAt = typeof record.markedAt === "string" ? Date.parse(record.markedAt) : Number.NaN
      if (Number.isFinite(markedAt) && now - markedAt > SEEN_RETENTION_MS) {
        /* v8 ignore start -- a file that vanished or cannot be removed is simply left; it is retried next start @preserve */
        try {
          fs.unlinkSync(file)
          pruned += 1
        } catch {
          // left for the next start
        }
        /* v8 ignore stop @preserve */
        continue
      }
      if (typeof record.nonce === "string" && record.nonce.length > 0) {
        this.cache.add(record.nonce)
      }
    }
    if (pruned > 0) {
      emitNervesEvent({ component: "channels", event: "channel.a2a_seen_pruned", message: "pruned A2A seen entries past the freshness window", meta: { dir: this.dir, pruned } })
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

