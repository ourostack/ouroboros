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
let tmp: TmpBundleHandle | null = null
let recipientServer: A2AServerHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  if (recipientServer) {
    await recipientServer.close()
    recipientServer = null
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
  return { ...id, seed: Buffer.from(sodium.randombytes_buf(32)).toString("base64url") }
}

type CtxFriendStore = NonNullable<ToolContext["friendStore"]>

/** A local (owner) sense context for the sender agent. */
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

/** Seed the SENDER's own A2A identity seed into the machine-local config so the tool's
 * seal path can load-or-derive the self identity that signs the sealed envelope. Mints
 * a 32-byte seed FIRST (the durable secret), then derives the did:key from it — the
 * exact load path identity.ts uses — so the seeded config and the returned identity
 * agree. */
function seedSelfIdentity(agentName: string): DidKeyIdentity {
  const seedBytes = sodium.randombytes_buf(32)
  const kp = sodium.crypto_sign_seed_keypair(seedBytes)
  const self = didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
  cacheMachineRuntimeCredentialConfig(agentName, { a2a: { identity: { ed25519Seed: Buffer.from(seedBytes).toString("base64url") } } })
  return self
}

describe("a2a_send_message — sealed via sendShare for DID-keyed peers", () => {
  it("seals to a DID-keyed peer over direct; the recipient verifies the sender's DID", async () => {
    tmp = createTmpBundle({ agentName: "send-sealed-did" })
    // The SENDER's self identity (seeded into machine config; the tool loads it).
    const senderSelf = seedSelfIdentity(tmp.agentName)

    // The recipient B runs a real server with its own identity (serves a DID card +
    // inbound bridge). Capture the peerAgentId its turn is keyed on.
    const recipient = mintIdentity()
    let observedPeer: string | undefined
    recipientServer = await startA2AServer({
      agentName: "recipient",
      agentRoot: tmp.agentRoot,
      port: 0,
      identity: asSelf(recipient),
      turnRunner: async ({ peerAgentId }: A2ATurnRunnerInput) => {
        observedPeer = peerAgentId
        return { response: "ok" }
      },
    })

    // B must trust the SENDER's DID to import its coordination (family).
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(store, {
      name: "Sender", agentId: senderSelf.did, trustLevel: "family",
      a2a: { did: senderSelf.did, agentId: senderSelf.did, endpointUrl: "https://sender.example/a2a" },
    })

    // The sender's view: a DID-keyed peer record for B (its endpoint + DID).
    await upsertAgentPeer(store, {
      name: "Recipient", agentId: recipient.did, trustLevel: "family",
      a2a: { did: recipient.did, agentId: recipient.did, endpointUrl: recipientServer.endpointUrl },
    })
    const bRecord = await store.findByExternalId("a2a-agent", recipient.did)

    const out = await tool("a2a_send_message")({ friend_id: bRecord!.id, message: "hello peer", session_key: "conv-1" }, localCtx(tmp.agentRoot, store))

    // The seal path returns a sent acknowledgement (not the legacy task JSON).
    expect(out).toMatch(/sealed|sent|delivered/i)
    // THE ROUND-TRIP: B's turn was keyed on the SENDER's verified DID (not the sentinel).
    expect(observedPeer).toBe(senderSelf.did)
  })

  it("falls back to the legacy text send for a non-DID-keyed (legacy) peer", async () => {
    tmp = createTmpBundle({ agentName: "send-legacy-text" })
    seedSelfIdentity(tmp.agentName)
    recipientServer = await startA2AServer({
      agentName: "legacy-recipient",
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message }: A2ATurnRunnerInput) => ({ response: `echo:${message}` }),
    })

    // A legacy peer: endpointUrl present, NO a2a.did.
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const legacy: FriendRecord = {
      id: "legacy-peer", name: "Legacy", trustLevel: "friend", role: "agent-peer", kind: "agent",
      agentMeta: { bundleName: "legacy", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { endpointUrl: recipientServer.endpointUrl, agentId: "legacy-agent" } },
      externalIds: [{ provider: "a2a-agent", externalId: "legacy-agent", linkedAt: new Date().toISOString() }],
      tenantMemberships: [], toolPreferences: {}, notes: {},
      totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
    }
    await store.put(legacy.id, legacy)

    const out = JSON.parse(await tool("a2a_send_message")({ friend_id: legacy.id, message: "ping" }, localCtx(tmp.agentRoot, store)))
    // The legacy text path returns the task JSON with the echoed response (unchanged).
    expect(out.artifacts[0].parts[0].text).toBe("echo:ping")
  })

  it("errors when a DID-keyed peer's DID cannot be parsed (cannot seal)", async () => {
    tmp = createTmpBundle({ agentName: "send-bad-did" })
    seedSelfIdentity(tmp.agentName)
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    // A peer that LOOKS DID-keyed (a2a.did present) but whose DID is unparseable.
    const broken: FriendRecord = {
      id: "broken-peer", name: "Broken", trustLevel: "family", role: "agent-peer", kind: "agent",
      agentMeta: { bundleName: "broken", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { did: "did:key:not-real", agentId: "did:key:not-real", endpointUrl: "https://broken.example/a2a" } },
      externalIds: [{ provider: "a2a-agent", externalId: "did:key:not-real", linkedAt: new Date().toISOString() }],
      tenantMemberships: [], toolPreferences: {}, notes: {},
      totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
    }
    await store.put(broken.id, broken)

    const out = await tool("a2a_send_message")({ friend_id: broken.id, message: "hi" }, localCtx(tmp.agentRoot, store))
    expect(out).toMatch(/error|cannot seal|parse/i)
  })

  it("still enforces the trust gate on the sealed path (acquaintance peer refused)", async () => {
    tmp = createTmpBundle({ agentName: "send-untrusted-seal" })
    seedSelfIdentity(tmp.agentName)
    const peer = mintIdentity()
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(store, {
      name: "Acq", agentId: peer.did, trustLevel: "acquaintance",
      a2a: { did: peer.did, agentId: peer.did, endpointUrl: "https://acq.example/a2a" },
    })
    const rec = await store.findByExternalId("a2a-agent", peer.did)
    const out = await tool("a2a_send_message")({ friend_id: rec!.id, message: "hi" }, localCtx(tmp.agentRoot, store))
    expect(out).toMatch(/friend or family/i)
  })
})
