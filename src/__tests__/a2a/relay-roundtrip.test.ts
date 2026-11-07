import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { ready, didKeyIdentityFromEd25519, openSealed, sealEnvelope, sealTo, wrapInDataPart, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startFakeRelay, type FakeRelay } from "../test-helpers/fake-relay"
import { startA2AServer, type A2AServerHandle, type A2ATurnRunnerInput } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { readRelayContact } from "../../a2a/relay-contacts"
import { relaySend } from "../../a2a/relay-client"
import { FileA2ASeenLedger } from "../../a2a/seen-ledger"
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

  it("refuses a tampered message and a rebound one (right signature, other recipient or kind) through the relay, marking neither seen", async () => {
    const relay: FakeRelay = await startFakeRelay()
    closers.push(() => relay.close())
    const peerBundle = createTmpBundle({ agentName: "relay-forge-peer" })
    bundles.push(peerBundle)
    const sender = seededIdentity()
    const peer = seededIdentity()
    const bystander = seededIdentity()
    const peerFriends = new FileFriendStore(`${peerBundle.agentRoot}/friends`)
    await upsertAgentPeer(peerFriends, { name: "Sender", agentId: sender.did, trustLevel: "family", a2a: { did: sender.did, agentId: sender.did, endpointUrl: "https://sender.example/a2a" } })
    const senderOnPeer = (await peerFriends.findByExternalId("a2a-agent", sender.did))!
    await peerFriends.put(senderOnPeer.id, { ...senderOnPeer, admissionState: "active" })

    const turns: A2ATurnRunnerInput[] = []
    const relayConfig = memoryRelayConfig({ url: relay.url, inviteToken: "invite-1" })
    const peerServer = await startA2AServer({
      agentName: peerBundle.agentName, agentRoot: peerBundle.agentRoot, port: 0, identity: peer,
      turnRunner: async (input) => { turns.push(input); return { response: "ran" } },
      relay: { config: relayConfig, intervalMs: 60 * 60_000 },
    })
    closers.push(() => peerServer.close())
    await peerServer.relay!.ready
    const registration = relayConfig.current.registration!

    const envelope = { fromAgentId: sender.did, note: "hello", issuedAt: new Date().toISOString() }
    const sealFor = (to: DidKeyIdentity, friendsKind: "coordination" | "message" = "coordination") =>
      sealEnvelope({ sodium, envelope, friendsKind, fromIdentity: sender, recipientDid: to.did, recipientX25519Pub: to.x25519Pub })
    /** Open a sealed envelope with `holder`'s keys, edit its signed-over plaintext's outer fields, and seal it to the peer. */
    const reseal = (sealed: ReturnType<typeof sealEnvelope>, holder: DidKeyIdentity, edit: (plaintext: Record<string, unknown>) => void) => {
      const bytes = openSealed({ sodium, blob: sealed.sealed, recipientX25519Priv: holder.x25519Priv, recipientX25519Pub: holder.x25519Pub, recipientDid: holder.did })
      const plaintext = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      edit(plaintext)
      const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify(plaintext)), recipientX25519Pub: peer.x25519Pub, recipientDid: peer.did, v: sealed.v })
      return { v: sealed.v, sealed: blob }
    }

    // Tampered: a real message to the peer with one ciphertext character changed.
    const genuine = sealFor(peer)
    const flipped = genuine.sealed.ct[10] === "A" ? "B" : "A"
    const tampered = { ...genuine, sealed: { ...genuine.sealed, ct: `${genuine.sealed.ct.slice(0, 10)}${flipped}${genuine.sealed.ct.slice(11)}` } }
    // Rebound to another recipient: signed for the bystander, opened by it and resealed to the peer.
    const otherRecipient = reseal(sealFor(bystander), bystander, (plaintext) => { plaintext.recipient = peer.did })
    // Rebound to another kind: signed as a coordination, relabelled as a message.
    const otherKind = reseal(sealFor(peer), peer, (plaintext) => { plaintext.friendsKind = "message" })

    const seenDir = path.join(peerBundle.agentRoot, "state", "a2a", "seen")
    const seenBefore = fs.readdirSync(seenDir).sort()
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    for (const sealed of [tampered, otherRecipient, otherKind]) {
      await relaySend({ url: relay.url, handle: registration.handle, sendCredential: registration.sendCredential, message: wrapInDataPart({ sealedEnvelope: sealed, recipientDid: peer.did }) })
    }
    expect(relay.inbox.get(registration.handle)).toHaveLength(3)

    expect(await peerServer.relay!.tick()).toBe("ok")
    const refusals = nerves.mock.calls.map(([event]) => event).filter((event) => event.event === "channel.a2a_relay_message_delivered").map((event) => String((event.meta as { refusal?: unknown }).refusal))
    nerves.mockRestore()
    expect(refusals).toHaveLength(3)
    expect(refusals[0]).toMatch(/rejected: unseal_failed/)
    expect(refusals[1]).toMatch(/rejected: signed_recipient_mismatch/)
    expect(refusals[2]).toMatch(/rejected: signed_kind_mismatch/)
    // Refused for good, so acked; no turn ran; nothing reached the seen ledger.
    expect(relay.inbox.get(registration.handle)).toEqual([])
    expect(turns).toEqual([])
    expect(fs.readdirSync(seenDir).sort()).toEqual(seenBefore)
    const ledger = new FileA2ASeenLedger(peerBundle.agentRoot)
    for (const sealed of [tampered, otherRecipient, otherKind]) expect(ledger.has(sealed.sealed.n)).toBe(false)
  }, 30_000)

  it("marks a relayed message seen once verified, so a turn that fails after that neither runs it again nor leaves it queued", async () => {
    const relay: FakeRelay = await startFakeRelay()
    closers.push(() => relay.close())
    const peerBundle = createTmpBundle({ agentName: "relay-fail-peer" })
    bundles.push(peerBundle)
    const sender = seededIdentity()
    const peer = seededIdentity()
    const peerFriends = new FileFriendStore(`${peerBundle.agentRoot}/friends`)
    await upsertAgentPeer(peerFriends, { name: "Sender", agentId: sender.did, trustLevel: "family", a2a: { did: sender.did, agentId: sender.did, endpointUrl: "https://sender.example/a2a" } })
    const senderOnPeer = (await peerFriends.findByExternalId("a2a-agent", sender.did))!
    await peerFriends.put(senderOnPeer.id, { ...senderOnPeer, admissionState: "active" })

    let turns = 0
    const relayConfig = memoryRelayConfig({ url: relay.url, inviteToken: "invite-1" })
    const peerServer = await startA2AServer({
      agentName: peerBundle.agentName, agentRoot: peerBundle.agentRoot, port: 0, identity: peer,
      turnRunner: async () => { turns += 1; throw new Error("provider down") },
      relay: { config: relayConfig, intervalMs: 60 * 60_000 },
    })
    closers.push(() => peerServer.close())
    await peerServer.relay!.ready
    const registration = relayConfig.current.registration!

    const sealed = sealEnvelope({ sodium, envelope: { subject: { missionKey: `dm:${sender.did}:${peer.did}`, title: "Direct message" }, fromAgentId: sender.did, intent: "offer", note: "hello", issuedAt: new Date().toISOString() }, friendsKind: "coordination", fromIdentity: sender, recipientDid: peer.did, recipientX25519Pub: peer.x25519Pub })
    const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: peer.did })
    await relaySend({ url: relay.url, handle: registration.handle, sendCredential: registration.sendCredential, message })

    expect(await peerServer.relay!.tick()).toBe("backoff")
    expect(turns).toBe(1)
    // The real seen ledger on disk holds the nonce, and the relay no longer holds the message.
    expect(new FileA2ASeenLedger(peerBundle.agentRoot).has(sealed.sealed.n)).toBe(true)
    expect(relay.inbox.get(registration.handle)).toEqual([])

    // The relay hands the same copy back: refused as a replay and acked, and the turn does not run again.
    await relaySend({ url: relay.url, handle: registration.handle, sendCredential: registration.sendCredential, message })
    await peerServer.relay!.tick()
    expect(turns).toBe(1)
    expect(relay.inbox.get(registration.handle)).toEqual([])
  }, 30_000)
})
