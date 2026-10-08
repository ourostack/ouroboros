import { beforeAll, describe, expect, it } from "vitest"
import { didKeyIdentityFromEd25519, ready, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { callOutboxMethod } from "../../a2a/outbox-client"
import { sealChatMessage } from "../../a2a/sealed-chat"

let sodium: Sodium
beforeAll(async () => { sodium = await ready() })
function mint(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}
const card = (did: string | undefined) => ({ name: "Agent", url: "https://agent.example/a2a", preferredTransport: "JSONRPC", ...(did ? { did } : {}) })
const fakeFetch = (routes: { card: unknown; rpc?: unknown }): typeof fetch => async (_input, init) =>
  new Response(JSON.stringify(init?.method === "POST" ? routes.rpc : routes.card), { status: 200, headers: { "content-type": "application/json" } })
const call = (client: DidKeyIdentity, routes: { card: unknown; rpc?: unknown }) =>
  callOutboxMethod({ cardUrl: "https://agent.example/card", method: "outbox/list", params: {}, identity: client, sodium, fetchImpl: fakeFetch(routes) })

describe("callOutboxMethod refusals", () => {
  it("refuses a card with no DID or a DID that does not bind to it", async () => {
    await expect(call(mint(), { card: card(undefined) })).rejects.toThrow(/serves no DID/)
    await expect(call(mint(), { card: card("did:key:zNotAKey") })).rejects.toThrow(/binding failed/)
  })

  it("surfaces the agent's JSON-RPC refusal and a missing reply", async () => {
    const agent = mint()
    await expect(call(mint(), { card: card(agent.did), rpc: { jsonrpc: "2.0", id: "1", error: { code: -32003, message: "nope" } } })).rejects.toThrow(/A2A error -32003: nope/)
    await expect(call(mint(), { card: card(agent.did), rpc: { jsonrpc: "2.0", id: "1", result: { id: "t" } } })).rejects.toThrow(/no reply message/)
    await expect(call(mint(), { card: card(agent.did), rpc: { jsonrpc: "2.0", id: "1" } })).rejects.toThrow(/no reply message/)
  })

  it("accepts a reply only when the card's key sealed it, and only as a JSON object", async () => {
    const agent = mint()
    const client = mint()
    const reply = (from: DidKeyIdentity, text: string) => ({ jsonrpc: "2.0", id: "1", result: { kind: "message", role: "ROLE_AGENT", parts: sealChatMessage({ sodium, from, recipientDid: client.did, recipientEd25519Pub: client.ed25519Pub, text }).parts } })
    await expect(call(client, { card: card(agent.did), rpc: reply(mint(), "{}") })).rejects.toThrow(/reply rejected: resolve_failed/)
    await expect(call(client, { card: card(agent.did), rpc: reply(agent, "not json") })).rejects.toThrow(/was not JSON/)
    await expect(call(client, { card: card(agent.did), rpc: reply(agent, "[1]") })).rejects.toThrow(/not a JSON object/)
    await expect(call(client, { card: card(agent.did), rpc: reply(agent, "null") })).rejects.toThrow(/not a JSON object/)
    await expect(call(client, { card: card(agent.did), rpc: reply(agent, '{"ok":true}') })).resolves.toEqual({ ok: true })
  })
})
