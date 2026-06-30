import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  sealEnvelope,
  wrapInDataPart,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, FileMissionStore, missionsDirFor, findFriendByDid, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import { FileA2APinStore } from "../../a2a/pin-store"
import { FileA2ASeenLedger } from "../../a2a/seen-ledger"
import { makeDidResolution } from "../../a2a/did-resolution"
import { receiveInboundShare, type InboundShareDeps } from "../../a2a/inbound-share"
import type { A2AIdentity } from "../../a2a/identity"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AMessage } from "../../a2a/types"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let ownServer: A2AServerHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  if (ownServer) {
    await ownServer.close()
    ownServer = null
  }
  tmp?.cleanup()
  tmp = null
})

function tool(name: string) {
  const def = a2aToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def.handler
}

function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function asSelf(id: DidKeyIdentity): A2AIdentity {
  return { ...id, seed: "test-seed" }
}

type CtxFriendStore = NonNullable<ToolContext["friendStore"]>

function localCtx(opts: { agentRoot: string; store: CtxFriendStore }): ToolContext {
  const requester: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", role: "human", kind: "human",
    agentMeta: { bundleName: "owner", familiarity: 0, sharedMissions: [], outcomes: [] },
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
  }
  const senseType: SenseType = "local"
  return {
    signin: async () => undefined,
    agentRoot: opts.agentRoot,
    friendStore: opts.store,
    context: {
      friend: requester,
      channel: {
        channel: "cli", senseType,
        availableIntegrations: [], supportsMarkdown: false, supportsStreaming: false,
        supportsRichCards: false, maxMessageLength: Infinity,
      },
    },
  }
}

/** Seal a coordination envelope FROM self TO self (the owner's own agent messaging
 * its own A2A endpoint). */
function sealedFromSelfToSelf(self: DidKeyIdentity): A2AMessage {
  const envelope: Record<string, unknown> = {
    subject: { missionKey: "own-mission", title: "Own mission" },
    fromAgentId: self.did,
    intent: "request",
    note: "self-check",
  }
  const sealed = sealEnvelope({
    sodium,
    envelope,
    friendsKind: "coordination",
    fromIdentity: { did: self.did, keyId: self.keyId, ed25519Priv: self.ed25519Priv },
    recipientDid: self.did,
    recipientX25519Pub: self.x25519Pub,
  })
  return wrapInDataPart({ sealedEnvelope: sealed, recipientDid: self.did }) as unknown as A2AMessage
}

function bridgeDeps(agentRoot: string, store: CtxFriendStore, self: DidKeyIdentity): InboundShareDeps {
  return {
    sodium,
    store: store as FileFriendStore,
    missionStore: new FileMissionStore(missionsDirFor(`${agentRoot}/friends`)),
    pinStore: new FileA2APinStore(agentRoot),
    seen: new FileA2ASeenLedger(agentRoot),
    didResolution: makeDidResolution({ sodium }),
    identity: asSelf(self),
  }
}

describe("TOP FOOTGUN: the owner's own agent must NOT resolve to stranger", () => {
  it("connect_to the owner's own agent → its externalId == its DID == the inbound verified DID, at family", async () => {
    tmp = createTmpBundle({ agentName: "footgun-own" })
    const self = mintIdentity()

    // The owner's own agent serves its DID-bearing card.
    ownServer = await startA2AServer({
      agentName: "footgun-own",
      agentRoot: tmp.agentRoot,
      port: 0,
      identity: asSelf(self),
      turnRunner: async ({ message }) => ({ response: `self:${message}` }),
    })
    const cardUrl = `${ownServer.url}/.well-known/agent-card.json`
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const ctx = localCtx({ agentRoot: tmp.agentRoot, store })

    // connect_to the owner's OWN agent from the local sense.
    const out = await tool("connect_to")({ card_url: cardUrl }, ctx)
    expect(out).toMatch(/connected/i)

    // (1) The stored record keys on the DID — the externalId IS the DID, not the URL.
    const record = await findFriendByDid(store, self.did)
    expect(record).not.toBeNull()
    expect(record?.trustLevel).toBe("family")
    const a2aExternal = record?.externalIds.find((id) => id.provider === "a2a-agent")
    expect(a2aExternal?.externalId).toBe(self.did)

    // (2) An inbound sealed envelope FROM that same agent (its DID) resolves to the
    //     SAME record at family — it does NOT refuse itself, does NOT become stranger.
    const inbound = sealedFromSelfToSelf(self)
    const bridged = await receiveInboundShare(inbound, bridgeDeps(tmp.agentRoot, store, self))
    expect(bridged.outcome).toBe("completed")
    if (bridged.outcome === "completed") {
      expect(bridged.verifiedDid).toBe(self.did)
      // THE FOOTGUN ASSERTION: family, NOT stranger. A URL-vs-DID keying regression
      // would store the record under the card URL, so findFriendByDid(self.did) inside
      // the bridge would miss → trust defaults to stranger → this fails.
      expect(bridged.trust).toBe("family")
    }
  })

  it("hardening: a URL-keyed record (the OLD footgun) makes the owner's own agent REFUSE itself", async () => {
    // This is the negative control that proves the assertion above is load-bearing:
    // if the owner's own agent were onboarded the OLD way (URL-keyed, no a2a.did), the
    // inbound resolve-by-DID misses → trust = stranger → receiveShare's default
    // minTrustToAccept (acquaintance) REFUSES it (untrusted_source). I.e. the old
    // keying makes the agent refuse its OWN messages — exactly the footgun the DID
    // re-key fixes.
    tmp = createTmpBundle({ agentName: "footgun-url-regression" })
    const self = mintIdentity()
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    // Simulate the OLD URL-keyed record: externalId = a URL, NO a2a.did.
    await store.put("url-keyed", {
      id: "url-keyed", name: "Self (URL-keyed)", trustLevel: "family", role: "agent-peer", kind: "agent",
      agentMeta: {
        bundleName: "self", familiarity: 0, sharedMissions: [], outcomes: [],
        a2a: { cardUrl: "https://self.example/card", endpointUrl: "https://self.example/a2a", agentId: "https://self.example/card" },
      },
      externalIds: [{ provider: "a2a-agent", externalId: "https://self.example/card", linkedAt: new Date().toISOString() }],
      tenantMemberships: [], toolPreferences: {}, notes: {},
      totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
    })

    const inbound = sealedFromSelfToSelf(self)
    const bridged = await receiveInboundShare(inbound, bridgeDeps(tmp.agentRoot, store, self))
    // The URL-keyed record is NOT findable by DID → trust = stranger → the importer
    // refuses a stranger source (untrusted_source). The agent refuses its OWN agent.
    // This is exactly the bug the DID-keying fixes; the first test asserts the fix holds.
    expect(bridged.outcome).toBe("rejected")
    if (bridged.outcome === "rejected") {
      expect(bridged.reason).toBe("untrusted_source")
    }
  })
})
