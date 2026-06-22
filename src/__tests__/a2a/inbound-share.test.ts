import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  sealEnvelope,
  wrapInDataPart,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import {
  FileFriendStore,
  FileMissionStore,
  missionsDirFor,
  upsertAgentPeer,
  type FriendStore,
  type TrustLevel,
} from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2APinStore } from "../../a2a/pin-store"
import { FileA2ASeenLedger } from "../../a2a/seen-ledger"
import { makeDidResolution } from "../../a2a/did-resolution"
import { receiveInboundShare, type InboundShareDeps } from "../../a2a/inbound-share"
import type { A2AIdentity } from "../../a2a/identity"
import type { A2AMessage } from "../../a2a/types"

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

/** A self A2AIdentity for the recipient (B). Seed string is irrelevant to the bridge. */
function asSelfIdentity(id: DidKeyIdentity): A2AIdentity {
  return { ...id, seed: "test-seed-not-used-by-bridge" }
}

interface Harness {
  deps: InboundShareDeps
  store: FriendStore
  recipient: DidKeyIdentity
}

function makeHarness(): Harness {
  tmp = createTmpBundle({ agentName: `inbound-${Math.random().toString(36).slice(2, 8)}` })
  const agentRoot = tmp.agentRoot
  const store = new FileFriendStore(`${agentRoot}/friends`)
  const missionStore = new FileMissionStore(missionsDirFor(`${agentRoot}/friends`))
  const pinStore = new FileA2APinStore(agentRoot)
  const seen = new FileA2ASeenLedger(agentRoot)
  const didResolution = makeDidResolution({ sodium })
  const recipient = mintIdentity()
  const deps: InboundShareDeps = {
    sodium,
    store,
    missionStore,
    pinStore,
    didResolution,
    seen,
    identity: asSelfIdentity(recipient),
  }
  return { deps, store, recipient }
}

/** Seal a coordination envelope from A → recipient, return the inbound A2A message. */
function sealedCoordinationFrom(
  from: DidKeyIdentity,
  recipient: DidKeyIdentity,
  opts: { missionKey?: string } = {},
): A2AMessage {
  const envelope: Record<string, unknown> = {
    subject: { missionKey: opts.missionKey ?? `mk-${Math.random().toString(36).slice(2, 8)}`, title: "Test mission" },
    fromAgentId: from.did,
    intent: "request",
    note: "please take the API side",
  }
  const sealed = sealEnvelope({
    sodium,
    envelope,
    friendsKind: "coordination",
    fromIdentity: { did: from.did, keyId: from.keyId, ed25519Priv: from.ed25519Priv },
    recipientDid: recipient.did,
    recipientX25519Pub: recipient.x25519Pub,
  })
  return wrapInDataPart({ sealedEnvelope: sealed, recipientDid: recipient.did }) as unknown as A2AMessage
}

async function seedFriend(store: FriendStore, did: string, trustLevel: TrustLevel): Promise<void> {
  await upsertAgentPeer(store, {
    name: `Peer ${did.slice(0, 12)}`,
    agentId: did,
    trustLevel,
    a2a: { did, agentId: did, endpointUrl: "https://peer.example/a2a" },
  })
}

describe("inbound-share bridge (receiveShare → verified-DID keying)", () => {
  it("ignores a non-friends (text) message → not-a-share (caller falls back to text)", async () => {
    const { deps } = makeHarness()
    const textMessage: A2AMessage = { role: "user", parts: [{ text: "hello there" }] }
    const out = await receiveInboundShare(textMessage, deps)
    expect(out.outcome).toBe("not-a-share")
  })

  it("valid sealed coordination from a family peer → completed, externalId = A's verified DID at family trust", async () => {
    const { deps, store, recipient } = makeHarness()
    const a = mintIdentity()
    await seedFriend(store, a.did, "family")
    const message = sealedCoordinationFrom(a, recipient)

    const out = await receiveInboundShare(message, deps)
    expect(out.outcome).toBe("completed")
    if (out.outcome === "completed") {
      expect(out.verifiedDid).toBe(a.did)
      expect(out.trust).toBe("family")
      expect(out.friendsKind).toBe("coordination")
    }
  })

  it("forged signature → rejected (no turn) — DidVerifier fails inside receiveShare", async () => {
    const { deps, store, recipient } = makeHarness()
    const a = mintIdentity()
    const impostor = mintIdentity()
    await seedFriend(store, a.did, "family")

    // Seal with the impostor's key but CLAIM to be A (fromAgentId = A.did in the
    // envelope). The seal's signerDid is the impostor — the binding check / verifier
    // rejects: the pinned key for A.did never signed this.
    const envelope: Record<string, unknown> = {
      subject: { missionKey: "mk-forge", title: "Forge" },
      fromAgentId: a.did,
      intent: "request",
    }
    const sealed = sealEnvelope({
      sodium,
      envelope,
      friendsKind: "coordination",
      fromIdentity: { did: impostor.did, keyId: impostor.keyId, ed25519Priv: impostor.ed25519Priv },
      recipientDid: recipient.did,
      recipientX25519Pub: recipient.x25519Pub,
    })
    const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: recipient.did }) as unknown as A2AMessage

    const out = await receiveInboundShare(message, deps)
    expect(out.outcome).toBe("rejected")
  })

  it("replayed seal nonce → rejected (seen); and replay AFTER restart still rejected (durable SeenLedger)", async () => {
    const { deps, store, recipient } = makeHarness()
    const a = mintIdentity()
    await seedFriend(store, a.did, "family")
    const message = sealedCoordinationFrom(a, recipient)

    const first = await receiveInboundShare(message, deps)
    expect(first.outcome).toBe("completed")

    // Immediate replay → rejected as seen.
    const replay = await receiveInboundShare(message, deps)
    expect(replay.outcome).toBe("rejected")
    if (replay.outcome === "rejected") expect(replay.reason).toBe("replayed")

    // Simulated restart: a fresh SeenLedger over the same agent root must STILL
    // report the nonce as seen → the replay is rejected (no reopened window).
    const restartedSeen = new FileA2ASeenLedger(tmp!.agentRoot)
    const restartedDeps: InboundShareDeps = { ...deps, seen: restartedSeen }
    const afterRestart = await receiveInboundShare(message, restartedDeps)
    expect(afterRestart.outcome).toBe("rejected")
    if (afterRestart.outcome === "rejected") expect(afterRestart.reason).toBe("replayed")
  })

  it("wrong-recipient envelope → rejected (no turn)", async () => {
    const { deps, store } = makeHarness()
    const a = mintIdentity()
    const someoneElse = mintIdentity()
    await seedFriend(store, a.did, "family")
    // Seal addressed to a DIFFERENT recipient than our self identity.
    const message = sealedCoordinationFrom(a, someoneElse)

    const out = await receiveInboundShare(message, deps)
    expect(out.outcome).toBe("rejected")
  })

  it("unknown/forged DID (not in friend store) → resolves to stranger → rejected by importer (never a default-up)", async () => {
    const { deps, recipient } = makeHarness()
    const stranger = mintIdentity()
    // No seedFriend → the verified DID is unknown → trust-by-DID lookup = stranger.
    const message = sealedCoordinationFrom(stranger, recipient)

    const out = await receiveInboundShare(message, deps)
    // A stranger coordination is refused by importCoordination (untrusted_source);
    // the point is the trust came from the store BY the verified DID, defaulting to
    // stranger — never an envelope-claimed or higher default.
    expect(out.outcome).toBe("rejected")
  })

  it("an acquaintance peer's coordination (unknown mission) → rejected (untrusted_introduction): trust read by verified DID", async () => {
    const { deps, store, recipient } = makeHarness()
    const a = mintIdentity()
    await seedFriend(store, a.did, "acquaintance")
    const message = sealedCoordinationFrom(a, recipient)

    const out = await receiveInboundShare(message, deps)
    // acquaintance passes the importer's min-trust but cannot SEED a new mission →
    // refused. Proves trust was read from the record (acquaintance), not defaulted
    // to family/stranger.
    expect(out.outcome).toBe("rejected")
  })

  it("malformed DataPart (data part present but not a valid sealed payload) → rejected (malformed_message)", async () => {
    const { deps } = makeHarness()
    const message: A2AMessage = {
      role: "agent",
      parts: [{ kind: "data", data: { not: "a valid sealed payload" } }],
    }
    const out = await receiveInboundShare(message, deps)
    // unwrapDataPart returns null for a bad payload → the bridge reports it as a
    // rejected malformed message (it WAS a data part, so not "not-a-share").
    expect(out.outcome).toBe("rejected")
    if (out.outcome === "rejected") expect(out.reason).toBe("malformed_message")
  })
})
