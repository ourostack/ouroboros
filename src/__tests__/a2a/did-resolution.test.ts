import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  signFullSuccessor,
  MemoryPinStore,
  type DidKeyIdentity,
  type PinStore,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2APinStore } from "../../a2a/pin-store"
import { FileFriendStore, findFriendByDid, upsertAgentPeer } from "@ouro.bot/friends"
import { makeDidResolution, type OwnerNotice, type SuccessorStatement } from "../../a2a/did-resolution"
import * as nerves from "../../nerves/runtime"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

/** Mint a fresh did:key identity (signing + derived sealing keys) for fixtures. */
function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({
    sodium,
    ed25519Pub: kp.publicKey,
    ed25519Priv: kp.privateKey,
  })
}

function newPinStore(): FileA2APinStore {
  tmp = createTmpBundle({ agentName: `did-res-${Math.random().toString(36).slice(2, 8)}` })
  return new FileA2APinStore(tmp.agentRoot)
}

/** `resolveAndPin` is the verify-and-pin core the inbound bridge consumes: refusals, first contact and pin hits. */
describe("DidResolution.resolveAndPin (first-contact + rotation, did:key)", () => {
  it("returns null for an unparseable DID (refused)", async () => {
    const pinStore = newPinStore()
    const didRes = makeDidResolution({ sodium })
    const out = await didRes.resolveAndPin({
      fromAgentId: "peer-bad",
      did: "did:web:not-a-key",
      pinStore,
      trustOfSource: "family",
    })
    expect(out).toBeNull()
  })

  it("returns null for an empty-string DID (never a matchable key)", async () => {
    const pinStore = newPinStore()
    const didRes = makeDidResolution({ sodium })
    const out = await didRes.resolveAndPin({
      fromAgentId: "peer-empty",
      did: "",
      pinStore,
      trustOfSource: "family",
    })
    expect(out).toBeNull()
  })

  it("first contact: pins the (did, key) and returns the key", async () => {
    const pinStore = newPinStore()
    const id = mintIdentity()
    const didRes = makeDidResolution({ sodium })

    const out = await didRes.resolveAndPin({
      fromAgentId: id.did,
      did: id.did,
      pinStore,
      trustOfSource: "stranger",
    })
    expect(out).not.toBeNull()
    expect(Buffer.from(out!.ed25519Pub).equals(Buffer.from(id.ed25519Pub))).toBe(true)
    // The pin landed under fromAgentId.
    expect(pinStore.get(id.did)?.did).toBe(id.did)
  })

  it("subsequent contact, same key: pin-hit, returns the pinned key", async () => {
    const pinStore = newPinStore()
    const id = mintIdentity()
    const didRes = makeDidResolution({ sodium })

    await didRes.resolveAndPin({ fromAgentId: id.did, did: id.did, pinStore, trustOfSource: "friend" })
    const again = await didRes.resolveAndPin({ fromAgentId: id.did, did: id.did, pinStore, trustOfSource: "friend" })
    expect(again).not.toBeNull()
    expect(Buffer.from(again!.ed25519Pub).equals(Buffer.from(id.ed25519Pub))).toBe(true)
  })

  it("refuses a DID whose pinned key differs, and a retired DID", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const didRes = makeDidResolution({ sodium })
    // A pin filed under one DID that names another key (only a hand-edited pin file looks like this).
    await didRes.resolveAndPin({ fromAgentId: "stable-peer", did: old.did, pinStore, trustOfSource: "family" })
    expect(await didRes.resolveAndPin({ fromAgentId: "stable-peer", did: next.did, pinStore, trustOfSource: "family" })).toBeNull()
    pinStore.retire("stable-peer", next.did, "2026-11-06T00:00:00.000Z")
    expect(await didRes.resolveAndPin({ fromAgentId: "stable-peer", did: old.did, pinStore, trustOfSource: "family" })).toBeNull()
  })
})

/**
 * Rotation. friends calls `resolveAndPin` with the signed sender DID as both `fromAgentId` and `did`, so a peer that
 * rotated arrives as a DID with no pin. A successor statement (old key and new key both signing, over `issuedAt`) is
 * judged against the OLD DID's pin, at the trust of the OLD record. The friends wire has no carrier for statements, so
 * the host channel (`successorFor`) supplies them; production omits it.
 */
describe("DidResolution.resolveAndPin (signed successor statement)", () => {
  const ISSUED = "2026-11-06T10:00:00.000Z"

  async function setup(trustLevel: "family" | "friend" | "acquaintance" | "stranger") {
    const pinStore = newPinStore()
    const store = new FileFriendStore(`${tmp!.agentRoot}/friends`)
    const old = mintIdentity()
    const next = mintIdentity()
    await upsertAgentPeer(store, { name: "Peer", agentId: old.did, trustLevel, a2a: { did: old.did, agentId: old.did, endpointUrl: "https://peer.example/a2a" } })
    await makeDidResolution({ sodium }).resolveAndPin({ fromAgentId: old.did, did: old.did, pinStore, trustOfSource: trustLevel })
    const statement = { oldDid: old.did, ...signFullSuccessor({ sodium, oldDid: old.did, oldEd25519Priv: old.ed25519Priv, newDid: next.did, newEd25519Pub: next.ed25519Pub, newEd25519Priv: next.ed25519Priv, issuedAt: ISSUED }) } as SuccessorStatement
    return { pinStore, store, old, next, statement }
  }

  for (const trustLevel of ["family", "friend"] as const) {
    it(`accepts a full statement from a ${trustLevel} peer, retires the old pin and moves the record`, async () => {
      const { pinStore, store, old, next, statement } = await setup(trustLevel)
      const didRes = makeDidResolution({ sodium, store, successorFor: (did) => did === next.did ? statement : undefined })
      const out = await didRes.resolveAndPin({ fromAgentId: next.did, did: next.did, pinStore, trustOfSource: "stranger" })
      expect(Buffer.from(out!.ed25519Pub).equals(Buffer.from(next.ed25519Pub))).toBe(true)
      expect(pinStore.get(next.did)).toMatchObject({ did: next.did, rotatedAt: ISSUED })
      expect(pinStore.get(old.did)).toMatchObject({ did: old.did, retiredBy: next.did, rotatedAt: ISSUED })
      const moved = await findFriendByDid(store, next.did)
      expect(moved).toMatchObject({ trustLevel })
      expect(await findFriendByDid(store, old.did)).toBeNull()
      // The old DID is a tombstone now.
      expect(await didRes.resolveAndPin({ fromAgentId: old.did, did: old.did, pinStore, trustOfSource: trustLevel })).toBeNull()
    })
  }

  it("rejects a rotation from an acquaintance or unknown peer, and never falls back to a first contact", async () => {
    const { pinStore, store, next, statement } = await setup("acquaintance")
    const didRes = makeDidResolution({ sodium, store, successorFor: () => statement })
    expect(await didRes.resolveAndPin({ fromAgentId: next.did, did: next.did, pinStore, trustOfSource: "stranger" })).toBeNull()
    expect(pinStore.get(next.did)).toBeUndefined()
    // Without a friend store the old trust is unknown, so it is read as stranger.
    expect(await makeDidResolution({ sodium, successorFor: () => statement }).resolveAndPin({ fromAgentId: next.did, did: next.did, pinStore, trustOfSource: "family" })).toBeNull()
  })

  it("rejects a statement missing the successor's consent or signed by the wrong key", async () => {
    const { pinStore, store, old, next, statement } = await setup("family")
    const stranger = mintIdentity()
    const forged = { ...statement, successorProof: signFullSuccessor({ sodium, oldDid: old.did, oldEd25519Priv: old.ed25519Priv, newDid: next.did, newEd25519Pub: next.ed25519Pub, newEd25519Priv: stranger.ed25519Priv, issuedAt: ISSUED }).successorProof }
    for (const bad of [forged, { ...statement, rotationProof: "not-a-signature" }, { ...statement, issuedAt: "2026-11-06T10:00:01.000Z" }]) {
      const didRes = makeDidResolution({ sodium, store, successorFor: () => bad })
      expect(await didRes.resolveAndPin({ fromAgentId: next.did, did: next.did, pinStore, trustOfSource: "stranger" })).toBeNull()
    }
    expect(pinStore.get(old.did)?.retiredBy).toBeUndefined()
  })

  it("refuses the message when the verified rotation cannot move the record (a record already holds the new DID)", async () => {
    const { pinStore, store, next, statement } = await setup("family")
    await upsertAgentPeer(store, { name: "Squatter", agentId: next.did, trustLevel: "stranger", a2a: { did: next.did, agentId: next.did, endpointUrl: "https://other.example/a2a" } })
    const didRes = makeDidResolution({ sodium, store, successorFor: () => statement })
    expect(await didRes.resolveAndPin({ fromAgentId: next.did, did: next.did, pinStore, trustOfSource: "stranger" })).toBeNull()
    expect((await findFriendByDid(store, next.did))?.name).toBe("Squatter")
  })
})

/**
 * `settleSender` runs before a receive path reads the sender's trust: it applies a rotation the first message from a new
 * DID brings, and finishes a rotation whose record did not follow. Returns false when the message must be refused.
 */
describe("DidResolution.settleSender", () => {
  const ISSUED = "2026-11-06T10:00:00.000Z"

  async function rotated(options: { agentName?: string; notifyOwner?: (notice: OwnerNotice) => Promise<void> } = {}) {
    const pinStore = newPinStore()
    const store = new FileFriendStore(`${tmp!.agentRoot}/friends`)
    const old = mintIdentity()
    const next = mintIdentity()
    await upsertAgentPeer(store, { name: "Peer", agentId: old.did, trustLevel: "family", a2a: { did: old.did, agentId: old.did, endpointUrl: "https://peer.example/a2a" } })
    await makeDidResolution({ sodium }).resolveAndPin({ fromAgentId: old.did, did: old.did, pinStore, trustOfSource: "family" })
    const statement = { oldDid: old.did, ...signFullSuccessor({ sodium, oldDid: old.did, oldEd25519Priv: old.ed25519Priv, newDid: next.did, newEd25519Pub: next.ed25519Pub, newEd25519Priv: next.ed25519Priv, issuedAt: ISSUED }) } as SuccessorStatement
    const didRes = makeDidResolution({ sodium, store, successorFor: (did) => (did === next.did ? statement : undefined), ...options })
    return { pinStore, store, old, next, statement, didRes }
  }

  it("lets every message without a rotation through to resolveAndPin unchanged", async () => {
    const { pinStore, old, didRes } = await rotated()
    const stranger = mintIdentity()
    for (const did of ["", "did:web:not-a-key", old.did, stranger.did]) {
      expect(await didRes.settleSender({ did, pinStore }), did).toBe(true)
    }
    expect(pinStore.get(stranger.did)).toBeUndefined()
    // A retired pin is refused later, by the receive path; settling it changes nothing.
    pinStore.retire(old.did, stranger.did, ISSUED)
    expect(await didRes.settleSender({ did: old.did, pinStore })).toBe(true)
  })

  it("applies a rotation once and then sees the moved record as settled", async () => {
    const { pinStore, store, next, didRes } = await rotated()
    const events = vi.spyOn(nerves, "emitNervesEvent")
    expect(await didRes.settleSender({ did: next.did, pinStore })).toBe(true)
    expect((await findFriendByDid(store, next.did))?.trustLevel).toBe("family")
    events.mockClear()
    expect(await didRes.settleSender({ did: next.did, pinStore })).toBe(true)
    expect(events.mock.calls.map(([event]) => event.event)).not.toContain("channel.a2a_rotation_record_retry")
    events.mockRestore()
  })

  it("does not look for a stranded record without a friend store or a pin store that can follow the chain back", async () => {
    const { pinStore, store, next, statement } = await rotated()
    await upsertAgentPeer(store, { name: "Squatter", agentId: next.did, trustLevel: "stranger", a2a: { did: next.did, agentId: next.did, endpointUrl: "https://other.example/a2a" } })
    const didRes = makeDidResolution({ sodium, store, successorFor: () => statement })
    expect(await didRes.settleSender({ did: next.did, pinStore })).toBe(false)
    expect(await makeDidResolution({ sodium }).settleSender({ did: next.did, pinStore })).toBe(true)
    const memory = new MemoryPinStore()
    memory.set(next.did, pinStore.get(next.did)!)
    expect(await didRes.settleSender({ did: next.did, pinStore: memory })).toBe(true)
  })

  it("names the generic fix when no other record holds the new DID, and logs a notice it could not send", async () => {
    const { store, old, next } = await rotated()
    // A chain the pin store claims but never retired: the move fails with rotation_not_accepted.
    const pinStore = new MemoryPinStore() as MemoryPinStore & { predecessorOf(did: string): string | undefined }
    pinStore.set(old.did, { did: old.did, ed25519Pub: old.ed25519Pub })
    pinStore.set(next.did, { did: next.did, ed25519Pub: next.ed25519Pub, rotatedAt: ISSUED })
    pinStore.predecessorOf = (did) => (did === next.did ? old.did : undefined)
    const peer = (await store.findByExternalId("a2a-agent", old.did))!
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const notifyOwner = vi.fn(async (_notice: OwnerNotice) => { throw new Error("telegram down") })
    const didRes = makeDidResolution({ sodium, store, notifyOwner })
    expect(await didRes.settleSender({ did: next.did, pinStore })).toBe(false)
    expect(notifyOwner.mock.calls[0]![0].text).toBe([
      `Peer changed its A2A key to ${next.did}, but its friend record could not move to the new key, so this agent refuses its messages until this is fixed.`,
      "The record could not move because this agent's saved keys do not show the change cleanly. Link the record to the new key. Run:",
      `ouro friend link <agent> --friend ${peer.id} --provider a2a-agent --external-id ${next.did}`,
      "Peer's next message then moves the record.",
    ].join("\n\n"))
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: "channel.a2a_rotation_notice_failed", meta: expect.objectContaining({ error: "telegram down" }) })))
    // A channel that fails with something other than an Error is logged too.
    expect(await makeDidResolution({ sodium, store, notifyOwner: () => Promise.reject("offline") }).settleSender({ did: next.did, pinStore })).toBe(false)
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: "channel.a2a_rotation_notice_failed", meta: expect.objectContaining({ error: "offline" }) })))
    // Without an owner channel only nerves records it.
    expect(await makeDidResolution({ sodium, store }).settleSender({ did: next.did, pinStore })).toBe(false)
    events.mockRestore()
  })

  it("follows a rotation chain back at most 16 hops", async () => {
    const { store, next } = await rotated()
    const pinStore = new MemoryPinStore() as MemoryPinStore & { predecessorOf(did: string): string | undefined }
    pinStore.set(next.did, { did: next.did, ed25519Pub: next.ed25519Pub, rotatedAt: ISSUED })
    pinStore.predecessorOf = vi.fn(() => "did:key:zLoop")
    expect(await makeDidResolution({ sodium, store }).settleSender({ did: next.did, pinStore })).toBe(true)
    expect(pinStore.predecessorOf).toHaveBeenCalledTimes(17)
  })
})

describe("FileA2APinStore.predecessorOf", () => {
  it("names the DID whose retired pin points at a successor", () => {
    const pinStore = newPinStore()
    const a = mintIdentity()
    const b = mintIdentity()
    pinStore.set(a.did, { did: a.did, ed25519Pub: a.ed25519Pub })
    expect(pinStore.predecessorOf(b.did)).toBeUndefined()
    pinStore.retire(a.did, b.did, "2026-11-06T10:00:00.000Z")
    expect(pinStore.predecessorOf(b.did)).toBe(a.did)
  })
})
