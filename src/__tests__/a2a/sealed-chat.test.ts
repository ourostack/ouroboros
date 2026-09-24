// End-to-end: a non-agent client (a coding harness) chats with an ouro agent over
// A2A as a verified friend. Both directions are signed + sealed; the agent's turn is
// scoped by the client's relationship profile; nothing travels or persists in the clear.
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { didKeyIdentityFromEd25519, ready, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, MAX_MESSAGE_TEXT_CHARS, upsertAgentPeer } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { a2aChatRelationship, startA2AServer, type A2AServerHandle, type A2ATurnRunnerInput } from "../../a2a/server"
import { sendSealedA2AChat } from "../../a2a/client"
import { EMPTY_CHAT_REPLY, openChatMessage, sealChatMessage } from "../../a2a/sealed-chat"
import { loadOrMintA2AIdentityFile, type A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null

beforeAll(async () => { sodium = await ready() })
afterEach(async () => {
  if (server) { await server.close(); server = null }
  tmp?.cleanup()
  tmp = null
})

function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function asSelf(id: DidKeyIdentity): A2AIdentity {
  return { ...id, seed: Buffer.from(sodium.randombytes_buf(32)).toString("base64url") }
}

const PROFILES = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", "utf8"))

/** A Sanctuary-shaped agent with the packaged capability registry and a trusted client. */
async function setup(options: { registry?: boolean; reply?: (input: A2ATurnRunnerInput) => string } = {}) {
  tmp = createTmpBundle({ agentName: `chat-${Date.now()}` })
  if (options.registry !== false) fs.writeFileSync(path.join(tmp.agentRoot, "tool-profiles.json"), JSON.stringify(PROFILES))
  const agent = asSelf(mintIdentity())
  const client = await loadOrMintA2AIdentityFile({ filePath: path.join(tmp.bundlesRoot, "client", "identity.json"), sodium })
  const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
  const record = await upsertAgentPeer(store, {
    name: "Claude Code", agentId: client.did, trustLevel: "family",
    a2a: { did: client.did, agentId: client.did, endpointUrl: "https://client.example/a2a" },
  })
  await store.put(record.id, { ...record, admissionState: "active", initiativePolicy: "reactive_only", capabilityProfileId: "sanctuary-agent-peer" })
  const turns: A2ATurnRunnerInput[] = []
  server = await startA2AServer({
    agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, identity: agent,
    turnRunner: async (input) => {
      turns.push(input)
      return { response: options.reply ? options.reply(input) : `heard: ${input.message}` }
    },
  })
  const cardUrl = new URL("/.well-known/agent-card.json", server.url).toString()
  return { agent, client, store, turns, cardUrl }
}

/** A fetch that records every request/response body that crosses the wire. */
function wireTap() {
  const bodies: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.body) bodies.push(String(init.body))
    const response = await fetch(input, init)
    const text = await response.text()
    bodies.push(text)
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return { bodies, fetchImpl }
}

describe("sealed A2A chat between a client and an agent", () => {
  it("delivers a verified friend's message, scopes the turn by its profile, and seals the reply", async () => {
    const { client, turns, cardUrl } = await setup()
    const tap = wireTap()
    const reply = await sendSealedA2AChat({ cardUrl, text: "are you up?", identity: client, sodium, fetchImpl: tap.fetchImpl })

    expect(reply.text).toBe("heard: are you up?")
    expect(reply.peerDid).toMatch(/^did:key:/)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.message).toBe("are you up?")
    expect(turns[0]!.peerAgentId).toBe(client.did)
    expect(turns[0]!.peerName).toBe("Claude Code")
    expect(turns[0]!.sessionKey).toBe(reply.conversationId)
    const relationship = turns[0]!.relationshipAuthorization!
    expect(relationship.profileId).toBe("sanctuary-agent-peer")
    expect(relationship.advertisedToolNames).toContain("shell")
    expect(relationship.advertisedToolNames).not.toContain("sanctuary_host_execute")
    expect(relationship.advertisedToolNames).not.toContain("unraid_restart_container")

    // Neither the question nor the answer ever crosses the wire in the clear.
    expect(tap.bodies.join("\n")).not.toContain("are you up?")
    expect(tap.bodies.join("\n")).not.toContain("heard:")
  })

  it("stores the reply sealed, so GetTask with the task's own token never yields plaintext", async () => {
    const { client, cardUrl } = await setup()
    const tap = wireTap()
    await sendSealedA2AChat({ cardUrl, text: "status?", identity: client, sodium, fetchImpl: tap.fetchImpl })
    const sendResult = JSON.parse(tap.bodies.find((body) => body.includes("\"result\""))!).result
    const accessToken = sendResult.metadata?.a2a?.accessToken ?? sendResult.metadata?.accessToken
    expect(typeof accessToken).toBe("string")
    const got = await fetch(server!.endpointUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "g", method: "GetTask", params: { id: sendResult.id, accessToken } }),
    }).then((response) => response.text())
    expect(got).toContain(sendResult.id)
    expect(got).not.toContain("heard:")
  })

  it("continues a conversation under the caller's conversation id", async () => {
    const { client, turns, cardUrl } = await setup()
    const first = await sendSealedA2AChat({ cardUrl, text: "one", identity: client, sodium, conversationId: "thread-7" })
    const second = await sendSealedA2AChat({ cardUrl, text: "two", identity: client, sodium, conversationId: first.conversationId })
    expect(second.conversationId).toBe("thread-7")
    expect(turns.map((turn) => turn.sessionKey)).toEqual(["thread-7", "thread-7"])
  })

  it("seals an empty turn reply as an explicit no-reply marker", async () => {
    const { client, cardUrl } = await setup({ reply: () => "   " })
    const reply = await sendSealedA2AChat({ cardUrl, text: "anything?", identity: client, sodium })
    expect(reply.text).toBe(EMPTY_CHAT_REPLY)
  })

  it("refuses a sealed message from a DID the agent does not trust, and runs no turn", async () => {
    const { turns, cardUrl } = await setup()
    const stranger = mintIdentity()
    await expect(sendSealedA2AChat({ cardUrl, text: "let me in", identity: stranger, sodium })).rejects.toThrow(/untrusted_source/)
    expect(turns).toHaveLength(0)
  })

  it("runs a verified friend's turn without a relationship when the agent has no capability registry", async () => {
    const { client, turns, cardUrl } = await setup({ registry: false })
    await sendSealedA2AChat({ cardUrl, text: "hi", identity: client, sodium })
    expect(turns[0]!.relationshipAuthorization).toBeUndefined()
  })
})

describe("a2aChatRelationship", () => {
  it("returns nothing for an invalid registry rather than guessing", () => {
    tmp = createTmpBundle({ agentName: `rel-${Date.now()}` })
    fs.writeFileSync(path.join(tmp.agentRoot, "tool-profiles.json"), JSON.stringify({ version: 1, profiles: {} }))
    expect(a2aChatRelationship(tmp.agentRoot, { id: "x" } as never, "req")).toBeUndefined()
  })
})

describe("sendSealedA2AChat refusals", () => {
  const card = (did: string | undefined) => ({ name: "Agent", url: "https://agent.example/a2a", preferredTransport: "JSONRPC", ...(did ? { did } : {}) })
  const fakeFetch = (routes: { card: unknown; rpc?: unknown }): typeof fetch => async (_input, init) =>
    new Response(JSON.stringify(init?.method === "POST" ? routes.rpc : routes.card), { status: 200, headers: { "content-type": "application/json" } })

  it("refuses a card that serves no DID", async () => {
    await expect(sendSealedA2AChat({ cardUrl: "https://agent.example/card", text: "hi", identity: mintIdentity(), sodium, fetchImpl: fakeFetch({ card: card(undefined) }) }))
      .rejects.toThrow(/serves no DID/)
  })

  it("refuses a card whose DID does not parse", async () => {
    await expect(sendSealedA2AChat({ cardUrl: "https://agent.example/card", text: "hi", identity: mintIdentity(), sodium, fetchImpl: fakeFetch({ card: card("did:key:zNotAKey") }) }))
      .rejects.toThrow(/binding failed/)
  })

  it("surfaces a JSON-RPC error", async () => {
    const agent = mintIdentity()
    await expect(sendSealedA2AChat({ cardUrl: "https://agent.example/card", text: "hi", identity: mintIdentity(), sodium, fetchImpl: fakeFetch({ card: card(agent.did), rpc: { jsonrpc: "2.0", id: "1", error: { code: -32003, message: "nope" } } }) }))
      .rejects.toThrow(/A2A error -32003: nope/)
  })

  it("refuses a result with no reply message", async () => {
    const agent = mintIdentity()
    await expect(sendSealedA2AChat({ cardUrl: "https://agent.example/card", text: "hi", identity: mintIdentity(), sodium, fetchImpl: fakeFetch({ card: card(agent.did), rpc: { jsonrpc: "2.0", id: "1", result: { id: "t", status: { state: "completed" } } } }) }))
      .rejects.toThrow(/no reply message/)
  })

  it("refuses a reply signed by anyone but the agent the card names", async () => {
    const agent = mintIdentity()
    const client = mintIdentity()
    const impostor = mintIdentity()
    const forged = sealChatMessage({ sodium, from: impostor, recipientDid: client.did, recipientEd25519Pub: client.ed25519Pub, text: "trust me" })
    await expect(sendSealedA2AChat({ cardUrl: "https://agent.example/card", text: "hi", identity: client, sodium, fetchImpl: fakeFetch({ card: card(agent.did), rpc: { jsonrpc: "2.0", id: "1", result: { id: "t", status: { message: { role: "ROLE_AGENT", parts: forged.parts } } } } }) }))
      .rejects.toThrow(/reply rejected: resolve_failed/)
  })
})

describe("sealChatMessage", () => {
  it("caps text at the protocol limit and keeps the conversation id", async () => {
    const from = mintIdentity()
    const to = mintIdentity()
    const sealed = sealChatMessage({ sodium, from, recipientDid: to.did, recipientEd25519Pub: to.ed25519Pub, text: "x".repeat(MAX_MESSAGE_TEXT_CHARS + 50), conversationId: "c-1" })
    const opened = await openChatMessage({ sodium, self: to, message: { role: "ROLE_AGENT", parts: sealed.parts }, senderDid: from.did, senderEd25519Pub: from.ed25519Pub })
    expect(opened.ok && opened.text.length).toBe(MAX_MESSAGE_TEXT_CHARS)
    expect(opened.ok && opened.conversationId).toBe("c-1")
  })

  it("opens a message without a conversation id", async () => {
    const from = mintIdentity()
    const to = mintIdentity()
    const sealed = sealChatMessage({ sodium, from, recipientDid: to.did, recipientEd25519Pub: to.ed25519Pub, text: "plain" })
    const opened = await openChatMessage({ sodium, self: to, message: { role: "ROLE_AGENT", parts: sealed.parts }, senderDid: from.did, senderEd25519Pub: from.ed25519Pub })
    expect(opened).toEqual({ ok: true, text: "plain", issuedAt: expect.any(String) })
  })
})

describe("loadOrMintA2AIdentityFile", () => {
  it("mints a private key file once and reloads the same identity", async () => {
    tmp = createTmpBundle({ agentName: `id-${Date.now()}` })
    const filePath = path.join(tmp.bundlesRoot, "keys", "client.json")
    const minted = await loadOrMintA2AIdentityFile({ filePath, sodium })
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700)
    const reloaded = await loadOrMintA2AIdentityFile({ filePath })
    expect(reloaded.did).toBe(minted.did)
  })

  it("refuses a key file readable by group or other", async () => {
    tmp = createTmpBundle({ agentName: `id-${Date.now()}` })
    const filePath = path.join(tmp.bundlesRoot, "client.json")
    await loadOrMintA2AIdentityFile({ filePath, sodium })
    fs.chmodSync(filePath, 0o644)
    await expect(loadOrMintA2AIdentityFile({ filePath, sodium })).rejects.toThrow(/readable by group or other/)
  })

  it("refuses a key file without a seed", async () => {
    tmp = createTmpBundle({ agentName: `id-${Date.now()}` })
    const filePath = path.join(tmp.bundlesRoot, "client.json")
    fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), { mode: 0o600 })
    await expect(loadOrMintA2AIdentityFile({ filePath, sodium })).rejects.toThrow(/has no seed/)
  })
})
