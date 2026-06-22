import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  sealEnvelope,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import {
  FileFriendStore,
  upsertAgentPeer,
  recordMission,
  prepareMissionResult,
  FileGrantStore,
  grantsDirFor,
  type MissionResultEnvelope,
  type TrustLevel,
} from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { delegationStoresFor } from "../../a2a/delegation-stores"
import {
  wrapMissionResultDataPart,
  isMissionResultDataPart,
  receiveInboundMissionResult,
  type InboundResultDeps,
} from "../../a2a/mission-result-wire"
import type { A2AMessage } from "../../a2a/types"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function asSelf(id: DidKeyIdentity): A2AIdentity {
  return { ...id, seed: "seed" }
}

/** Seal a MissionResultEnvelope from B → A and wrap it in the harness-owned
 * mission_result DataPart carrier (NOT the friends FriendsKind wrap). */
function sealedResultFrom(from: DidKeyIdentity, recipient: DidKeyIdentity, envelope: MissionResultEnvelope): A2AMessage {
  const sealed = sealEnvelope({
    sodium,
    envelope: envelope as unknown as Record<string, unknown>,
    // The carrier crypto reuses a FriendsKind for the seal, but the inbound side
    // routes by the ouroKind tag to importMissionResult (NOT receiveShare).
    friendsKind: "coordination",
    fromIdentity: { did: from.did, keyId: from.keyId, ed25519Priv: from.ed25519Priv },
    recipientDid: recipient.did,
    recipientX25519Pub: recipient.x25519Pub,
  })
  return wrapMissionResultDataPart({ sealedEnvelope: sealed, recipientDid: recipient.did }) as unknown as A2AMessage
}

function depsFor(agentRoot: string, recipient: DidKeyIdentity, store: FileFriendStore): InboundResultDeps {
  return {
    sodium,
    store,
    missionStore: delegationStoresFor(agentRoot).missionStore,
    identity: asSelf(recipient),
  }
}

describe("mission_result wire (harness-owned, NOT a FriendsKind)", () => {
  it("wrap → isMissionResultDataPart recognizes it; a plain coordination data part does not", () => {
    const a = mintIdentity()
    const b = mintIdentity()
    const sealed = sealEnvelope({
      sodium, envelope: { x: 1 }, friendsKind: "coordination",
      fromIdentity: { did: a.did, keyId: a.keyId, ed25519Priv: a.ed25519Priv },
      recipientDid: b.did, recipientX25519Pub: b.x25519Pub,
    })
    const resultMsg = wrapMissionResultDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    expect(isMissionResultDataPart(resultMsg as unknown as A2AMessage)).toBe(true)

    // A plain (untagged) data part is NOT recognized as a mission_result.
    const plain: A2AMessage = { role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: sealed.sealed, recipientDid: b.did } }] }
    expect(isMissionResultDataPart(plain)).toBe(false)
    // A text message is not a result part either.
    expect(isMissionResultDataPart({ role: "user", parts: [{ text: "hi" }] })).toBe(false)
  })

  it("happy path: A imports B's result → importedResults[B][requestId] (transport-supplied fromAgentId)", async () => {
    tmp = createTmpBundle({ agentName: "result-happy" })
    const a = mintIdentity() // recipient (delegator)
    const b = mintIdentity() // sender (assignee)
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })

    // A delegated to B first-party: a mission with delegations[req-1].assignee = B.
    const { missionStore, grantStore } = delegationStoresFor(tmp.agentRoot)
    void grantStore
    const m = await recordMission(missionStore, { missionKey: "mk-1", title: "Mission" })
    const now = new Date().toISOString()
    await missionStore.put(m.id, {
      ...m,
      delegations: { "req-1": { task: { requestId: "req-1", summary: "do X" }, assignee: { agentId: b.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })

    // B's result envelope for req-1 (fromAgentId self-asserted; importMissionResult
    // uses the TRANSPORT fromAgentId, which the wire supplies from the signed DID).
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-1", title: "Mission" },
      fromAgentId: b.did, requestId: "req-1",
      result: { requestId: "req-1", summary: "did X", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const message = sealedResultFrom(b, a, envelope)

    const out = await receiveInboundMissionResult(message, depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("imported")

    const reloaded = await delegationStoresFor(tmp.agentRoot).missionStore.findByMissionKey("mk-1")
    expect(reloaded?.importedResults?.[b.did]?.["req-1"]?.summary).toBe("did X")
  })

  it("assignee mismatch → assignee_mismatch (a different signer than the recorded assignee), nothing written", async () => {
    tmp = createTmpBundle({ agentName: "result-assignee-mismatch" })
    const a = mintIdentity()
    const b = mintIdentity() // recorded assignee
    const c = mintIdentity() // the actual (wrong) signer
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "C", agentId: c.did, trustLevel: "family", a2a: { did: c.did, agentId: c.did, endpointUrl: "https://c.example/a2a" } })

    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const m = await recordMission(missionStore, { missionKey: "mk-2", title: "M2" })
    await missionStore.put(m.id, {
      ...m,
      delegations: { "req-2": { task: { requestId: "req-2", summary: "do Y" }, assignee: { agentId: b.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })
    // C (not B) signs+sends a result for req-2.
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-2", title: "M2" }, fromAgentId: c.did, requestId: "req-2",
      result: { requestId: "req-2", summary: "C did it", provenance: { assertedBy: { agentId: c.did, displayName: "C" }, assertedAt: now } },
      issuedAt: now,
    }
    const message = sealedResultFrom(c, a, envelope)
    const out = await receiveInboundMissionResult(message, depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("rejected")
    if (out.outcome === "rejected") expect(out.reason).toBe("assignee_mismatch")
    const reloaded = await delegationStoresFor(tmp.agentRoot).missionStore.findByMissionKey("mk-2")
    expect(reloaded?.importedResults).toBeUndefined()
  })

  it("correlation mismatch (unknown requestId) → no_delegation", async () => {
    tmp = createTmpBundle({ agentName: "result-no-delegation" })
    const a = mintIdentity()
    const b = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    await recordMission(missionStore, { missionKey: "mk-3", title: "M3" }) // no delegations
    const now = new Date().toISOString()
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-3", title: "M3" }, fromAgentId: b.did, requestId: "never-delegated",
      result: { requestId: "never-delegated", summary: "x", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const out = await receiveInboundMissionResult(sealedResultFrom(b, a, envelope), depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("rejected")
    if (out.outcome === "rejected") expect(out.reason).toBe("no_delegation")
  })

  it("unknown mission → no_mission", async () => {
    tmp = createTmpBundle({ agentName: "result-no-mission" })
    const a = mintIdentity()
    const b = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })
    const now = new Date().toISOString()
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "absent", title: "Absent" }, fromAgentId: b.did, requestId: "r",
      result: { requestId: "r", summary: "x", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const out = await receiveInboundMissionResult(sealedResultFrom(b, a, envelope), depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("rejected")
    if (out.outcome === "rejected") expect(out.reason).toBe("no_mission")
  })

  it("untrusted source (stranger) → untrusted_source", async () => {
    tmp = createTmpBundle({ agentName: "result-stranger" })
    const a = mintIdentity()
    const stranger = mintIdentity() // not in A's store → stranger
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const m = await recordMission(missionStore, { missionKey: "mk-s", title: "Ms" })
    await missionStore.put(m.id, {
      ...m,
      delegations: { "req-s": { task: { requestId: "req-s", summary: "x" }, assignee: { agentId: stranger.did, displayName: "S" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-s", title: "Ms" }, fromAgentId: stranger.did, requestId: "req-s",
      result: { requestId: "req-s", summary: "x", provenance: { assertedBy: { agentId: stranger.did, displayName: "S" }, assertedAt: now } },
      issuedAt: now,
    }
    const out = await receiveInboundMissionResult(sealedResultFrom(stranger, a, envelope), depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("rejected")
    if (out.outcome === "rejected") expect(out.reason).toBe("untrusted_source")
  })

  it("legacy assignee-less delegation → fails closed (assignee_mismatch)", async () => {
    tmp = createTmpBundle({ agentName: "result-legacy-assigneeless" })
    const a = mintIdentity()
    const b = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const m = await recordMission(missionStore, { missionKey: "mk-legacy", title: "Legacy" })
    // A delegation with NO recorded assignee (legacy shape).
    await missionStore.put(m.id, {
      ...m,
      delegations: { "req-l": { task: { requestId: "req-l", summary: "x" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-legacy", title: "Legacy" }, fromAgentId: b.did, requestId: "req-l",
      result: { requestId: "req-l", summary: "x", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const out = await receiveInboundMissionResult(sealedResultFrom(b, a, envelope), depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("rejected")
    if (out.outcome === "rejected") expect(out.reason).toBe("assignee_mismatch")
  })

  it("replay idempotency: importing the same result twice does not double-land", async () => {
    tmp = createTmpBundle({ agentName: "result-replay" })
    const a = mintIdentity()
    const b = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const m = await recordMission(missionStore, { missionKey: "mk-r", title: "Mr" })
    await missionStore.put(m.id, {
      ...m,
      delegations: { "req-r": { task: { requestId: "req-r", summary: "x" }, assignee: { agentId: b.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-r", title: "Mr" }, fromAgentId: b.did, requestId: "req-r",
      result: { requestId: "req-r", summary: "v1", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const first = await receiveInboundMissionResult(sealedResultFrom(b, a, envelope), depsFor(tmp.agentRoot, a, aStore))
    expect(first.outcome).toBe("imported")
    const second = await receiveInboundMissionResult(sealedResultFrom(b, a, envelope), depsFor(tmp.agentRoot, a, aStore))
    expect(second.outcome).toBe("imported")
    const reloaded = await delegationStoresFor(tmp.agentRoot).missionStore.findByMissionKey("mk-r")
    // Still exactly one result under B/req-r (deduped on replay).
    expect(Object.keys(reloaded?.importedResults?.[b.did] ?? {})).toEqual(["req-r"])
  })

  it("a wrong-recipient sealed result → rejected (unseal/recipient mismatch)", async () => {
    tmp = createTmpBundle({ agentName: "result-wrong-recipient" })
    const a = mintIdentity()
    const b = mintIdentity()
    const other = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })
    const now = new Date().toISOString()
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-w", title: "Mw" }, fromAgentId: b.did, requestId: "req-w",
      result: { requestId: "req-w", summary: "x", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    // Sealed to `other`, not A → A cannot unseal.
    const message = sealedResultFrom(b, other, envelope)
    const out = await receiveInboundMissionResult(message, depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("rejected")
  })

  it("a non-result data part is ignored by the result wire (not-a-result)", async () => {
    tmp = createTmpBundle({ agentName: "result-not-a-result" })
    const a = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const textMsg: A2AMessage = { role: "user", parts: [{ text: "hello" }] }
    const out = await receiveInboundMissionResult(textMsg, depsFor(tmp.agentRoot, a, aStore))
    expect(out.outcome).toBe("not-a-result")
  })
})
