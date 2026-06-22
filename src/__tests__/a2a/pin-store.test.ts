import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  base58btcEncode,
  type PinnedDid,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { loadPinStore } from "../../a2a/pin-store"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

function makePinned(did: string): PinnedDid {
  // A deterministic 32-byte key derived from the did (test fixture, not real crypto).
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) bytes[i] = did.charCodeAt(i % did.length) & 0xff
  return { did, ed25519Pub: bytes }
}

describe("durable a2a PinStore (backed by AgentMeta.identity.pinnedKey)", () => {
  it("reads back a pin it just set (first-contact set → get)", async () => {
    tmp = createTmpBundle({ agentName: "pin-set-get" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const pinStore = await loadPinStore({ store })

    const did = "did:key:zPinSetGetAAAAAAAAAAAAAAAAAAAAAAAAA"
    expect(pinStore.get(did)).toBeUndefined()
    const pinned = makePinned(did)
    pinStore.set(did, pinned)

    const read = pinStore.get(did)
    expect(read?.did).toBe(did)
    expect(Buffer.from(read!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
  })

  it("persists the pin durably so it survives a simulated restart (new store over the same dir)", async () => {
    tmp = createTmpBundle({ agentName: "pin-restart" })
    const did = "did:key:zPinRestartBBBBBBBBBBBBBBBBBBBBBBBBB"
    const pinned = makePinned(did)

    {
      const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
      const pinStore = await loadPinStore({ store })
      pinStore.set(did, pinned)
    }

    // Simulated restart: a brand-new store + PinStore over the same friends dir.
    const reloadedStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const reloaded = await loadPinStore({ store: reloadedStore })
    const read = reloaded.get(did)
    expect(read?.did).toBe(did)
    expect(Buffer.from(read!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
  })

  it("writes the pin onto an EXISTING friend record's AgentMeta.identity.pinnedKey (the library's home)", async () => {
    tmp = createTmpBundle({ agentName: "pin-existing-record" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const did = "did:key:zPinExistingCCCCCCCCCCCCCCCCCCCCCCCCC"
    // Pre-create an agent friend record keyed on the DID.
    const record = await upsertAgentPeer(store, {
      name: "Existing Peer",
      agentId: did,
      a2a: { did, endpointUrl: "https://peer.example/a2a", agentId: did },
    })

    const pinStore = await loadPinStore({ store })
    const pinned = makePinned(did)
    pinStore.set(did, pinned)

    // The pin landed on the SAME record (not a new one) under identity.pinnedKey.
    const after = await store.get(record.id)
    expect(after?.agentMeta?.identity?.pinnedKey).toBe(base58btcEncode(pinned.ed25519Pub))
    expect(after?.agentMeta?.identity?.did).toBe(did)
  })

  it("returns undefined for an unknown agentId", async () => {
    tmp = createTmpBundle({ agentName: "pin-unknown" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const pinStore = await loadPinStore({ store })
    expect(pinStore.get("did:key:zNeverPinnedDDDDDDDDDDDDDDDDDDDDDDDD")).toBeUndefined()
  })

  it("never treats an empty-string DID as a matchable key (get + set are inert)", async () => {
    tmp = createTmpBundle({ agentName: "pin-empty" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const pinStore = await loadPinStore({ store })
    expect(pinStore.get("")).toBeUndefined()
    // set on an empty DID must not crash and must not become a readable pin.
    pinStore.set("", makePinned("placeholder"))
    expect(pinStore.get("")).toBeUndefined()
  })

  it("re-pins idempotently to the same key (set twice → same read-back)", async () => {
    tmp = createTmpBundle({ agentName: "pin-idempotent" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const did = "did:key:zPinIdempotentEEEEEEEEEEEEEEEEEEEEEEE"
    const pinStore = await loadPinStore({ store })
    const pinned = makePinned(did)
    pinStore.set(did, pinned)
    pinStore.set(did, pinned)
    expect(Buffer.from(pinStore.get(did)!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
  })
})
