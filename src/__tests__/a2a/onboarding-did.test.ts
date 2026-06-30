import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, findFriendByDid } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { buildA2AAgentCard } from "../../a2a/card"
import { onboardA2APeer } from "../../a2a/onboarding"
import type { A2AAgentCard } from "../../a2a/types"

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

/** A card that serves a did:key (the DID-keyed onboarding path). */
function cardWithDid(did: string, baseUrl = "https://remote.example"): A2AAgentCard {
  return buildA2AAgentCard({ agentName: "remote-agent", baseUrl, did })
}

function fetchReturning(card: A2AAgentCard): typeof fetch {
  return (async () => new Response(JSON.stringify(card), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch
}

describe("DID-keyed A2A onboarding (the footgun fix)", () => {
  it("keys the agent-peer record on the verified DID (not the card URL)", async () => {
    tmp = createTmpBundle({ agentName: "onboard-did-keyed" })
    const peer = mintIdentity()
    const card = cardWithDid(peer.did)

    const record = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "family",
      fetchImpl: fetchReturning(card),
    })

    // The externalId is the DID string — NOT the card URL.
    const a2aExternal = record.externalIds.find((id) => id.provider === "a2a-agent")
    expect(a2aExternal?.externalId).toBe(peer.did)
    expect(a2aExternal?.externalId.startsWith("did:key:")).toBe(true)
    // The durable identity DID is stored on the record (a2a.did round-trips through
    // FileFriendStore; identity.did is dropped by normalizeAgentMeta so a2a.did is
    // the persisted home).
    expect(record.agentMeta?.a2a?.did).toBe(peer.did)
    // Transport coords still stored for resolveA2AEndpoint.
    expect(record.agentMeta?.a2a?.cardUrl).toBe("https://remote.example/.well-known/agent-card.json")
    expect(record.agentMeta?.a2a?.endpointUrl).toBe("https://remote.example/a2a")
  })

  it("the record is findable by its verified DID via findFriendByDid", async () => {
    tmp = createTmpBundle({ agentName: "onboard-did-findable" })
    const peer = mintIdentity()
    const card = cardWithDid(peer.did)

    await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "family",
      fetchImpl: fetchReturning(card),
    })

    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const found = await findFriendByDid(store, peer.did)
    expect(found).not.toBeNull()
    expect(found?.trustLevel).toBe("family")
    expect(found?.agentMeta?.a2a?.did).toBe(peer.did)
  })

  it("refuses a card whose served did:key is malformed/unparseable (no record written)", async () => {
    tmp = createTmpBundle({ agentName: "onboard-did-binding-fail" })
    const peer = mintIdentity()
    // For did:key, verifyCardDidBinding only checks `card.did === did` (self-contained),
    // so the genuine refusal case is a card serving a DID that can never key/verify an
    // inbound envelope: a malformed did:key (parseDidKey returns null). Onboarding it
    // would silently break the later inbound resolve, so it is refused at link time.
    const card = { ...cardWithDid(peer.did), did: "did:key:not-a-real-key" }

    await expect(onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "family",
      fetchImpl: fetchReturning(card as A2AAgentCard),
    })).rejects.toThrow(/binding/i)

    // No record was written.
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const all = store.listAll ? await store.listAll.call(store) : []
    expect(all).toHaveLength(0)
    // And it is NOT findable by the claimed DID.
    const found = await findFriendByDid(store, peer.did)
    expect(found).toBeNull()
  })

  it("a legacy card with NO did keeps the URL-keyed behavior (backward compatible)", async () => {
    tmp = createTmpBundle({ agentName: "onboard-legacy-url" })
    const card = buildA2AAgentCard({ agentName: "legacy-agent", baseUrl: "https://legacy.example" })
    expect(card.did).toBeUndefined()

    const record = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      cardUrl: "https://legacy.example/.well-known/agent-card.json",
      trustLevel: "friend",
      fetchImpl: fetchReturning(card),
    })

    // No DID on the card → externalId is the card URL (unchanged legacy behavior).
    const a2aExternal = record.externalIds.find((id) => id.provider === "a2a-agent")
    expect(a2aExternal?.externalId).toBe("https://legacy.example/.well-known/agent-card.json")
    expect(record.agentMeta?.a2a?.did).toBeUndefined()
  })

  it("re-onboarding the same DID updates the same record (idempotent on DID)", async () => {
    tmp = createTmpBundle({ agentName: "onboard-did-idempotent" })
    const peer = mintIdentity()
    const card = cardWithDid(peer.did)
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)

    const first = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      store,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "friend",
      fetchImpl: fetchReturning(card),
    })

    const second = await onboardA2APeer({
      agentName: tmp.agentName,
      bundlesRoot: tmp.bundlesRoot,
      store,
      cardUrl: "https://remote.example/.well-known/agent-card.json",
      trustLevel: "family",
      name: "Renamed Peer",
      fetchImpl: fetchReturning(card),
    })

    expect(second.id).toBe(first.id)
    expect(second.name).toBe("Renamed Peer")
    expect(second.trustLevel).toBe("family")
    const all = await store.listAll!.call(store)
    expect(all).toHaveLength(1)
  })
})
