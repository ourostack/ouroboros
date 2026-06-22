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

async function postMessage(message: unknown): Promise<A2AJsonRpcResponse> {
  if (!server) throw new Error("server not started")
  const response = await fetch(server.endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", method: "SendMessage", params: { message } }),
  })
  return (await response.json()) as A2AJsonRpcResponse
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

describe("server inbound DataPart wiring (verified-DID → turn keying)", () => {
  it("a valid sealed DataPart from a family peer runs the turn keyed on the VERIFIED DID (not the sentinel)", async () => {
    tmp = createTmpBundle({ agentName: "wiring-ok" })
    const recipient = mintIdentity()
    await seedFriend(tmp.agentRoot, "placeholder", "stranger") // ensure friends dir exists
    const a = mintIdentity()
    await seedFriend(tmp.agentRoot, a.did, "family")

    const seen: A2ATurnRunnerInput[] = []
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      identity: asSelf(recipient),
      turnRunner: async (input) => {
        seen.push(input)
        return { response: `handled:${input.message}` }
      },
    })

    const response = await postMessage(sealedCoordination(a, recipient))
    expect("result" in response).toBe(true)
    // The turn ran exactly once, keyed on A's verified DID — NOT "unauthenticated-a2a-peer".
    expect(seen.length).toBe(1)
    expect(seen[0]!.peerAgentId).toBe(a.did)
    expect(seen[0]!.peerAgentId).not.toBe("unauthenticated-a2a-peer")
  })

  it("a forged DataPart is rejected with a JSON-RPC error and runs NO turn", async () => {
    tmp = createTmpBundle({ agentName: "wiring-forge" })
    const recipient = mintIdentity()
    const a = mintIdentity()
    const impostor = mintIdentity()
    await seedFriend(tmp.agentRoot, a.did, "family")

    const seen: A2ATurnRunnerInput[] = []
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      identity: asSelf(recipient),
      turnRunner: async (input) => {
        seen.push(input)
        return { response: "should-not-run" }
      },
    })

    // Claim to be A but sign with the impostor → verifier rejects.
    const response = await postMessage(sealedCoordination(a, recipient, impostor))
    expect("error" in response).toBe(true)
    expect(seen.length).toBe(0)
  })

  it("a legacy text message still runs the turn at the unauthenticated sentinel (text path unchanged)", async () => {
    tmp = createTmpBundle({ agentName: "wiring-text" })
    const recipient = mintIdentity()

    const seen: A2ATurnRunnerInput[] = []
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      identity: asSelf(recipient),
      turnRunner: async (input) => {
        seen.push(input)
        return { response: `echo:${input.message}` }
      },
    })

    const response = await postMessage({ role: "user", parts: [{ text: "plain text hello" }] })
    expect("result" in response).toBe(true)
    expect(seen.length).toBe(1)
    expect(seen[0]!.peerAgentId).toBe("unauthenticated-a2a-peer")
    expect(seen[0]!.message).toBe("plain text hello")
  })

  it("a sealed DataPart with NO server identity falls through to the text path (no identity ⇒ cannot unseal)", async () => {
    tmp = createTmpBundle({ agentName: "wiring-noid" })
    const recipient = mintIdentity()
    const a = mintIdentity()

    const seen: A2ATurnRunnerInput[] = []
    // No `identity` passed → the server cannot unseal; a data-only message has no
    // text, so it is an invalid text request (the legacy guard rejects it).
    server = await startA2AServer({
      agentName: tmp.agentName,
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async (input) => {
        seen.push(input)
        return { response: "x" }
      },
    })

    const response = await postMessage(sealedCoordination(a, recipient))
    // Without identity, the DataPart can't be bridged and carries no text →
    // the existing "requires a text message" guard returns an error, no turn.
    expect("error" in response).toBe(true)
    expect(seen.length).toBe(0)
  })
})
