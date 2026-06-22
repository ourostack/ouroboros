import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  signSuccessor,
  type DidKeyIdentity,
  type PinStore,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2APinStore } from "../../a2a/pin-store"
import { makeDidResolution } from "../../a2a/did-resolution"

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

/**
 * `resolveAndPin` is the verify-and-pin core the inbound bridge consumes. The pin
 * is keyed by the stable `fromAgentId` (NOT the did:key string), so a rotation is
 * "same fromAgentId, new (did, key)". The rotation proof is a HOST-owned channel
 * (`rotationProofFor`) because the friends `resolveAndPin` interface carries no
 * proof field; in the production receiveShare wire there is no proof (over-the-wire
 * rotation-accept is a documented follow-up). These isolated tests inject a
 * `signSuccessor`-minted proof to cover the accept branch.
 */
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

  it("rotation, signed successor, family trust: evaluateRotation accepts → returns the NEW key", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const fromAgentId = "stable-peer-family"

    // The host's rotation-proof channel: the OLD private key signs the successor.
    const didRes = makeDidResolution({
      sodium,
      rotationProofFor: (peer, newDid, newKey) => {
        if (peer !== fromAgentId) return undefined
        return signSuccessor({ sodium, oldEd25519Priv: old.ed25519Priv, newDid, newEd25519Pub: newKey })
      },
    })

    // First contact pins the OLD identity under the stable fromAgentId.
    await didRes.resolveAndPin({ fromAgentId, did: old.did, pinStore, trustOfSource: "family" })
    // Now present the NEW did:key under the SAME fromAgentId → signed rotation.
    const out = await didRes.resolveAndPin({ fromAgentId, did: next.did, pinStore, trustOfSource: "family" })

    expect(out).not.toBeNull()
    expect(Buffer.from(out!.ed25519Pub).equals(Buffer.from(next.ed25519Pub))).toBe(true)
    // evaluateRotation re-pinned to the new key under the same fromAgentId.
    expect(pinStore.get(fromAgentId)?.did).toBe(next.did)
  })

  it("rotation, signed successor, friend trust: accepted → returns the NEW key", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const fromAgentId = "stable-peer-friend"
    const didRes = makeDidResolution({
      sodium,
      rotationProofFor: (_peer, newDid, newKey) =>
        signSuccessor({ sodium, oldEd25519Priv: old.ed25519Priv, newDid, newEd25519Pub: newKey }),
    })
    await didRes.resolveAndPin({ fromAgentId, did: old.did, pinStore, trustOfSource: "friend" })
    const out = await didRes.resolveAndPin({ fromAgentId, did: next.did, pinStore, trustOfSource: "friend" })
    expect(out).not.toBeNull()
    expect(Buffer.from(out!.ed25519Pub).equals(Buffer.from(next.ed25519Pub))).toBe(true)
  })

  it("rotation, signed successor, acquaintance trust: hard-reject (null)", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const fromAgentId = "stable-peer-acq"
    // Even WITH a valid proof, acquaintance never auto-accepts a rotation.
    const didRes = makeDidResolution({
      sodium,
      rotationProofFor: (_peer, newDid, newKey) =>
        signSuccessor({ sodium, oldEd25519Priv: old.ed25519Priv, newDid, newEd25519Pub: newKey }),
    })
    await didRes.resolveAndPin({ fromAgentId, did: old.did, pinStore, trustOfSource: "acquaintance" })
    const out = await didRes.resolveAndPin({ fromAgentId, did: next.did, pinStore, trustOfSource: "acquaintance" })
    expect(out).toBeNull()
  })

  it("rotation, signed successor, stranger trust: hard-reject (null)", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const fromAgentId = "stable-peer-stranger"
    const didRes = makeDidResolution({
      sodium,
      rotationProofFor: (_peer, newDid, newKey) =>
        signSuccessor({ sodium, oldEd25519Priv: old.ed25519Priv, newDid, newEd25519Pub: newKey }),
    })
    await didRes.resolveAndPin({ fromAgentId, did: old.did, pinStore, trustOfSource: "stranger" })
    const out = await didRes.resolveAndPin({ fromAgentId, did: next.did, pinStore, trustOfSource: "stranger" })
    expect(out).toBeNull()
  })

  it("rotation, UNSIGNED successor (family): rejected → null (production proofless wire)", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const fromAgentId = "stable-peer-unsigned"
    // No rotationProofFor → the host channel yields no proof (the production case).
    const didRes = makeDidResolution({ sodium })
    await didRes.resolveAndPin({ fromAgentId, did: old.did, pinStore, trustOfSource: "family" })
    const out = await didRes.resolveAndPin({ fromAgentId, did: next.did, pinStore, trustOfSource: "family" })
    expect(out).toBeNull()
  })

  it("rotation, BAD successor proof (family): rejected → null", async () => {
    const pinStore = newPinStore()
    const old = mintIdentity()
    const next = mintIdentity()
    const fromAgentId = "stable-peer-badproof"
    // A garbage proof string → evaluateRotation rejects (bad_rotation_proof).
    const didRes = makeDidResolution({
      sodium,
      rotationProofFor: () => "not-a-valid-base64-signature!!!",
    })
    await didRes.resolveAndPin({ fromAgentId, did: old.did, pinStore, trustOfSource: "family" })
    const out = await didRes.resolveAndPin({ fromAgentId, did: next.did, pinStore, trustOfSource: "family" })
    expect(out).toBeNull()
  })
})
