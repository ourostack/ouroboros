import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  sealEnvelope,
  wrapInDataPart,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type TrustLevel } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle, type A2ATurnRunnerInput } from "../../a2a/server"
import type { A2AIdentity } from "../../a2a/identity"
import type { A2AJsonRpcResponse } from "../../a2a/types"

/**
 * Unit 1h — the Slice-1 inbound integration proof. Drives the FULL inbound loop
 * end-to-end through the real `startA2AServer` + a real friends-sealed message from
 * a synthetic peer A, asserting the five points:
 *   verify / forge / replay (incl. after restart) / unsigned (→ stranger turn) /
 *   wrong-recipient,
 * plus the keying invariant: a verified peer's turn `externalId === <A's did>` (NOT
 * the `unauthenticated-a2a-peer` sentinel), read at A's real trust.
 */

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
  tmp?.cleanup()
  tmp = null
})

function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function asSelf(id: DidKeyIdentity): A2AIdentity {
  return { ...id, seed: "test-seed" }
}

function sealedCoordination(from: DidKeyIdentity, recipient: DidKeyIdentity, signWith?: DidKeyIdentity): unknown {
  const signer = signWith ?? from
  const envelope: Record<string, unknown> = {
    subject: { missionKey: `mk-${Math.random().toString(36).slice(2, 8)}`, title: "Mission" },
    fromAgentId: from.did,
    intent: "request",
  }
  const sealed = sealEnvelope({
    sodium,
    envelope,
    friendsKind: "coordination",
    fromIdentity: { did: signer.did, keyId: signer.keyId, ed25519Priv: signer.ed25519Priv },
    recipientDid: recipient.did,
    recipientX25519Pub: recipient.x25519Pub,
  })
  return wrapInDataPart({ sealedEnvelope: sealed, recipientDid: recipient.did })
}

async function seedFriend(agentRoot: string, did: string, trustLevel: TrustLevel): Promise<void> {
  const store = new FileFriendStore(`${agentRoot}/friends`)
  await upsertAgentPeer(store, {
    name: `Peer ${did.slice(0, 10)}`,
    agentId: did,
    trustLevel,
    a2a: { did, agentId: did, endpointUrl: "https://peer.example/a2a" },
  })
}

interface Started {
  recipient: DidKeyIdentity
  seen: A2ATurnRunnerInput[]
}

async function startServer(agentRoot: string): Promise<Started> {
  const recipient = mintIdentity()
  const seen: A2ATurnRunnerInput[] = []
  server = await startA2AServer({
    agentName: "integration",
    agentRoot,
    port: 0,
    identity: asSelf(recipient),
    turnRunner: async (input) => {
      seen.push(input)
      return { response: `handled:${input.peerAgentId}` }
    },
  })
  return { recipient, seen }
}

async function post(message: unknown): Promise<A2AJsonRpcResponse> {
  if (!server) throw new Error("server not started")
  const response = await fetch(server.endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "rpc", method: "SendMessage", params: { message } }),
  })
  return (await response.json()) as A2AJsonRpcResponse
}

describe("Slice-1 inbound integration (5-point proof through startA2AServer)", () => {
  it("VERIFY: a valid sealed coordination from a family peer keys the turn on A's verified DID", async () => {
    tmp = createTmpBundle({ agentName: "int-verify" })
    const { recipient, seen } = await startServer(tmp.agentRoot)
    const a = mintIdentity()
    await seedFriend(tmp.agentRoot, a.did, "family")

    const response = await post(sealedCoordination(a, recipient))
    expect("result" in response).toBe(true)
    expect(seen.length).toBe(1)
    // The keying invariant: the turn ran as A's verified DID, NOT the sentinel.
    expect(seen[0]!.peerAgentId).toBe(a.did)
    expect(seen[0]!.peerAgentId).not.toBe("unauthenticated-a2a-peer")
  })

  it("FORGE: a sealed envelope claiming A but signed by an impostor → rejected, no turn", async () => {
    tmp = createTmpBundle({ agentName: "int-forge" })
    const { recipient, seen } = await startServer(tmp.agentRoot)
    const a = mintIdentity()
    const impostor = mintIdentity()
    await seedFriend(tmp.agentRoot, a.did, "family")

    const response = await post(sealedCoordination(a, recipient, impostor))
    expect("error" in response).toBe(true)
    expect(seen.length).toBe(0)
  })

  it("REPLAY: a replayed seal nonce is rejected; and a replay AFTER a restart is STILL rejected", async () => {
    tmp = createTmpBundle({ agentName: "int-replay" })
    const agentRoot = tmp.agentRoot
    const { recipient, seen } = await startServer(agentRoot)
    const a = mintIdentity()
    await seedFriend(agentRoot, a.did, "family")
    const message = sealedCoordination(a, recipient)

    // First delivery completes.
    expect("result" in (await post(message))).toBe(true)
    expect(seen.length).toBe(1)

    // Immediate replay → rejected (seen), no second turn.
    expect("error" in (await post(message))).toBe(true)
    expect(seen.length).toBe(1)

    // Simulated restart: close + restart the server over the SAME agent root (the
    // durable SeenLedger reloads). The SAME recipient identity is required to
    // unseal — so reuse it by starting a fresh server with that identity.
    await server!.close()
    server = await startA2AServer({
      agentName: "integration",
      agentRoot,
      port: 0,
      identity: asSelf(recipient),
      turnRunner: async (input) => {
        seen.push(input)
        return { response: "x" }
      },
    })
    // The replay AFTER restart must STILL be rejected (no reopened window).
    expect("error" in (await post(message))).toBe(true)
    expect(seen.length).toBe(1)
  })

  it("UNSIGNED: a legacy unsigned text message runs the turn at the stranger sentinel (not rejected)", async () => {
    tmp = createTmpBundle({ agentName: "int-unsigned" })
    const { seen } = await startServer(tmp.agentRoot)

    const response = await post({ role: "user", parts: [{ text: "just plain text" }] })
    expect("result" in response).toBe(true)
    expect(seen.length).toBe(1)
    // The unsigned/cold path keys on the unauthenticated sentinel (resolves to
    // stranger — no friend record for the sentinel).
    expect(seen[0]!.peerAgentId).toBe("unauthenticated-a2a-peer")
  })

  it("WRONG-RECIPIENT: an envelope sealed to a DIFFERENT recipient → rejected, no turn", async () => {
    tmp = createTmpBundle({ agentName: "int-wrongrcpt" })
    const { seen } = await startServer(tmp.agentRoot)
    const a = mintIdentity()
    const someoneElse = mintIdentity()
    await seedFriend(tmp.agentRoot, a.did, "family")

    // Sealed to someoneElse, not our server's identity → unseal/recipient mismatch.
    const response = await post(sealedCoordination(a, someoneElse))
    expect("error" in response).toBe(true)
    expect(seen.length).toBe(0)
  })

  it("UNKNOWN DID: a valid signature from a DID NOT in the friend store → stranger → rejected by importer", async () => {
    tmp = createTmpBundle({ agentName: "int-unknown" })
    const { recipient, seen } = await startServer(tmp.agentRoot)
    const stranger = mintIdentity()
    // No seedFriend → trust read by the verified DID defaults to stranger (never up).
    const response = await post(sealedCoordination(stranger, recipient))
    expect("error" in response).toBe(true)
    expect(seen.length).toBe(0)
  })
})
