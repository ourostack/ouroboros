import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ready, didKeyIdentityFromEd25519, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startFakeRelay, type FakeRelay } from "../test-helpers/fake-relay"
import { startA2AServer, type A2AServerHandle, type A2ATurnRunnerInput } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { readRelayContact } from "../../a2a/relay-contacts"
import type { RelayConfig, RelayConfigStore } from "../../a2a/relay-inbox"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
const bundles: TmpBundleHandle[] = []
const closers: Array<() => Promise<void>> = []

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const bundle of bundles.splice(0)) bundle.cleanup()
})

function seededIdentity(): A2AIdentity & DidKeyIdentity {
  const seedBytes = sodium.randombytes_buf(32)
  const kp = sodium.crypto_sign_seed_keypair(seedBytes)
  return { ...didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey }), seed: Buffer.from(seedBytes).toString("base64url") }
}

/** An in-memory stand-in for the vault-held `a2a.relay` settings (the vault store has its own tests). */
function memoryRelayConfig(initial: RelayConfig): RelayConfigStore & { current: RelayConfig } {
  const holder = {
    current: { ...initial },
    async read() { return structuredClone(holder.current) },
    async write(patch: Partial<Record<keyof RelayConfig, unknown>>) {
      const next: Record<string, unknown> = { ...holder.current, ...patch }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      holder.current = next as RelayConfig
    },
  }
  return holder
}

function senderCtx(agentRoot: string, store: FileFriendStore): ToolContext {
  const now = new Date().toISOString()
  const owner: FriendRecord = {
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
      friend: owner,
      channel: { channel: "cli", senseType, availableIntegrations: [], supportsMarkdown: false, supportsStreaming: false, supportsRichCards: false, maxMessageLength: Infinity },
    },
  }
}

describe("A2A relay round trip (two agents, a friends-relay, real HTTP)", () => {
  it("delivers a message sent while the peer was offline once the peer comes back", async () => {
    const relay: FakeRelay = await startFakeRelay()
    closers.push(() => relay.close())
    const senderBundle = createTmpBundle({ agentName: "relay-rt-sender" })
    const peerBundle = createTmpBundle({ agentName: "relay-rt-peer" })
    bundles.push(senderBundle, peerBundle)

    const sender = seededIdentity()
    cacheMachineRuntimeCredentialConfig(senderBundle.agentName, { a2a: { identity: { ed25519Seed: sender.seed } } })
    const peer = seededIdentity()
    const peerFriends = new FileFriendStore(`${peerBundle.agentRoot}/friends`)
    await upsertAgentPeer(peerFriends, { name: "Sender", agentId: sender.did, trustLevel: "family", a2a: { did: sender.did, agentId: sender.did, endpointUrl: "https://sender.example/a2a" } })
    const senderOnPeer = (await peerFriends.findByExternalId("a2a-agent", sender.did))!
    await peerFriends.put(senderOnPeer.id, { ...senderOnPeer, admissionState: "active" })

    const relayConfig = memoryRelayConfig({ url: relay.url, inviteToken: "invite-1" })
    const turns: A2ATurnRunnerInput[] = []
    const startPeer = async (port: number): Promise<A2AServerHandle> => {
      const server = await startA2AServer({
        agentName: peerBundle.agentName, agentRoot: peerBundle.agentRoot, port, identity: peer,
        turnRunner: async (input) => { turns.push(input); return { response: "got it" } },
        // A long interval: the test drives the inbox through `ready` (its first pass) instead of the timer.
        relay: { config: relayConfig, intervalMs: 60 * 60_000 },
      })
      await server.relay!.ready
      return server
    }

    // 1. The peer is online and registers its relay inbox (the invite is used once and cleared).
    let peerServer = await startPeer(0)
    const port = Number(new URL(peerServer.endpointUrl).port)
    expect(relayConfig.current.inviteToken).toBeUndefined()
    const handle = relayConfig.current.registration!.handle
    expect(relay.registrations.get(handle)?.did).toBe(peer.did)
    expect(relay.registrations.get(handle)?.agentCard).toEqual({ name: peerBundle.agentName, did: peer.did })

    // 2. A direct send succeeds, and the sender learns the peer's relay contact in the background.
    const senderFriends = new FileFriendStore(`${senderBundle.agentRoot}/friends`)
    await upsertAgentPeer(senderFriends, { name: "Peer", agentId: peer.did, trustLevel: "family", a2a: { did: peer.did, agentId: peer.did, endpointUrl: peerServer.endpointUrl } })
    const record = (await senderFriends.findByExternalId("a2a-agent", peer.did))!
    const send = a2aToolDefinitions.find((entry) => entry.tool.function.name === "a2a_send_message")!.handler
    const ctx = senderCtx(senderBundle.agentRoot, senderFriends)
    expect(await send({ friend_id: record.id, message: "hello" }, ctx)).toBe(`sealed message delivered to Peer (${peer.did}) over the direct rung.`)
    await vi.waitFor(() => expect(readRelayContact(senderBundle.agentRoot, peer.did)?.contact?.handle).toBe(handle), { timeout: 5000 })
    expect(turns.map((t) => t.message)).toEqual([`[a2a] received coordination (seeded) from ${sender.did}`])

    // 3. The peer goes offline; the next send is queued at its relay, still sealed.
    await peerServer.close()
    expect(await send({ friend_id: record.id, message: "are you there?" }, ctx))
      .toBe(`Peer (${peer.did}) is not reachable directly; the sealed message is queued at Peer's relay and is delivered when Peer comes back online.`)
    expect(relay.inbox.get(handle)).toHaveLength(1)
    expect(JSON.stringify(relay.inbox.get(handle))).not.toContain("are you there?")

    // 4. The peer comes back, drains its inbox through the normal verification and turn path, and acks the message.
    peerServer = await startPeer(port)
    closers.push(() => peerServer.close())
    expect(turns).toHaveLength(2)
    // The same conversation continues: the second message is logged on the mission the first one seeded.
    expect(turns[1].message).toBe(`[a2a] received coordination (logged) from ${sender.did}`)
    expect(relay.inbox.get(handle)).toEqual([])

    // 5. The same sealed copy queued again (a relay that re-delivers) is refused as a replay and acked, not run twice.
    relay.inbox.get(handle)!.push({ queueId: "q-again", message: relay.requests.find((r) => r.method === "POST" && r.path.startsWith("/a2a/"))!.body })
    await peerServer.relay!.tick()
    expect(turns).toHaveLength(2)
    expect(relay.inbox.get(handle)).toEqual([])
  }, 30_000)
})
