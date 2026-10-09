// End to end: a verified A2A friend pulls and clears its own outbox over the sealed wire, and an escalation holder
// closes a failure report. The server, not the caller, decides who may see or do what, from the verified friend record.
import * as path from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { didKeyIdentityFromEd25519, ready, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { postJsonRpc } from "../../a2a/client"
import { callOutboxMethod } from "../../a2a/outbox-client"
import { encodeOutboxCommand } from "../../a2a/outbox-wire"
import { sealChatMessage } from "../../a2a/sealed-chat"
import { loadOrMintA2AIdentityFile, type A2AIdentity } from "../../a2a/identity"
import { setEscalationGrant } from "../../a2a/escalation-grants"
import { FileOutboxStore } from "../../a2a/outbox-store"
import { fileFailureReport, readFailureReport } from "../../heart/failure-reports"
import { signedResolution } from "../test-helpers/resolution-signing"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null
beforeAll(async () => { sodium = await ready() })
afterEach(async () => {
  if (server) { await server.close(); server = null }
  tmp?.cleanup()
  tmp = null
})

function asSelf(): A2AIdentity {
  const kp = sodium.crypto_sign_keypair()
  const id: DidKeyIdentity = didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
  return { ...id, seed: Buffer.from(sodium.randombytes_buf(32)).toString("base64url") }
}

async function setup(options: { escalation?: Parameters<typeof startA2AServer>[0]["escalation"]; identity?: boolean } = {}) {
  tmp = createTmpBundle({ agentName: `outbox-server-${Date.now()}` })
  const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
  const peers: Record<string, { client: DidKeyIdentity; id: string }> = {}
  for (const name of ["claude", "stranger", "ari", "revoked"]) {
    const client = await loadOrMintA2AIdentityFile({ filePath: path.join(tmp.bundlesRoot, name, "identity.json"), sodium })
    const peer = await upsertAgentPeer(store, { name, agentId: client.did, trustLevel: "family", a2a: { did: client.did, agentId: client.did, endpointUrl: `https://${name}.example/a2a` } })
    await store.put(peer.id, { ...peer, admissionState: name === "revoked" ? "revoked" : "active", initiativePolicy: "reactive_only", capabilityProfileId: "sanctuary-agent-peer" })
    peers[name] = { client, id: peer.id }
  }
  setEscalationGrant(tmp.agentRoot, peers.claude!.id, { grant: true, source: "test" })
  server = await startA2AServer({
    agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, ...(options.identity === false ? {} : { identity: asSelf() }),
    ...(options.escalation ? { escalation: options.escalation } : {}),
    turnRunner: async () => ({ response: "chat" }),
  })
  const cardUrl = new URL("/.well-known/agent-card.json", server.url).toString()
  return { store, peers, cardUrl, agentRoot: tmp.agentRoot, outbox: new FileOutboxStore(tmp.agentRoot) }
}

describe("outbox/list and outbox/ack over the sealed wire", () => {
  it("returns a peer only its own outbox and clears it on ack", async () => {
    const { peers, cardUrl, outbox } = await setup()
    const mine = outbox.append(peers.stranger!.id, { kind: "await_outcome", body: "your await resolved" })
    outbox.append(peers.claude!.id, { kind: "failure_report", body: "SECRET report for Claude Code" })
    const listed = await callOutboxMethod({ cardUrl, method: "outbox/list", params: {}, identity: peers.stranger!.client, sodium })
    expect(listed).toMatchObject({ entries: [{ id: mine.id, kind: "await_outcome", body: "your await resolved" }], nextCursor: mine.id, more: false })
    expect(JSON.stringify(listed)).not.toContain("SECRET")
    const nosy = await callOutboxMethod({ cardUrl, method: "outbox/list", params: { friendId: peers.claude!.id, peer: peers.claude!.id }, identity: peers.stranger!.client, sodium })
    expect(JSON.stringify(nosy)).not.toContain("SECRET")
    expect(await callOutboxMethod({ cardUrl, method: "outbox/ack", params: { ids: [mine.id] }, identity: peers.stranger!.client, sodium })).toEqual({ acked: [mine.id], unknown: [] })
    expect(await callOutboxMethod({ cardUrl, method: "outbox/list", params: { since: "0" }, identity: peers.stranger!.client, sodium })).toMatchObject({ entries: [], nextCursor: null })
    expect(outbox.list(peers.claude!.id).entries).toHaveLength(1)
    const claude = await callOutboxMethod({ cardUrl, method: "outbox/list", params: {}, identity: peers.claude!.client, sodium })
    expect(JSON.stringify(claude)).toContain("SECRET")
  })

  it("refuses a friend whose admission is revoked and a sender the agent does not know", async () => {
    const { peers, cardUrl } = await setup()
    await expect(callOutboxMethod({ cardUrl, method: "outbox/list", params: {}, identity: peers.revoked!.client, sodium })).rejects.toThrow(/A2A error -3200\d/)
    await expect(callOutboxMethod({ cardUrl, method: "outbox/list", params: {}, identity: asSelf(), sodium })).rejects.toThrow(/A2A error -3200\d/)
  })

  it("rejects a call that is not signed, not a message, or whose signed method differs from the requested one", async () => {
    const { peers, cardUrl } = await setup()
    const endpoint = new URL("/a2a", server!.url).toString()
    const rpc = (method: string, params: unknown) => postJsonRpc(endpoint, { jsonrpc: "2.0", id: "1", method, params } as never, fetch)
    expect(await rpc("outbox/list", {})).toMatchObject({ error: { code: -32003 } })
    expect(await rpc("outbox/list", { message: { kind: "message", role: "ROLE_USER", messageId: "m", parts: [{ kind: "text", text: encodeOutboxCommand("outbox/list", {}) }] } })).toMatchObject({ error: { code: -32003, message: "outbox calls must be a signed chat message" } })
    const card = await (await fetch(cardUrl)).json() as { did: string }
    const { parseDidKey } = await import("@ouro.bot/friends/a2a-client")
    const agentKey = parseDidKey(card.did)!
    const seal = (text: string) => sealChatMessage({ sodium, from: peers.claude!.client, recipientDid: card.did, recipientEd25519Pub: agentKey.ed25519Pub, text, conversationId: "c" })
    const send = (method: string, text: string) => rpc(method, { message: { kind: "message", role: "ROLE_USER", messageId: "m", contextId: "c", parts: seal(text).parts } })
    expect(await send("outbox/ack", encodeOutboxCommand("outbox/list", {}))).toMatchObject({ error: { code: -32602 } })
    expect(await send("outbox/list", "just chatting")).toMatchObject({ error: { code: -32602 } })
    const wrongRecipient = sealChatMessage({ sodium, from: peers.claude!.client, recipientDid: asSelf().did, recipientEd25519Pub: agentKey.ed25519Pub, text: encodeOutboxCommand("outbox/list", {}) })
    expect(await rpc("outbox/list", { message: { kind: "message", role: "ROLE_USER", messageId: "m", parts: wrongRecipient.parts } })).toMatchObject({ error: { code: -32003 } })
  })

  it("accepts a signed call that omits the optional message kind and context id", async () => {
    const { peers, cardUrl, outbox } = await setup()
    const entry = outbox.append(peers.stranger!.id, { kind: "await_outcome", body: "hello" })
    const card = await (await fetch(cardUrl)).json() as { did: string }
    const { parseDidKey } = await import("@ouro.bot/friends/a2a-client")
    const sealed = sealChatMessage({ sodium, from: peers.stranger!.client, recipientDid: card.did, recipientEd25519Pub: parseDidKey(card.did)!.ed25519Pub, text: encodeOutboxCommand("outbox/list", {}) })
    const reply = await postJsonRpc(new URL("/a2a", server!.url).toString(), { jsonrpc: "2.0", id: "1", method: "outbox/list", params: { message: { role: "ROLE_USER", messageId: "m", parts: sealed.parts } } } as never, fetch) as { result?: { contextId?: string } }
    expect(reply.result?.contextId).toBe("default")
    expect(entry.id).toBeTruthy()
  })

  it("needs the agent to have a signing identity", async () => {
    const { cardUrl, peers } = await setup({ identity: false })
    await expect(callOutboxMethod({ cardUrl, method: "outbox/list", params: {}, identity: peers.claude!.client, sodium })).rejects.toThrow()
    const endpoint = new URL("/a2a", server!.url).toString()
    expect(await postJsonRpc(endpoint, { jsonrpc: "2.0", id: "1", method: "outbox/list", params: { message: { kind: "message", parts: [] } } } as never, fetch)).toMatchObject({ error: { code: -32003 } })
  })
})

describe("report/resolve and the fix confirmation", () => {
  async function filed(escalation: NonNullable<Parameters<typeof startA2AServer>[0]["escalation"]>) {
    const ctx = await setup({ escalation })
    const result = await fileFailureReport(ctx.agentRoot, ctx.store, { ariWords: "dim the lights", tried: "looked for a lights tool", error: "no lights tool", severity: "medium", origin: { friendId: ctx.peers.ari!.id, channel: "telegram", key: "k" } })
    if (!result.ok) throw new Error("setup failed")
    return { ...ctx, id: result.id }
  }

  const signed = async (key: DidKeyIdentity, id: string) => ({ id, version: "0.1.0-alpha.5", note: "Added lights.", ...await signedResolution(key, { reportId: id, version: "0.1.0-alpha.5", note: "Added lights." }) })

  it("lets the escalation holder resolve, then tells the owner once the running version has the fix", async () => {
    const notices: { noticeId: string; text: string }[] = []
    const { peers, cardUrl, id, agentRoot } = await filed({ runningVersion: "0.1.0-alpha.1", notifyOwner: async (notice) => { notices.push(notice) } })
    await expect(callOutboxMethod({ cardUrl, method: "report/resolve", params: await signed(peers.ari!.client, id), identity: peers.ari!.client, sodium })).rejects.toThrow(/escalation grant/)
    expect(await callOutboxMethod({ cardUrl, method: "report/resolve", params: await signed(peers.claude!.client, id), identity: peers.claude!.client, sodium })).toEqual({ id, status: "resolved" })
    expect(readFailureReport(agentRoot, id)).toMatchObject({ status: "resolved" })
    expect(notices).toEqual([])
    await expect(callOutboxMethod({ cardUrl, method: "report/resolve", params: { id, version: "0.1.0-alpha.5", note: "Added lights." }, identity: peers.claude!.client, sodium })).rejects.toThrow(/invalid|resolvedAt/)
  })

  it("confirms at start and on a timer once the version is live", async () => {
    const notices: { noticeId: string; text: string }[] = []
    const ctx = await filed({ runningVersion: "0.1.0-alpha.9", confirmIntervalMs: 20, notifyOwner: async (notice) => { notices.push(notice) } })
    await callOutboxMethod({ cardUrl: ctx.cardUrl, method: "report/resolve", params: await signed(ctx.peers.claude!.client, ctx.id), identity: ctx.peers.claude!.client, sodium })
    expect(notices.map((notice) => notice.noticeId)).toEqual([`failure-fixed:${ctx.id}`])
    expect(readFailureReport(ctx.agentRoot, ctx.id)).toMatchObject({ status: "closed" })
  })

  it("keeps trying on the timer when the owner notice fails", async () => {
    let attempts = 0
    const ctx = await filed({ runningVersion: "0.1.0-alpha.9", confirmIntervalMs: 15, notifyOwner: async () => { attempts += 1; if (attempts < 3) throw new Error("telegram down") } })
    await callOutboxMethod({ cardUrl: ctx.cardUrl, method: "report/resolve", params: await signed(ctx.peers.claude!.client, ctx.id), identity: ctx.peers.claude!.client, sodium })
    await vi.waitFor(() => expect(readFailureReport(ctx.agentRoot, ctx.id)).toMatchObject({ status: "closed" }), { timeout: 2000 })
    expect(attempts).toBe(3)
  })
})
