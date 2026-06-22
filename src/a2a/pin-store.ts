import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import {
  base58btcDecode,
  base58btcEncode,
  type PinStore,
  type PinnedDid,
} from "@ouro.bot/friends/a2a-client"
import {
  resolveAgentIdentity,
  type FriendRecord,
  type FriendStore,
} from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * A durable friends `PinStore` backed by the friend record's
 * `AgentMeta.identity.pinnedKey` (the library's defined home for a TOFU pin).
 *
 * The friends `PinStore` interface is SYNCHRONOUS (`get`/`set`), but durability
 * requires the on-disk friend store. We reconcile this with a write-through cache:
 * an in-memory snapshot loaded once at construction (the restart-reload), served
 * synchronously, with `set` writing through to the record file synchronously so a
 * marked pin survives a restart. Single-writer: the a2a sense process.
 *
 * `fromAgentId` is the peer's verified DID (the cross-agent primary key). An
 * empty-string DID is never a matchable key (it can never index a pin).
 */
export interface DurablePinStore extends PinStore {
  /** The number of pins currently loaded (diagnostics/tests). */
  readonly size: number
}

interface CacheEntry {
  pinned: PinnedDid
  recordId: string
}

/**
 * The friend-store directory layout we write through to. `FileFriendStore` stores
 * each record as `<friendsPath>/<id>.json`; we read+mutate+write that file directly
 * for the synchronous durable `set`, preserving every other (already-normalized)
 * field verbatim so the async store reads it back identically.
 */
export interface LoadPinStoreInput {
  store: FriendStore
  /**
   * The absolute friends directory the `store` persists to. Required for the
   * synchronous durable write-through. Defaults are not inferred — the caller
   * (the a2a sense) owns the path.
   */
  friendsDir: string
}

function decodePinnedKey(pinnedKey: string): Uint8Array | null {
  return base58btcDecode(pinnedKey)
}

export async function loadPinStore(input: { store: FriendStore } & Partial<Pick<LoadPinStoreInput, "friendsDir">>): Promise<DurablePinStore> {
  const store = input.store
  // The friends dir: the store's own path when it exposes one (FileFriendStore),
  // else the explicit override. FileFriendStore keeps `friendsPath` public.
  const friendsDir = input.friendsDir
    ?? (store as { friendsPath?: unknown }).friendsPath as string | undefined
  /* v8 ignore next -- the a2a sense always constructs a FileFriendStore (friendsPath present) or passes friendsDir explicitly @preserve */
  if (typeof friendsDir !== "string" || friendsDir.length === 0) {
    throw new Error("loadPinStore requires a friends directory (store.friendsPath or input.friendsDir)")
  }

  const cache = new Map<string, CacheEntry>()
  const all = (typeof store.listAll === "function" ? await store.listAll() : []) as FriendRecord[]
  for (const record of all) {
    const identity = resolveAgentIdentity(record.agentMeta)
    if (!identity.did || !identity.pinnedKey) continue
    const ed25519Pub = decodePinnedKey(identity.pinnedKey)
    /* v8 ignore next -- a persisted pinnedKey is always valid base58btc (we wrote it); guard protects hand-edited records @preserve */
    if (!ed25519Pub) continue
    cache.set(identity.did, { pinned: { did: identity.did, ed25519Pub }, recordId: record.id })
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_pin_store_loaded",
    message: "loaded durable A2A pin store",
    meta: { pins: cache.size, friendsDir },
  })

  return new FileBackedPinStore(cache, friendsDir)
}

class FileBackedPinStore implements DurablePinStore {
  constructor(
    private readonly cache: Map<string, CacheEntry>,
    private readonly friendsDir: string,
  ) {}

  get size(): number {
    return this.cache.size
  }

  get(fromAgentId: string): PinnedDid | undefined {
    if (!fromAgentId) return undefined
    const entry = this.cache.get(fromAgentId)
    if (!entry) return undefined
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_pin_hit",
      message: "A2A pin hit",
      meta: { did: fromAgentId },
    })
    return entry.pinned
  }

  set(fromAgentId: string, pinned: PinnedDid): void {
    // An empty-string DID is never a matchable key (security: it can never index a
    // pin). Stay inert rather than minting an unkeyed record.
    if (!fromAgentId) return
    const pinnedKey = base58btcEncode(pinned.ed25519Pub)
    const existing = this.cache.get(fromAgentId)
    const recordId = existing?.recordId ?? this.writeNewRecord(fromAgentId, pinnedKey)
    if (existing) this.writePinOntoRecord(recordId, fromAgentId, pinnedKey)
    this.cache.set(fromAgentId, { pinned: { did: fromAgentId, ed25519Pub: pinned.ed25519Pub }, recordId })
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_pin_set",
      message: "set durable A2A pin (first-contact)",
      meta: { did: fromAgentId, newRecord: !existing },
    })
  }

  private recordPath(recordId: string): string {
    return path.join(this.friendsDir, `${recordId}.json`)
  }

  /** Merge the pin onto an EXISTING record's `agentMeta.identity`, preserving all
   * other (already-normalized) fields verbatim. Synchronous + durable. */
  private writePinOntoRecord(recordId: string, did: string, pinnedKey: string): void {
    const file = this.recordPath(recordId)
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as FriendRecord
    const now = new Date().toISOString()
    const agentMeta = raw.agentMeta ?? {
      bundleName: raw.name,
      familiarity: 0,
      sharedMissions: [],
      outcomes: [],
    }
    const next: FriendRecord = {
      ...raw,
      agentMeta: {
        ...agentMeta,
        identity: { ...(agentMeta.identity ?? {}), did, pinnedKey, pinnedAt: agentMeta.identity?.pinnedAt ?? now },
      },
      updatedAt: now,
    }
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
  }

  /** Mint a minimal safe-by-default `agent` friend record carrying the pin, when no
   * record exists for this DID yet. Mirrors `upsertAgentPeer`'s record shape at
   * `stranger` trust (the cold-contact default). Synchronous + durable. */
  private writeNewRecord(did: string, pinnedKey: string): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    const record: FriendRecord = {
      id,
      name: did,
      role: "agent-peer",
      trustLevel: "stranger",
      kind: "agent",
      externalIds: [{ provider: "a2a-agent", externalId: did, linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      agentMeta: {
        bundleName: did,
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        identity: { did, pinnedKey, pinnedAt: now },
        a2a: { agentId: did, did },
      },
    }
    fs.mkdirSync(this.friendsDir, { recursive: true })
    fs.writeFileSync(this.recordPath(id), `${JSON.stringify(record, null, 2)}\n`, "utf-8")
    return id
  }
}
