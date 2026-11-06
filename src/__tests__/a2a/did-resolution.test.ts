import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  signFullSuccessor,
  type DidKeyIdentity,
  type PinStore,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2APinStore } from "../../a2a/pin-store"
import { FileFriendStore, findFriendByDid, upsertAgentPeer } from "@ouro.bot/friends"
import { makeDidResolution, type SuccessorStatement } from "../../a2a/did-resolution"

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
