import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  sealEnvelope,
  signFullSuccessor,
  wrapInDataPart,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import {
  FileFriendStore,
  findFriendByDid,
  recordMission,
  upsertAgentPeer,
  type MissionResultEnvelope,
} from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2APinStore } from "../../a2a/pin-store"
import { FileA2ASeenLedger } from "../../a2a/seen-ledger"
import { makeDidResolution, type SuccessorStatement } from "../../a2a/did-resolution"
import { receiveInboundShare, type InboundShareDeps } from "../../a2a/inbound-share"
import { delegationStoresFor } from "../../a2a/delegation-stores"
import { receiveInboundMissionResult, wrapMissionResultDataPart } from "../../a2a/mission-result-wire"
import { mergeFriends } from "../../mind/friend-merge"
import type { A2AMessage } from "../../a2a/types"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
beforeAll(async () => { sodium = await ready() })
afterEach(() => { tmp?.cleanup(); tmp = null })

function mint(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function coordination(from: DidKeyIdentity, to: DidKeyIdentity): A2AMessage {
  const sealed = sealEnvelope({
    sodium,
    envelope: { subject: { missionKey: `mk-${Math.random().toString(36).slice(2, 8)}`, title: "T" }, fromAgentId: from.did, intent: "request", issuedAt: new Date().toISOString() },
    friendsKind: "coordination",
    fromIdentity: { did: from.did, keyId: from.keyId, ed25519Priv: from.ed25519Priv },
    recipientDid: to.did,
    recipientX25519Pub: to.x25519Pub,
  })
  return wrapInDataPart({ sealedEnvelope: sealed, recipientDid: to.did }) as unknown as A2AMessage
}

/**
 * A family peer pinned at `old` that has rotated to `next`. The successor statement reaches this agent through the
 * host channel, and the peer's first message comes from the new DID.
 */
async function rotatedPeer(options: { notifyOwner?: (notice: { noticeId: string; text: string }) => Promise<void> } = {}) {
  tmp = createTmpBundle({ agentName: `rot-recv-${Math.random().toString(36).slice(2, 8)}` })
  const root = tmp.agentRoot
  const store = new FileFriendStore(`${root}/friends`)
  const pinStore = new FileA2APinStore(root)
  const self = mint()
  const old = mint()
  const next = mint()
  await upsertAgentPeer(store, { name: "Peer", agentId: old.did, trustLevel: "family", a2a: { did: old.did, agentId: old.did, endpointUrl: "https://peer.example/a2a" } })
  await makeDidResolution({ sodium }).resolveAndPin({ fromAgentId: old.did, did: old.did, pinStore, trustOfSource: "family" })
  const issuedAt = new Date(Date.now() - 1000).toISOString()
  const statement = { oldDid: old.did, ...signFullSuccessor({ sodium, oldDid: old.did, oldEd25519Priv: old.ed25519Priv, newDid: next.did, newEd25519Pub: next.ed25519Pub, newEd25519Priv: next.ed25519Priv, issuedAt }) } as SuccessorStatement
  const deps: InboundShareDeps = {
    sodium,
    store,
    missionStore: delegationStoresFor(root).missionStore,
    pinStore,
    seen: new FileA2ASeenLedger(root),
    didResolution: makeDidResolution({ sodium, store, agentName: "slugger", successorFor: (did) => (did === next.did ? statement : undefined), ...options }),
    identity: { ...self, seed: "x" },
  }
  return { root, store, pinStore, self, old, next, statement, deps }
}

async function resultFrom(peer: DidKeyIdentity, self: DidKeyIdentity, root: string, assignee: string): Promise<A2AMessage> {
  const { missionStore } = delegationStoresFor(root)
  const issuedAt = new Date().toISOString()
  const missionKey = `mk-${Math.random().toString(36).slice(2, 8)}`
  const mission = await recordMission(missionStore, { missionKey, title: "M" })
  await missionStore.put(mission.id, {
    ...mission,
    delegations: { "req-1": { task: { requestId: "req-1", summary: "x" }, assignee: { agentId: assignee, displayName: "Peer" }, provenance: { assertedBy: { agentId: self.did, displayName: "Self" }, assertedAt: issuedAt } } },
  })
  const envelope: MissionResultEnvelope = {
    subject: { missionKey, title: "M" }, fromAgentId: peer.did, requestId: "req-1",
    result: { requestId: "req-1", summary: "done", provenance: { assertedBy: { agentId: peer.did, displayName: "Peer" }, assertedAt: issuedAt } },
    issuedAt,
  }
  const sealed = sealEnvelope({
    sodium, envelope: envelope as unknown as Record<string, unknown>, friendsKind: "coordination",
    fromIdentity: { did: peer.did, keyId: peer.keyId, ed25519Priv: peer.ed25519Priv },
    recipientDid: self.did, recipientX25519Pub: self.x25519Pub,
  })
  return wrapMissionResultDataPart({ sealedEnvelope: sealed, recipientDid: self.did }) as unknown as A2AMessage
}

/** The rotation is settled before the sender's trust is read, so the first message after it is judged as the moved record. */
describe("a rotated peer's first message (rotation settles before trust is read)", () => {
  it("accepts the first share from the new DID at the moved record's trust", async () => {
    const { deps, store, pinStore, old, next, self } = await rotatedPeer()
    const out = await receiveInboundShare(coordination(next, self), deps)
    expect(out).toMatchObject({ outcome: "completed", verifiedDid: next.did, trust: "family" })
    expect((await findFriendByDid(store, next.did))?.trustLevel).toBe("family")
    expect(pinStore.get(old.did)?.retiredBy).toBe(next.did)
    // The old DID is a tombstone.
    expect(await receiveInboundShare(coordination(old, self), deps)).toMatchObject({ outcome: "rejected", reason: "retired_pin" })
  })

  it("imports the first mission result from the new DID", async () => {
    const { deps, root, next, self } = await rotatedPeer()
    // The task was delegated to the peer's new DID: the delegator learnt it out of band.
    const out = await receiveInboundMissionResult(await resultFrom(next, self, root, next.did), deps)
    expect(out).toEqual({ outcome: "imported", verifiedDid: next.did })
  })

  it("still refuses a share or a result carried by an invalid rotation, without consuming it", async () => {
    const { deps, store, pinStore, root, old, next, self, statement } = await rotatedPeer()
    const broken = makeDidResolution({ sodium, store, successorFor: () => ({ ...statement, rotationProof: "not-a-signature" }) })
    const share = coordination(next, self)
    expect(await receiveInboundShare(share, { ...deps, didResolution: broken })).toEqual({ outcome: "rejected", reason: "resolve_failed" })
    const result = await resultFrom(next, self, root, next.did)
    expect(await receiveInboundMissionResult(result, { ...deps, didResolution: broken })).toEqual({ outcome: "rejected", reason: "resolve_failed" })
    expect(pinStore.get(next.did)).toBeUndefined()
    expect(pinStore.get(old.did)?.retiredBy).toBeUndefined()
    // Nothing was consumed: once the valid statement arrives, the same messages go through.
    expect(await receiveInboundShare(share, deps)).toMatchObject({ outcome: "completed", trust: "family" })
    expect(await receiveInboundMissionResult(result, deps)).toMatchObject({ outcome: "imported" })
  })
})

/**
 * The pins moved but the friend record did not (another record already held the new DID). Each later message from the
 * new DID notices the mismatch and retries the move; while it keeps failing the message is refused and the owner is
 * told once how to fix it.
 */
describe("a rotation whose record could not follow", () => {
  it("refuses, tells the owner once with the fix, and finishes the move once the operator applies it", async () => {
    const notices: Array<{ noticeId: string; text: string }> = []
    const notifyOwner = vi.fn(async (notice: { noticeId: string; text: string }) => { notices.push(notice) })
    const { deps, store, pinStore, root, old, next, self } = await rotatedPeer({ notifyOwner })
    const peer = (await store.findByExternalId("a2a-agent", old.did))!
    await upsertAgentPeer(store, { name: "Squatter", agentId: next.did, trustLevel: "stranger", a2a: { did: next.did, agentId: next.did, endpointUrl: "https://other.example/a2a" } })
    const squatter = (await store.findByExternalId("a2a-agent", next.did))!

    // First message: the rotation verifies and the pins move, but the record cannot follow.
    expect(await receiveInboundShare(coordination(next, self), deps)).toEqual({ outcome: "rejected", reason: "resolve_failed" })
    expect(pinStore.get(old.did)?.retiredBy).toBe(next.did)
    // Next message: the mismatch is detected, the move is retried and fails again; still refused.
    expect(await receiveInboundShare(coordination(next, self), deps)).toEqual({ outcome: "rejected", reason: "resolve_failed" })
    expect(await receiveInboundMissionResult(await resultFrom(next, self, root, next.did), deps)).toEqual({ outcome: "rejected", reason: "resolve_failed" })
    await vi.waitFor(() => expect(notifyOwner).toHaveBeenCalled())
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect(notices[0]!.text).toBe([
      `Peer changed its A2A key to ${next.did}, but its friend record could not move to the new key, so this agent refuses its messages until this is fixed.`,
      `Its new key is already linked to another friend record, Squatter (${squatter.id}). If that is the same peer, merge the two records. Run:`,
      `ouro friend merge --agent slugger --into ${peer.id} ${squatter.id} --apply`,
      "Peer's next message then moves the record.",
    ].join("\n\n"))
    expect(notices[0]!.noticeId).toMatch(/^a2a-rotation-unmoved:/)

    // The operator applies the fix; the next message finishes the move and is accepted at the old record's trust.
    const merged = await mergeFriends({ store, friendsDir: `${root}/friends`, targetId: peer.id, sourceIds: [squatter.id], actor: "test", reason: "same peer" })
    expect(merged.ok).toBe(true)
    const out = await receiveInboundShare(coordination(next, self), deps)
    expect(out).toMatchObject({ outcome: "completed", trust: "family" })
    expect((await store.findByExternalId("a2a-agent", next.did))?.id).toBe(peer.id)
    expect((await findFriendByDid(store, next.did))?.id).toBe(peer.id)
    expect(notifyOwner).toHaveBeenCalledTimes(1)
  })
})
