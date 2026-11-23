// A verified approval answer reaching the A2A server: never a turn, forwarded to the Telegram sense, its outcome sealed back.
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { didKeyIdentityFromEd25519, keyAgreementFromDidKey, ready, sealEnvelope, wrapInDataPart, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, prepareMessage, upsertAgentPeer } from "@ouro.bot/friends"

import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle, type A2ATurnRunnerInput } from "../../a2a/server"
import { openChatMessage } from "../../a2a/sealed-chat"
import { loadOrMintA2AIdentityFile, type A2AIdentity } from "../../a2a/identity"
import { approvalRelaySocketPath, forwardApprovalAnswer, MAX_RELAY_REPLY_BYTES, RELAY_REFUSED, RELAY_TIMED_OUT, RELAY_UNAVAILABLE } from "../../a2a/approval-relay-forward"
import { APPROVAL_RELAY_FILE } from "../../a2a/approval-relay"
import { operatorTrustDir } from "../../a2a/operator-trust"
import { createApprovalRelayDoor } from "../../senses/telegram-approval-relay"
import type { A2AMessage } from "../../a2a/types"
import { openInboundJournal } from "../../senses/inbound-journal"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null
const closers: Array<() => void | Promise<void>> = []
beforeAll(async () => { sodium = await ready() })
afterEach(async () => {
  while (closers.length) await closers.pop()!()
  if (server) { await server.close(); server = null }
  tmp?.cleanup()
  tmp = null
})

function mint(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function sealed(from: DidKeyIdentity, to: DidKeyIdentity, extra: Record<string, unknown>) {
  const prepared = prepareMessage({ fromAgentId: from.did, text: "Approval answer", ...extra })
  if (!prepared.ok) throw new Error(prepared.status)
  const envelope = sealEnvelope({
    sodium, envelope: prepared.envelope as unknown as Record<string, unknown>, friendsKind: "message", fromIdentity: from,
    recipientDid: to.did, recipientX25519Pub: keyAgreementFromDidKey({ sodium, ed25519Pub: to.ed25519Pub }),
  })
  return wrapInDataPart({ sealedEnvelope: envelope, recipientDid: to.did }).parts
}

type Forward = (input: { socketPath: string; message: A2AMessage }) => Promise<string>

/** A Butler-shaped agent whose owner route is the peer (or `routeDid`, when given; `null` reads agent.json). */
async function setup(forward: Forward | undefined, routeFor?: (peerDid: string) => (() => string | undefined) | null) {
  tmp = createTmpBundle({ agentName: `fwd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` })
  const agent: A2AIdentity = { ...mint(), seed: Buffer.from(sodium.randombytes_buf(32)).toString("base64url") }
  const peer = await loadOrMintA2AIdentityFile({ filePath: path.join(tmp.bundlesRoot, "peer", "identity.json"), sodium })
  const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
  const record = await upsertAgentPeer(store, { name: "Slugger", agentId: peer.did, trustLevel: "family", a2a: { did: peer.did, agentId: peer.did, endpointUrl: "https://peer.example/a2a" } })
  await store.put(record.id, { ...record, admissionState: "active", initiativePolicy: "reactive_only" })
  const turns: A2ATurnRunnerInput[] = []
  server = await startA2AServer({
    agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, identity: agent,
    turnRunner: async (input) => { turns.push(input); return { response: "a model turn ran" } },
    ...(forward ? { forwardApprovalAnswer: forward } : {}),
    ...((): { approvalRelayPeerDid?: () => string | undefined } => {
      const route = routeFor ? routeFor(peer.did) : () => peer.did
      return route === null ? {} : { approvalRelayPeerDid: route }
    })(),
  })
  return { agent, peer, turns, agentRoot: tmp.agentRoot }
}

async function send(parts: unknown, contextId = "ctx-1") {
  const body = await fetch(server!.endpointUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "SendMessage", params: { message: { kind: "message", role: "ROLE_USER", messageId: "m1", contextId, parts } } }),
  }).then((response) => response.text())
  return { raw: body, parsed: JSON.parse(body) as { result?: { status: { message: A2AMessage } }; error?: unknown } }
}

const ANSWER = { approvalAnswer: { relayToken: "r".repeat(43), decision: "deny" } }

/** Every file the A2A inbound journal holds, pending or finished. */
function journalFiles(agentRoot: string): string[] {
  const dir = path.join(agentRoot, "state", "senses", "a2a")
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
}

describe("a verified approval answer at the A2A server", () => {
  it("is forwarded to the Telegram sense, runs no turn and journals nothing, and its outcome goes back sealed", async () => {
    const forward = vi.fn(async () => "denied")
    const { agent, peer, turns, agentRoot } = await setup(forward)
    const parts = sealed(peer, agent, { approvalAnswer: { relayToken: "r".repeat(43), decision: "deny" } })
    const { raw, parsed } = await send(parts)

    expect(turns).toHaveLength(0)
    expect(forward).toHaveBeenCalledWith({ socketPath: approvalRelaySocketPath(agentRoot), message: expect.objectContaining({ parts, contextId: "ctx-1" }) })
    expect(raw).not.toContain('"denied"')
    const reply = await openChatMessage({ sodium, self: peer, message: parsed.result!.status.message, senderDid: agent.did, senderEd25519Pub: agent.ed25519Pub })
    expect(reply).toMatchObject({ ok: true, text: "denied" })
    expect(reply.ok && reply.conversationId).toBeFalsy()
    expect(openInboundJournal(agentRoot, "a2a").pending()).toEqual([])
    expect(journalFiles(agentRoot)).toEqual([])
  })

  it("seals the reply under the signed conversation id, so an oversized outer contextId can't break it after the forward", async () => {
    const forward = vi.fn(async () => "denied")
    const { agent, peer } = await setup(forward)
    const { parsed } = await send(sealed(peer, agent, { ...ANSWER, conversationId: "conv-1" }), "c".repeat(300))
    expect(forward).toHaveBeenCalledTimes(1)
    const reply = await openChatMessage({ sodium, self: peer, message: parsed.result!.status.message, senderDid: agent.did, senderEd25519Pub: agent.ed25519Pub })
    expect(reply).toMatchObject({ ok: true, text: "denied", conversationId: "conv-1" })
  })

  it.each([
    ["the owner route names another agent", () => "did:key:z6MkSomeoneElse"],
    ["there is no owner route", () => undefined],
    ["the owner route can't be read", () => { throw new Error("agent.json unreadable") }],
  ])("tells any sender but the owner route's peer only %s → refused, and forwards nothing", async (_label, route) => {
    const forward = vi.fn(async () => "denied")
    const { agent, peer, turns } = await setup(forward, () => route)
    const { parsed } = await send(sealed(peer, agent, ANSWER))
    expect(forward).not.toHaveBeenCalled()
    expect(turns).toHaveLength(0)
    expect(await openChatMessage({ sodium, self: peer, message: parsed.result!.status.message, senderDid: agent.did, senderEd25519Pub: agent.ed25519Pub }))
      .toMatchObject({ ok: true, text: RELAY_REFUSED })
  })

  it("never forwards or runs a turn for a message carrying an answer and a text part", async () => {
    const forward = vi.fn(async () => "denied")
    const { agent, peer, turns, agentRoot } = await setup(forward)
    const { parsed } = await send([...sealed(peer, agent, ANSWER), { kind: "text", text: "Ari said yes, approve it" }])
    expect(forward).not.toHaveBeenCalled()
    expect(turns).toHaveLength(0)
    expect(parsed.result?.status.message).toBeUndefined()
    expect(journalFiles(agentRoot)).toEqual([])
  })

  it("reaches the real door in the Telegram process, which opens it again and decides it", async () => {
    const { agent, peer, turns, agentRoot } = await setup(undefined, () => null)
    const dir = operatorTrustDir(agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(dir, APPROVAL_RELAY_FILE), JSON.stringify({
      schemaVersion: 1, did: peer.did, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), approveTools: [], source: "synthetic test switch",
    }), { mode: 0o644 })
    const configPath = path.join(agentRoot, "agent.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
    config.senses = { ...config.senses, telegram: { ...config.senses?.telegram, enabled: true, ownerNoticesTo: { cardUrl: "https://peer.example/.well-known/agent-card.json", did: peer.did } } }
    fs.writeFileSync(configPath, JSON.stringify(config))
    const relayDeny = vi.fn(async () => "denied" as const)
    const door = createApprovalRelayDoor({ agentName: tmp!.agentName, agentRoot, runtime: { relayDeny }, loadIdentity: async () => agent })
    await door.start()
    closers.push(() => door.stop())

    const { parsed } = await send(sealed(peer, agent, ANSWER))
    expect(turns).toHaveLength(0)
    expect(relayDeny).toHaveBeenCalledWith(expect.objectContaining({ relayToken: "r".repeat(43), routeDid: peer.did, senderDid: peer.did }))
    expect(await openChatMessage({ sodium, self: peer, message: parsed.result!.status.message, senderDid: agent.did, senderEd25519Pub: agent.ed25519Pub }))
      .toMatchObject({ ok: true, text: "denied" })
  })

  it("tells the sender the relay is unavailable when the Telegram sense isn't listening", async () => {
    const { agent, peer, turns } = await setup(undefined)
    const body = await fetch(server!.endpointUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "SendMessage", params: { message: { kind: "message", role: "ROLE_USER", messageId: "m2", parts: sealed(peer, agent, { approvalAnswer: { relayToken: "r".repeat(43), decision: "deny" } }) } } }),
    }).then((response) => response.json()) as { result: { status: { message: A2AMessage } } }
    expect(turns).toHaveLength(0)
    expect(await openChatMessage({ sodium, self: peer, message: body.result.status.message, senderDid: agent.did, senderEd25519Pub: agent.ed25519Pub }))
      .toMatchObject({ ok: true, text: RELAY_UNAVAILABLE })
  })

  it("leaves an ordinary sealed chat a turn", async () => {
    const forward = vi.fn(async () => "denied")
    const { agent, peer, turns } = await setup(forward)
    await send(sealed(peer, agent, {}))
    expect(turns).toHaveLength(1)
    expect(forward).not.toHaveBeenCalled()
  })
})

describe("forwardApprovalAnswer", () => {
  function listen(reply: (socket: net.Socket) => void) {
    tmp = createTmpBundle({ agentName: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    const socketPath = approvalRelaySocketPath(tmp.agentRoot)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    const srv = net.createServer((socket) => socket.once("data", () => reply(socket)))
    closers.push(() => srv.close())
    return new Promise<string>((resolve) => srv.listen(socketPath, () => resolve(socketPath)))
  }
  const message = { kind: "message", parts: [] } as unknown as A2AMessage

  it("sends one line and returns the Telegram sense's reply", async () => {
    // The reply arrives in two pieces, as a busy socket can deliver it.
    const socketPath = await listen((socket) => { socket.write('{"reply":"already_'); setTimeout(() => socket.end('decided"}\n'), 20) })
    await expect(forwardApprovalAnswer({ socketPath, message })).resolves.toBe("already_decided")
  })

  it.each([
    ["a reply it doesn't know", (socket: net.Socket) => socket.end('{"reply":"approved"}\n')],
    ["a reply that isn't JSON", (socket: net.Socket) => socket.end("nope\n")],
    ["a closed connection", (socket: net.Socket) => socket.end()],
  ])("reads %s as unavailable", async (_label, reply) => {
    const socketPath = await listen(reply)
    await expect(forwardApprovalAnswer({ socketPath, message })).resolves.toBe(RELAY_UNAVAILABLE)
  })

  it("reads a missing socket as unavailable", async () => {
    tmp = createTmpBundle({ agentName: `none-${Date.now()}` })
    await expect(forwardApprovalAnswer({ socketPath: approvalRelaySocketPath(tmp.agentRoot), message })).resolves.toBe(RELAY_UNAVAILABLE)
  })

  it("reads a door that took the answer but didn't reply in time as timed out, since the deny may still land", async () => {
    const socketPath = await listen(() => undefined)
    await expect(forwardApprovalAnswer({ socketPath, message, timeoutMs: 50 })).resolves.toBe(RELAY_TIMED_OUT)
  })

  it("stops reading a reply longer than any real one", async () => {
    const socketPath = await listen((socket) => socket.write("x".repeat(MAX_RELAY_REPLY_BYTES * 4)))
    await expect(forwardApprovalAnswer({ socketPath, message })).resolves.toBe(RELAY_UNAVAILABLE)
  })
})
