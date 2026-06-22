import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle, type A2ATurnRunnerInput } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmpA: TmpBundleHandle | null = null
let tmpB: TmpBundleHandle | null = null
let serverA: A2AServerHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  if (serverA) {
    await serverA.close()
    serverA = null
  }
  tmpA?.cleanup(); tmpA = null
  tmpB?.cleanup(); tmpB = null
})

function tool(name: string) {
  const def = a2aToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def.handler
}

function seededIdentity(): { id: DidKeyIdentity; seed: string } {
  const seedBytes = sodium.randombytes_buf(32)
  const kp = sodium.crypto_sign_seed_keypair(seedBytes)
  return { id: didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey }), seed: Buffer.from(seedBytes).toString("base64url") }
}

function asSelf(id: DidKeyIdentity, seed: string): A2AIdentity {
  return { ...id, seed }
}

type CtxFriendStore = NonNullable<ToolContext["friendStore"]>

function localCtx(agentRoot: string, store: CtxFriendStore): ToolContext {
  const requester: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", role: "human", kind: "human",
    agentMeta: { bundleName: "owner", familiarity: 0, sharedMissions: [], outcomes: [] },
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
  }
  const senseType: SenseType = "local"
  return {
    signin: async () => undefined,
    agentRoot,
    friendStore: store,
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

describe("Slice-3 round-trip: B a2a_send_message → A inbound verifies B's DID (sealed, direct, no relay)", () => {
  it("the sealed message lands at A and A's turn is keyed on B's verified DID at B's trust", async () => {
    // A: the recipient. Real server with identity (DID card + inbound bridge).
    tmpA = createTmpBundle({ agentName: "slice3-A" })
    const a = seededIdentity()
    let aObservedPeer: string | undefined
    serverA = await startA2AServer({
      agentName: "slice3-A",
      agentRoot: tmpA.agentRoot,
      port: 0,
      identity: asSelf(a.id, a.seed),
      turnRunner: async ({ peerAgentId }: A2ATurnRunnerInput) => {
        aObservedPeer = peerAgentId
        return { response: "got it" }
      },
    })
    // A trusts B (family) — keyed on B's DID, so the inbound resolve finds it.
    const aStore = new FileFriendStore(`${tmpA.agentRoot}/friends`)

    // B: the sender. Its own identity is seeded into B's machine config.
    tmpB = createTmpBundle({ agentName: "slice3-B" })
    const b = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpB.agentName, { a2a: { identity: { ed25519Seed: b.seed } } })
    await upsertAgentPeer(aStore, {
      name: "Agent B", agentId: b.id.did, trustLevel: "family",
      a2a: { did: b.id.did, agentId: b.id.did, endpointUrl: "https://b.example/a2a" },
    })

    // B's view of A: a DID-keyed peer pointing at A's real endpoint.
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)
    await upsertAgentPeer(bStore, {
      name: "Agent A", agentId: a.id.did, trustLevel: "family",
      a2a: { did: a.id.did, agentId: a.id.did, endpointUrl: serverA.endpointUrl },
    })
    const aRecord = await bStore.findByExternalId("a2a-agent", a.id.did)

    // B sends a sealed message to A over direct.
    const out = await tool("a2a_send_message")({ friend_id: aRecord!.id, message: "ping from B" }, localCtx(tmpB.agentRoot, bStore))
    expect(out).toMatch(/sealed message delivered/i)

    // A verified B's DID and keyed its turn on it — NOT the unauthenticated sentinel.
    expect(aObservedPeer).toBe(b.id.did)
    expect(aObservedPeer).not.toBe("unauthenticated-a2a-peer")
  })

  it("an UNTRUSTED sender's sealed message is refused at A (stranger → untrusted_source), no turn", async () => {
    tmpA = createTmpBundle({ agentName: "slice3-A-refuse" })
    const a = seededIdentity()
    let turnRan = false
    serverA = await startA2AServer({
      agentName: "slice3-A-refuse",
      agentRoot: tmpA.agentRoot,
      port: 0,
      identity: asSelf(a.id, a.seed),
      turnRunner: async () => { turnRan = true; return { response: "should not run" } },
    })

    // B is NOT seeded into A's store → A resolves B's verified DID to stranger → the
    // importer refuses (untrusted_source). No turn runs.
    tmpB = createTmpBundle({ agentName: "slice3-B-untrusted" })
    const b = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpB.agentName, { a2a: { identity: { ed25519Seed: b.seed } } })
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)
    await upsertAgentPeer(bStore, {
      name: "Agent A", agentId: a.id.did, trustLevel: "family",
      a2a: { did: a.id.did, agentId: a.id.did, endpointUrl: serverA.endpointUrl },
    })
    const aRecord = await bStore.findByExternalId("a2a-agent", a.id.did)

    const out = await tool("a2a_send_message")({ friend_id: aRecord!.id, message: "uninvited" }, localCtx(tmpB.agentRoot, bStore))
    // The sealed send itself succeeds at the transport; A refuses it at import — but
    // a2a_send_message reports the JSON-RPC error A returned (the rejection).
    expect(out).toMatch(/sealed send failed|untrusted_source|rejected/i)
    expect(turnRan).toBe(false)
  })
})
