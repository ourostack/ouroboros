import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import {
  base58btcDecode,
  base58btcEncode,
  type PinStore,
  type PinnedDid,
} from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * A durable, harness-owned friends `PinStore` backed by a file home under
 * `<agentRoot>/state/a2a/pins`, keyed `did → pinnedKey`. Mirrors the
 * `FileA2ATaskStore` `state/a2a/tasks` precedent (`task-store.ts`).
 *
 * WHY HARNESS-OWNED (not `AgentMeta.identity.pinnedKey`): friends alpha.7's
 * `FileFriendStore.normalizeAgentMeta` silently drops `AgentMeta.identity`
 * (including `pinnedKey`) on every read AND write — only `a2a.did` round-trips.
 * The library's `PinStore` is an injectable, host-provided interface and the
 * library never touches the filesystem itself; the host owns storage. So the
 * pinned KEY BYTES live here, in a harness-owned file, while the friend record
 * keeps `a2a.did` for the DID-lookup. (The dropped-`identity` behavior is a known
 * latent library gap, logged as a separate follow-up — NOT this store's concern.)
 *
 * The friends `PinStore` interface is SYNCHRONOUS (`get`/`set`). Durability is
 * reconciled with a write-through cache: pins are loaded once at construction
 * (the restart-reload) into an in-memory map served synchronously, and `set`
 * writes through to disk synchronously so a marked pin survives a restart.
 * Single-writer: the a2a sense process.
 *
 * `fromAgentId` is the peer's verified DID (the cross-agent primary key). An
 * empty-string DID is never a matchable key — it can never index a pin.
 */
export interface DurablePinStore extends PinStore {
  /** The number of pins currently loaded (diagnostics/tests). */
  readonly size: number
}

/** On-disk shape of a single persisted pin (one file per DID). */
interface StoredPin {
  did: string
  /** The pinned Ed25519 public key, base58btc-encoded. */
  pinnedKey: string
}

function pinFileName(did: string): string {
  return `${createHash("sha256").update(did).digest("hex")}.json`
}

export class FileA2APinStore implements DurablePinStore {
  private readonly dir: string
  private readonly cache = new Map<string, PinnedDid>()

  constructor(agentRoot: string) {
    this.dir = path.join(agentRoot, "state", "a2a", "pins")
    fs.mkdirSync(this.dir, { recursive: true })
    this.loadExisting()
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_pin_store_init",
      message: "initialized durable A2A pin store",
      meta: { dir: this.dir, pins: this.cache.size },
    })
  }

  get size(): number {
    return this.cache.size
  }

  get(fromAgentId: string): PinnedDid | undefined {
    if (!fromAgentId) return undefined
    const pinned = this.cache.get(fromAgentId)
    if (!pinned) return undefined
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_pin_hit",
      message: "A2A pin hit",
      meta: { did: fromAgentId },
    })
    return pinned
  }

  set(fromAgentId: string, pinned: PinnedDid): void {
    // An empty-string DID is never a matchable key (security: it can never index a
    // pin). Stay inert rather than writing an unkeyed pin file.
    if (!fromAgentId) return
    const existed = this.cache.has(fromAgentId)
    const stored: StoredPin = { did: fromAgentId, pinnedKey: base58btcEncode(pinned.ed25519Pub) }
    fs.writeFileSync(
      path.join(this.dir, pinFileName(fromAgentId)),
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf-8",
    )
    this.cache.set(fromAgentId, { did: fromAgentId, ed25519Pub: pinned.ed25519Pub })
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_pin_set",
      message: "set durable A2A pin",
      meta: { did: fromAgentId, rotated: existed },
    })
  }

  /** Reload every persisted pin from disk into the in-memory cache (the restart
   * replay). Corrupt/undecodable files are skipped so one bad file can never
   * wedge the store. */
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
      let stored: StoredPin
      try {
        stored = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf-8")) as StoredPin
      } catch {
        continue
      }
      if (!stored.did || !stored.pinnedKey) continue
      const ed25519Pub = base58btcDecode(stored.pinnedKey)
      if (!ed25519Pub) continue
      this.cache.set(stored.did, { did: stored.did, ed25519Pub })
    }
  }
}
