import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ready, didKeyIdentityFromEd25519, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startFakeRelay, type FakeRelay } from "../test-helpers/fake-relay"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { readRelayContact, writeRelayContact } from "../../a2a/relay-contacts"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let relay: FakeRelay | null = null
const closers: Array<() => Promise<void>> = []

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  await relay?.close()
  relay = null
  tmp?.cleanup()
  tmp = null
})

function sendMessage() {
  return a2aToolDefinitions.find((entry) => entry.tool.function.name === "a2a_send_message")!.handler
}

function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function seedSelfIdentity(agentName: string): DidKeyIdentity {
  const seedBytes = sodium.randombytes_buf(32)
  const kp = sodium.crypto_sign_seed_keypair(seedBytes)
  cacheMachineRuntimeCredentialConfig(agentName, { a2a: { identity: { ed25519Seed: Buffer.from(seedBytes).toString("base64url") } } })
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function localCtx(agentRoot: string, store: NonNullable<ToolContext["friendStore"]>): ToolContext {
  const now = new Date().toISOString()
  const requester: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", role: "human", kind: "human",
    agentMeta: { bundleName: "owner", familiarity: 0, sharedMissions: [], outcomes: [] },
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1,
  }
  const senseType: SenseType = "local"
  return {
    signin: async () => undefined,
    agentRoot,
    friendStore: store,
    context: {
      friend: requester,
      channel: { channel: "cli", senseType, availableIntegrations: [], supportsMarkdown: false, supportsStreaming: false, supportsRichCards: false, maxMessageLength: Infinity },
    },
  }
}

/** A port nothing listens on: bind, read the port, close. */
async function closedPortUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}/a2a`
}

/** An endpoint that accepts the request and then drops the connection, so the request may have arrived. */
async function droppingEndpoint(): Promise<string> {
  const server = http.createServer((req) => req.socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`
}

async function registerAtRelay(fake: FakeRelay, did: string): Promise<{ url: string; handle: string; sendCredential: string }> {
  const response = await fetch(`${fake.url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "peer-inbox", did, agentCard: {} }) })
  const body = await response.json() as { sendCredential: string }
  return { url: fake.url, handle: "peer-inbox", sendCredential: body.sendCredential }
}

async function peerRecord(store: FileFriendStore, peer: DidKeyIdentity, endpointUrl: string): Promise<FriendRecord> {
  await upsertAgentPeer(store, { name: "Peer", agentId: peer.did, trustLevel: "family", a2a: { did: peer.did, agentId: peer.did, endpointUrl } })
  return (await store.findByExternalId("a2a-agent", peer.did))!
}

describe("a2a_send_message falls back to the peer's relay", () => {
  it("queues the sealed message at the peer's relay when the peer is offline", async () => {
    tmp = createTmpBundle({ agentName: "relay-fallback-offline" })
    seedSelfIdentity(tmp.agentName)
    relay = await startFakeRelay()
    const peer = mintIdentity()
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const record = await peerRecord(store, peer, await closedPortUrl())
    writeRelayContact(tmp.agentRoot, { did: peer.did, fetchedAt: new Date().toISOString(), contact: await registerAtRelay(relay, peer.did) })

    const out = await sendMessage()({ friend_id: record.id, message: "are you there?" }, localCtx(tmp.agentRoot, store))
    expect(out).toBe(`Peer (${peer.did}) is not reachable directly; the sealed message is queued at Peer's relay and is delivered when Peer comes back online.`)
    expect(relay.inbox.get("peer-inbox")).toHaveLength(1)
  })

  it("says the message may have arrived when the direct attempt failed after it was sent", async () => {
    tmp = createTmpBundle({ agentName: "relay-fallback-dropped" })
    seedSelfIdentity(tmp.agentName)
    relay = await startFakeRelay()
    const peer = mintIdentity()
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const record = await peerRecord(store, peer, await droppingEndpoint())
    writeRelayContact(tmp.agentRoot, { did: peer.did, fetchedAt: new Date().toISOString(), contact: await registerAtRelay(relay, peer.did) })

    const out = await sendMessage()({ friend_id: record.id, message: "hi" }, localCtx(tmp.agentRoot, store))
    expect(out).toBe(`direct delivery to Peer (${peer.did}) failed and the sealed message may have arrived; a copy is queued at Peer's relay and is delivered when Peer comes back online.`)
  })

  it("reports a clear failure when the peer is offline and has shared no relay", async () => {
    tmp = createTmpBundle({ agentName: "relay-fallback-none" })
    seedSelfIdentity(tmp.agentName)
    const peer = mintIdentity()
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const record = await peerRecord(store, peer, await closedPortUrl())

    const out = await sendMessage()({ friend_id: record.id, message: "hi" }, localCtx(tmp.agentRoot, store))
    expect(out).toMatch(/^A2A sealed send error: .*it was not delivered, and the peer has shared no relay contact to queue it for later/)
  })

  it("marks the cached contact stale when the relay refuses it", async () => {
    tmp = createTmpBundle({ agentName: "relay-fallback-refused" })
    seedSelfIdentity(tmp.agentName)
    relay = await startFakeRelay()
    const peer = mintIdentity()
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const record = await peerRecord(store, peer, await closedPortUrl())
    const contact = await registerAtRelay(relay, peer.did)
    writeRelayContact(tmp.agentRoot, { did: peer.did, fetchedAt: new Date().toISOString(), contact: { ...contact, sendCredential: "revoked" } })

    const out = await sendMessage()({ friend_id: record.id, message: "hi" }, localCtx(tmp.agentRoot, store))
    expect(out).toMatch(/or through its relay \(.*\); the message was not delivered$/)
    expect(readRelayContact(tmp.agentRoot, peer.did)?.stale).toBe(true)
  })

  it("asks an online peer for its relay contact after a direct delivery", async () => {
    tmp = createTmpBundle({ agentName: "relay-fallback-refresh" })
    const sender = seedSelfIdentity(tmp.agentName)
    const peer = mintIdentity()
    const peerIdentity: A2AIdentity = { ...peer, seed: Buffer.from(sodium.randombytes_buf(32)).toString("base64url") }
    const server: A2AServerHandle = await startA2AServer({ agentName: "peer", agentRoot: tmp.agentRoot, port: 0, identity: peerIdentity, turnRunner: async () => ({ response: "ok" }) })
    closers.push(() => server.close())
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await upsertAgentPeer(store, { name: "Sender", agentId: sender.did, trustLevel: "family", a2a: { did: sender.did, agentId: sender.did, endpointUrl: "https://sender.example/a2a" } })
    const record = await peerRecord(store, peer, server.endpointUrl)

    const out = await sendMessage()({ friend_id: record.id, message: "hello" }, localCtx(tmp.agentRoot, store))
    expect(out).toBe(`sealed message delivered to Peer (${peer.did}) over the direct rung.`)
    // The peer runs no relay, so the answer is cached as "no relay" (asked again tomorrow).
    await vi.waitFor(() => expect(readRelayContact(tmp!.agentRoot, peer.did)).toMatchObject({ did: peer.did }), { timeout: 5000 })
    expect(readRelayContact(tmp.agentRoot, peer.did)?.contact).toBeUndefined()
  })
})
