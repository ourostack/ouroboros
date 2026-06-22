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

function nonceFileName(nonce: string): string {
  return `${createHash("sha256").update(nonce).digest("hex")}.json`
}

export class FileA2ASeenLedger implements DurableSeenLedger {
  private readonly dir: string
  private readonly cache = new Set<string>()

  constructor(agentRoot: string) {
    this.dir = path.join(agentRoot, "state", "a2a", "seen")
    fs.mkdirSync(this.dir, { recursive: true })
    this.loadExisting()
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
      let record: { nonce?: unknown }
      try {
        record = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf-8")) as { nonce?: unknown }
      } catch {
        continue
      }
      if (typeof record.nonce === "string" && record.nonce.length > 0) {
        this.cache.add(record.nonce)
      }
    }
  }
}
