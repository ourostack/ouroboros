import { describe, expect, it } from "vitest"
import { ready } from "@ouro.bot/friends/a2a-client"
import type { FriendRecord } from "@ouro.bot/friends"
import { friendDid, signResolution, verifyResolution } from "../../a2a/resolution-proof"
import { agentMetaFor, makeTestIdentity } from "../test-helpers/resolution-signing"

const claim = { reportId: "r1", version: "0.1.0", note: "Fixed.", resolvedAt: "2026-10-08T12:00:00.000Z" }

describe("resolution proofs", () => {
  it("accepts the pinned holder's signature and names every way a proof can fail", async () => {
    const sodium = await ready()
    const holder = await makeTestIdentity()
    const other = await makeTestIdentity()
    const proof = signResolution({ sodium, identity: holder, claim })
    expect(verifyResolution({ sodium, claim, proof, holderDid: holder.did })).toEqual({ ok: true })
    expect(verifyResolution({ sodium, claim, proof: undefined, holderDid: holder.did })).toEqual({ ok: false, reason: "no_proof" })
    expect(verifyResolution({ sodium, claim, proof: [], holderDid: holder.did })).toEqual({ ok: false, reason: "no_proof" })
    expect(verifyResolution({ sodium, claim, proof, holderDid: null })).toEqual({ ok: false, reason: "no_holder_did" })
    expect(verifyResolution({ sodium, claim, proof, holderDid: other.did })).toEqual({ ok: false, reason: "wrong_signer" })
    expect(verifyResolution({ sodium, claim, proof, holderDid: "did:key:not-a-key" })).toEqual({ ok: false, reason: "wrong_signer" })
    expect(verifyResolution({ sodium, claim: { ...claim, note: "Changed." }, proof, holderDid: holder.did })).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("reads a friend's DID for pinning, or null when it has none", async () => {
    const holder = await makeTestIdentity()
    const base = { id: "x" } as FriendRecord
    expect(friendDid({ ...base, agentMeta: agentMetaFor(holder) })).toBe(holder.did)
    expect(friendDid(base)).toBeNull()
  })
})
