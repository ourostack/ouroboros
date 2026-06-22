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
  type MissionResultEnvelope,
} from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { delegationStoresFor } from "../../a2a/delegation-stores"
import { FileA2APinStore } from "../../a2a/pin-store"
import { FileA2ASeenLedger } from "../../a2a/seen-ledger"
import { makeDidResolution } from "../../a2a/did-resolution"
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

/**
 * Seal a MissionResultEnvelope and wrap it in the harness-owned `mission_result`
 * DataPart carrier (NOT the friends FriendsKind wrap).
 *
 * `signer` is who actually SIGNS the envelope (the `fromIdentity.ed25519Priv` whose
 * signature the recipient verifies). `envelope.fromAgentId` is who the envelope
 * CLAIMS to be from. For a legit result those are the same identity; the forgery
 * tests deliberately diverge them (a malicious signer claiming a victim's DID).
 */
function sealedResultFrom(signer: DidKeyIdentity, recipient: DidKeyIdentity, envelope: MissionResultEnvelope): A2AMessage {
  const sealed = sealEnvelope({
    sodium,
    envelope: envelope as unknown as Record<string, unknown>,
    // The carrier crypto reuses a FriendsKind for the seal, but the inbound side
    // routes by the ouroKind tag to importMissionResult (NOT receiveShare).
    friendsKind: "coordination",
    fromIdentity: { did: signer.did, keyId: signer.keyId, ed25519Priv: signer.ed25519Priv },
    recipientDid: recipient.did,
    recipientX25519Pub: recipient.x25519Pub,
  })
  return wrapMissionResultDataPart({ sealedEnvelope: sealed, recipientDid: recipient.did }) as unknown as A2AMessage
}

/**
 * The inbound result deps, carrying the SAME authentication seam the share bridge
 * uses (pinStore + seenLedger + didResolution). A single seam instance per agentRoot
 * is reused across calls within a test so the pin/seen state persists (mirrors the
 * real server, which builds one set of stores at startup).
 */
function depsFor(agentRoot: string, recipient: DidKeyIdentity, store: FileFriendStore): InboundResultDeps {
  return {
    sodium,
    store,
    missionStore: delegationStoresFor(agentRoot).missionStore,
    pinStore: new FileA2APinStore(agentRoot),
    seen: new FileA2ASeenLedger(agentRoot),
    didResolution: makeDidResolution({ sodium }),
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

  // ── SECURITY: forged-sender results MUST be rejected (the authentication gate). ──
  // The result wire must AUTHENTICATE the signer exactly like the share path: the
  // envelope's claimed `fromAgentId` is untrusted plaintext until a real DidVerifier
  // confirms the PINNED key for that DID actually signed THIS envelope. A result
  // signed with an attacker's OWN key but CLAIMING the victim assignee's DID must
  // NOT be accepted (and must NOT land under importedResults[victim][...]).

  it("FORGERY: attacker M signs but claims B's DID → REJECTED, nothing written under B", async () => {
    tmp = createTmpBundle({ agentName: "result-forgery-claim-b" })
    const a = mintIdentity() // recipient (delegator)
    const b = mintIdentity() // the real assignee (victim whose DID is claimed)
    const m = mintIdentity() // attacker — signs with its OWN key
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    // A trusts B at family (B is the legitimate assignee). The attacker M is NOT a friend.
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })

    // A delegated req-1 to B (assignee = B), exactly as the happy path.
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const mission = await recordMission(missionStore, { missionKey: "mk-forge", title: "Mission" })
    await missionStore.put(mission.id, {
      ...mission,
      delegations: { "req-1": { task: { requestId: "req-1", summary: "do X" }, assignee: { agentId: b.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })

    // Pre-pin B's REAL key (a prior legitimate contact from B), so the attack cannot
    // succeed merely by being first-contact TOFU. The pin binds B's DID → B's key.
    const deps = depsFor(tmp.agentRoot, a, aStore)
    deps.pinStore.set(b.did, { did: b.did, ed25519Pub: b.ed25519Pub })

    // The forged envelope: it CLAIMS to be from B (fromAgentId = B.did, assertedBy B),
    // but it is SIGNED with M's key. The recipient's X25519 pubkey is public, so M can
    // seal to A with no trouble — AEAD is no barrier. Only signature verification is.
    const forged: MissionResultEnvelope = {
      subject: { missionKey: "mk-forge", title: "Mission" },
      fromAgentId: b.did, requestId: "req-1",
      result: { requestId: "req-1", summary: "MALICIOUS RESULT", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const message = sealedResultFrom(m /* attacker signs */, a, forged)

    const out = await receiveInboundMissionResult(message, deps)
    // MUST be rejected — the signer (M) is not the claimed sender (B).
    expect(out.outcome).toBe("rejected")

    // And NOTHING must be written under B — the forgery did not land as if B delivered it.
    const reloaded = await delegationStoresFor(tmp.agentRoot).missionStore.findByMissionKey("mk-forge")
    expect(reloaded?.importedResults?.[b.did]?.["req-1"]).toBeUndefined()
    expect(reloaded?.importedResults).toBeUndefined()
  })

  it("FORGERY: signature does not verify against the pinned key → REJECTED", async () => {
    tmp = createTmpBundle({ agentName: "result-forgery-bad-sig" })
    const a = mintIdentity()
    const b = mintIdentity() // the real assignee
    const impostor = mintIdentity() // shares B's claimed DID but a DIFFERENT key
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })

    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const mission = await recordMission(missionStore, { missionKey: "mk-badsig", title: "Mission" })
    await missionStore.put(mission.id, {
      ...mission,
      delegations: { "req-1": { task: { requestId: "req-1", summary: "do X" }, assignee: { agentId: b.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })

    // Pin B's REAL key. The inbound envelope will claim B's DID AND set the in-envelope
    // signerDid to B's DID (so the binding check passes), but it is actually signed by
    // an impostor key — so the DidVerifier's signature check against the PINNED key fails.
    const deps = depsFor(tmp.agentRoot, a, aStore)
    deps.pinStore.set(b.did, { did: b.did, ed25519Pub: b.ed25519Pub })

    // Forge an identity that LOOKS like B (same did string) but holds the impostor's key.
    const fakeB: DidKeyIdentity = { ...b, ed25519Priv: impostor.ed25519Priv, ed25519Pub: impostor.ed25519Pub }
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-badsig", title: "Mission" },
      fromAgentId: b.did, requestId: "req-1",
      result: { requestId: "req-1", summary: "x", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    const message = sealedResultFrom(fakeB, a, envelope)

    const out = await receiveInboundMissionResult(message, deps)
    expect(out.outcome).toBe("rejected")
    const reloaded = await delegationStoresFor(tmp.agentRoot).missionStore.findByMissionKey("mk-badsig")
    expect(reloaded?.importedResults).toBeUndefined()
  })

  it("SECURITY: a replayed result (same seal nonce) → REJECTED on the second delivery", async () => {
    tmp = createTmpBundle({ agentName: "result-replay-reject" })
    const a = mintIdentity()
    const b = mintIdentity()
    const aStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.did, trustLevel: "family", a2a: { did: b.did, agentId: b.did, endpointUrl: "https://b.example/a2a" } })
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    const now = new Date().toISOString()
    const mission = await recordMission(missionStore, { missionKey: "mk-replay", title: "Mr" })
    await missionStore.put(mission.id, {
      ...mission,
      delegations: { "req-1": { task: { requestId: "req-1", summary: "x" }, assignee: { agentId: b.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.did, displayName: "A" }, assertedAt: now } } },
    })
    const envelope: MissionResultEnvelope = {
      subject: { missionKey: "mk-replay", title: "Mr" }, fromAgentId: b.did, requestId: "req-1",
      result: { requestId: "req-1", summary: "v1", provenance: { assertedBy: { agentId: b.did, displayName: "B" }, assertedAt: now } },
      issuedAt: now,
    }
    // Build ONE sealed message (a single seal nonce) and deliver it twice through the
    // SAME deps (so the durable seen-ledger persists between deliveries).
    const deps = depsFor(tmp.agentRoot, a, aStore)
    const message = sealedResultFrom(b, a, envelope)
    const first = await receiveInboundMissionResult(message, deps)
    expect(first.outcome).toBe("imported")
    const second = await receiveInboundMissionResult(message, deps)
    expect(second.outcome).toBe("rejected")
    if (second.outcome === "rejected") expect(second.reason).toBe("replayed")
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
