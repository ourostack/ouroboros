/**
 * Contract check against a REAL friends-relay process (not run in CI). Start one, then point this test at it:
 *
 *   RELAY_BIND_HOST=127.0.0.1 RELAY_BIND_PORT=18999 RELAY_ADMIN_CREDENTIAL=<admin> node dist/bin.js   (in friends-relay)
 *   A2A_REAL_RELAY_URL=http://127.0.0.1:18999 A2A_REAL_RELAY_ADMIN=<admin> npx vitest run src/__tests__/a2a/relay-contract-real.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ready, didKeyIdentityFromEd25519, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { RelayHttpError, relayDeregister, relayPull } from "../../a2a/relay-client"
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

const RELAY_URL = process.env.A2A_REAL_RELAY_URL
const ADMIN = process.env.A2A_REAL_RELAY_ADMIN

async function mintInvite(): Promise<string> {
  const response = await fetch(`${RELAY_URL}/admin/invites`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ uses: 1 }) })
  expect(response.status).toBe(200)
  return (await response.json() as { inviteToken: string }).inviteToken
}

describe.skipIf(!RELAY_URL || !ADMIN)("A2A relay contract against a real friends-relay", () => {
  it("registers, queues sealed ciphertext while the peer is offline, drains it, rotates credentials and deregisters", async () => {
    const senderBundle = createTmpBundle({ agentName: "relay-real-sender" })
    const peerBundle = createTmpBundle({ agentName: "relay-real-peer" })
    bundles.push(senderBundle, peerBundle)
    const sender = seededIdentity()
    cacheMachineRuntimeCredentialConfig(senderBundle.agentName, { a2a: { identity: { ed25519Seed: sender.seed } } })
    const peer = seededIdentity()
    const peerFriends = new FileFriendStore(`${peerBundle.agentRoot}/friends`)
    await upsertAgentPeer(peerFriends, { name: "Sender", agentId: sender.did, trustLevel: "family", a2a: { did: sender.did, agentId: sender.did, endpointUrl: "https://sender.example/a2a" } })
    const senderOnPeer = (await peerFriends.findByExternalId("a2a-agent", sender.did))!
    await peerFriends.put(senderOnPeer.id, { ...senderOnPeer, admissionState: "active" })

    const relayConfig = memoryRelayConfig({ url: RELAY_URL!, inviteToken: await mintInvite() })
    const turns: A2ATurnRunnerInput[] = []
    const startPeer = async (port: number): Promise<A2AServerHandle> => {
      const server = await startA2AServer({
        agentName: peerBundle.agentName, agentRoot: peerBundle.agentRoot, port, identity: peer,
        turnRunner: async (input) => { turns.push(input); return { response: "got it" } },
        relay: { config: relayConfig, intervalMs: 60 * 60_000 },
      })
      await server.relay!.ready
      return server
    }

    let peerServer = await startPeer(0)
    const port = Number(new URL(peerServer.endpointUrl).port)
    const first = relayConfig.current.registration!
    expect(first.relayUrl).toBe(RELAY_URL)
    expect(relayConfig.current.inviteToken).toBeUndefined()
    console.log(`registered handle ${first.handle} at ${RELAY_URL}`)

    const senderFriends = new FileFriendStore(`${senderBundle.agentRoot}/friends`)
    await upsertAgentPeer(senderFriends, { name: "Peer", agentId: peer.did, trustLevel: "family", a2a: { did: peer.did, agentId: peer.did, endpointUrl: peerServer.endpointUrl } })
    const record = (await senderFriends.findByExternalId("a2a-agent", peer.did))!
    const send = a2aToolDefinitions.find((entry) => entry.tool.function.name === "a2a_send_message")!.handler
    const ctx = senderCtx(senderBundle.agentRoot, senderFriends)
    console.log(await send({ friend_id: record.id, message: "hello" }, ctx))
    await vi.waitFor(() => expect(readRelayContact(senderBundle.agentRoot, peer.did)?.contact?.handle).toBe(first.handle), { timeout: 5000 })

    await peerServer.close()
    const offline = await send({ friend_id: record.id, message: "are you there?" }, ctx)
    console.log(offline)
    expect(offline).toBe(`Peer (${peer.did}) is not reachable directly; the sealed message is queued at Peer's relay and is delivered when Peer comes back online.`)
    const held = await relayPull({ url: RELAY_URL!, handle: first.handle, inboxAuth: first.inboxAuth })
    expect(held).toHaveLength(1)
    const heldText = JSON.stringify(held)
    expect(heldText).not.toContain("are you there?")
    expect(heldText).not.toContain(sender.did)
    console.log(`relay holds ${held.length} message; keys of its data part: ${Object.keys((held[0].message as { parts: Array<{ data: object }> }).parts[0].data).join(", ")}`)

    peerServer = await startPeer(port)
    closers.push(() => peerServer.close())
    expect(turns).toHaveLength(2)
    expect(await relayPull({ url: RELAY_URL!, handle: first.handle, inboxAuth: first.inboxAuth })).toEqual([])
    console.log(`after restart: ${turns.length} turns, relay inbox empty`)

    // A new invite rotates the credentials and keeps the handle; the old inbox credential stops working.
    await peerServer.close()
    closers.pop()
    relayConfig.current = { ...relayConfig.current, inviteToken: await mintInvite() }
    peerServer = await startPeer(port)
    closers.push(() => peerServer.close())
    const second = relayConfig.current.registration!
    expect(second.handle).toBe(first.handle)
    expect(second.inboxAuth).not.toBe(first.inboxAuth)
    await expect(relayPull({ url: RELAY_URL!, handle: first.handle, inboxAuth: first.inboxAuth })).rejects.toBeInstanceOf(RelayHttpError)
    console.log("rotation: same handle, new credentials, old inbox credential refused")

    await relayDeregister({ url: RELAY_URL!, handle: second.handle, inboxAuth: second.inboxAuth })
    const after = await relayPull({ url: RELAY_URL!, handle: second.handle, inboxAuth: second.inboxAuth }).catch((error: unknown) => error)
    expect(after).toBeInstanceOf(RelayHttpError)
    console.log(`deregistered; pull now answers ${(after as RelayHttpError).status}`)
  }, 60_000)
})
