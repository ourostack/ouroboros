import { beforeAll, describe, expect, it } from "vitest"
import { didKeyIdentityFromEd25519, parseDidKey, ready, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"

import {
  APPROVAL_REQUEST_ACCEPTED,
  MAX_ACTION_LINE_CHARS,
  RELAY_CODE_ALPHABET,
  approvalActionLine,
  isApprovalRequestMessage,
  isApprovalRequestPayload,
  newRelayCode,
  openApprovalRequest,
  sealApprovalRequest,
  type ApprovalRequestPayload,
} from "../../a2a/approval-request-wire"
import { sendSealedApprovalRequest } from "../../a2a/client"
import { openChatMessage, sealChatMessage } from "../../a2a/sealed-chat"
import type { A2AMessage } from "../../a2a/types"

let sodium: Sodium
beforeAll(async () => { sodium = await ready() })

function mint(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}
const pub = (id: DidKeyIdentity): Uint8Array => parseDidKey(id.did)!.ed25519Pub

const payload = (over: Partial<Record<keyof ApprovalRequestPayload, unknown>> = {}): ApprovalRequestPayload => ({
  relayToken: "t".repeat(43),
  code: "K7Q2",
  actionLine: "Restart plex?",
  decisions: ["deny"],
  expiresAt: "2026-11-23T01:45:00.000Z",
  ...over,
}) as ApprovalRequestPayload

function seal(butler: DidKeyIdentity, slugger: DidKeyIdentity, body: ApprovalRequestPayload = payload()): A2AMessage {
  return { kind: "message", role: "ROLE_USER", messageId: "m1", ...sealApprovalRequest({ sodium, from: butler, recipientDid: slugger.did, recipientEd25519Pub: pub(slugger), payload: body }) } as A2AMessage
}

describe("approval request payload", () => {
  it("accepts exactly the v1 fields", () => {
    expect(isApprovalRequestPayload(payload())).toBe(true)
    expect(isApprovalRequestPayload(payload({ expiresAt: "2026-11-23T01:45:00Z" }))).toBe(true)
  })

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["an extra field", { ...payload(), extra: 1 }],
    ["a missing field", (() => { const { code: _code, ...rest } = payload(); return rest })()],
    ["a short token", payload({ relayToken: "short" })],
    ["a token with other characters", payload({ relayToken: `${"t".repeat(20)}+/` })],
    ["a non-string token", payload({ relayToken: 7 })],
    ["a code with a look-alike", payload({ code: "K0Q2" })],
    ["a lowercase code", payload({ code: "k7q2" })],
    ["a non-string code", payload({ code: 1234 })],
    ["an empty action line", payload({ actionLine: "  " })],
    ["a long action line", payload({ actionLine: "x".repeat(MAX_ACTION_LINE_CHARS + 1) })],
    ["a control character", payload({ actionLine: "Restart\nplex?" })],
    ["a bidi override", payload({ actionLine: "Restart ‮plex?" })],
    ["a non-string action line", payload({ actionLine: 3 })],
    ["approve offered", payload({ decisions: ["approve", "deny"] })],
    ["approve alone", payload({ decisions: ["approve"] })],
    ["decisions not a list", payload({ decisions: "deny" })],
    ["an expiry without a zone", payload({ expiresAt: "2026-11-23T01:45:00" })],
    ["an impossible expiry", payload({ expiresAt: "2026-13-45T01:45:00Z" })],
    ["a non-string expiry", payload({ expiresAt: 5 })],
  ])("refuses %s", (_label, value) => {
    expect(isApprovalRequestPayload(value)).toBe(false)
  })
})

describe("approvalActionLine", () => {
  it("flattens control and bidi characters to single spaces", () => {
    expect(approvalActionLine("  Restart\n\tplex?‮ now\u0007 ")).toBe("Restart plex? now")
  })

  it("names an empty prompt", () => {
    expect(approvalActionLine("\n‏ ")).toBe("Approval request")
  })

  it("caps a long prompt with an ellipsis", () => {
    const line = approvalActionLine("y".repeat(MAX_ACTION_LINE_CHARS + 50))
    expect(line).toHaveLength(MAX_ACTION_LINE_CHARS)
    expect(line.endsWith("…")).toBe(true)
    expect(isApprovalRequestPayload(payload({ actionLine: line }))).toBe(true)
  })
})

describe("newRelayCode", () => {
  it("draws four symbols from the alphabet and skips bytes that would bias it", () => {
    const batches = [[248, 255, 0, 30], [31, 249, 62]]
    const code = newRelayCode(() => Uint8Array.from(batches.shift()!))
    expect(code).toBe(`${RELAY_CODE_ALPHABET[0]}${RELAY_CODE_ALPHABET[30]}${RELAY_CODE_ALPHABET[0]}${RELAY_CODE_ALPHABET[0]}`)
  })

  it("makes a code the payload check accepts", () => {
    const code = newRelayCode((size) => sodium.randombytes_buf(size))
    expect(code).toMatch(new RegExp(`^[${RELAY_CODE_ALPHABET}]{4}$`))
    expect(isApprovalRequestPayload(payload({ code }))).toBe(true)
  })
})

describe("seal and open", () => {
  it("round-trips through a seal, and the token and action line aren't on the wire", async () => {
    const butler = mint()
    const slugger = mint()
    const message = seal(butler, slugger)
    expect(isApprovalRequestMessage(message)).toBe(true)
    const wire = JSON.stringify(message)
    expect(wire).not.toContain("t".repeat(43))
    expect(wire).not.toContain("Restart plex?")
    expect(wire).not.toContain("K7Q2")

    const opened = await openApprovalRequest({ sodium, self: slugger, message, senderDid: butler.did, senderEd25519Pub: pub(butler) })
    expect(opened).toEqual({ ok: true, payload: payload(), issuedAt: expect.any(String) })
  })

  it("is not a friends part, so a receiver that doesn't know the tag can't open it as a chat", async () => {
    const butler = mint()
    const slugger = mint()
    const opened = await openChatMessage({ sodium, self: slugger, message: seal(butler, slugger), senderDid: butler.did, senderEd25519Pub: pub(butler) })
    expect(opened.ok).toBe(false)
  })

  it("refuses to seal a malformed payload", () => {
    expect(() => seal(mint(), mint(), payload({ decisions: ["approve"] }))).toThrow("approval request payload is malformed")
  })

  it("refuses a message from another sender", async () => {
    const butler = mint()
    const slugger = mint()
    const other = mint()
    const opened = await openApprovalRequest({ sodium, self: slugger, message: seal(other, slugger), senderDid: butler.did, senderEd25519Pub: pub(butler) })
    expect(opened.ok).toBe(false)
  })

  it.each([
    ["no parts", { parts: undefined }],
    ["two parts", { parts: [{ kind: "data", data: { ouroKind: "approval_request" } }, { kind: "text", text: "x" }] }],
    ["a text part", { parts: [{ kind: "text", text: "x" }] }],
    ["a data part without the tag", { parts: [{ kind: "data", data: { ouroKind: "mission_result" } }] }],
    ["a data part with null data", { parts: [{ kind: "data", data: null }] }],
  ])("is not a request with %s", async (_label, shape) => {
    const message = { kind: "message", role: "ROLE_USER", messageId: "m", ...shape } as unknown as A2AMessage
    expect(isApprovalRequestMessage(message)).toBe(false)
    const opened = await openApprovalRequest({ sodium, self: mint(), message, senderDid: "did:key:z", senderEd25519Pub: new Uint8Array(32) })
    expect(opened).toEqual({ ok: false, reason: "not_an_approval_request" })
  })

  it.each([
    ["no recipient", { request: { v: 1, sealed: {} } }],
    ["no request", { recipientDid: "did:key:z" }],
    ["a request that isn't an object", { recipientDid: "did:key:z", request: "x" }],
    ["a request without a version", { recipientDid: "did:key:z", request: { sealed: {} } }],
  ])("refuses a tagged part with %s", async (_label, data) => {
    const message = { kind: "message", role: "ROLE_USER", messageId: "m", parts: [{ kind: "data", data: { ouroKind: "approval_request", ...data } }] } as unknown as A2AMessage
    const opened = await openApprovalRequest({ sodium, self: mint(), message, senderDid: "did:key:z", senderEd25519Pub: new Uint8Array(32) })
    expect(opened).toEqual({ ok: false, reason: "malformed_request" })
  })

  it.each([
    ["text that isn't JSON", "Restart plex?"],
    ["JSON without the tag", JSON.stringify({ other: payload() })],
    ["a tagged payload that approves", JSON.stringify({ "ouro.approval-request.v1": payload({ decisions: ["approve"] }) })],
  ])("refuses a sealed request whose text is %s", async (_label, text) => {
    const butler = mint()
    const slugger = mint()
    const chat = sealChatMessage({ sodium, from: butler, recipientDid: slugger.did, recipientEd25519Pub: pub(slugger), text })
    const data = (chat.parts[0] as unknown as { data: { v: number; sealed: unknown; recipientDid: string } }).data
    const message = { kind: "message", role: "ROLE_USER", messageId: "m", parts: [{ kind: "data", data: { ouroKind: "approval_request", recipientDid: data.recipientDid, request: { v: data.v, sealed: data.sealed } } }] } as unknown as A2AMessage
    const opened = await openApprovalRequest({ sodium, self: slugger, message, senderDid: butler.did, senderEd25519Pub: pub(butler) })
    expect(opened).toEqual({ ok: false, reason: "malformed_request" })
  })
})

describe("sendSealedApprovalRequest", () => {
  const cardUrl = "http://slugger.test/.well-known/agent-card.json"

  /** A fake peer: serves a card, opens the request as Slugger's harness would, and answers with `reply`. */
  function peer(slugger: DidKeyIdentity, butler: DidKeyIdentity, reply: (message: A2AMessage) => unknown, cardDidOverride?: string) {
    const received: A2AMessage[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === cardUrl) {
        return new Response(JSON.stringify({ name: "Slugger", did: cardDidOverride ?? slugger.did, url: "http://slugger.test/a2a", preferredTransport: "JSONRPC" }), { status: 200 })
      }
      const body = JSON.parse(String(init!.body)) as { id: string; params: { message: A2AMessage } }
      received.push(body.params.message)
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(reply(body.params.message) as object) }), { status: 200 })
    }) as unknown as typeof fetch
    const sealedReply = (text: string, from: DidKeyIdentity = slugger) => ({
      result: { id: "task", status: { state: "completed", message: { kind: "message", role: "agent", messageId: "r", ...sealChatMessage({ sodium, from, recipientDid: butler.did, recipientEd25519Pub: pub(butler), text }) } } },
    })
    return { fetchImpl, received, sealedReply }
  }

  it("hands the sealed request over and accepts the harness's receipt", async () => {
    const butler = mint()
    const slugger = mint()
    let opened: unknown
    const fake = peer(slugger, butler, () => fake.sealedReply(APPROVAL_REQUEST_ACCEPTED))
    await sendSealedApprovalRequest({ cardUrl, peerDid: slugger.did, payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })
    opened = await openApprovalRequest({ sodium, self: slugger, message: fake.received[0]!, senderDid: butler.did, senderEd25519Pub: pub(butler) })
    expect(opened).toMatchObject({ ok: true, payload: payload() })
  })

  it("refuses a card that serves another DID, sending nothing", async () => {
    const butler = mint()
    const slugger = mint()
    const fake = peer(slugger, butler, () => fake.sealedReply(APPROVAL_REQUEST_ACCEPTED), mint().did)
    await expect(sendSealedApprovalRequest({ cardUrl, peerDid: slugger.did, payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })).rejects.toThrow("doesn't serve the pinned")
    expect(fake.received).toHaveLength(0)
  })

  it("refuses a pinned DID that isn't a did:key", async () => {
    const butler = mint()
    const slugger = mint()
    const fake = peer(slugger, butler, () => fake.sealedReply(APPROVAL_REQUEST_ACCEPTED), "did:web:slugger.test")
    await expect(sendSealedApprovalRequest({ cardUrl, peerDid: "did:web:slugger.test", payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })).rejects.toThrow("doesn't serve the pinned")
  })

  it("throws a peer's JSON-RPC error, as today's Slugger answers a part it doesn't know", async () => {
    const butler = mint()
    const slugger = mint()
    const fake = peer(slugger, butler, () => ({ error: { code: -32602, message: "malformed" } }))
    await expect(sendSealedApprovalRequest({ cardUrl, peerDid: slugger.did, payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })).rejects.toThrow("malformed")
  })

  it("throws when the peer returns no reply message", async () => {
    const butler = mint()
    const slugger = mint()
    const fake = peer(slugger, butler, () => ({ result: { id: "task", status: { state: "completed" } } }))
    await expect(sendSealedApprovalRequest({ cardUrl, peerDid: slugger.did, payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })).rejects.toThrow("no reply message")
  })

  it("throws on a reply sealed by someone other than the pinned peer", async () => {
    const butler = mint()
    const slugger = mint()
    const fake = peer(slugger, butler, () => fake.sealedReply(APPROVAL_REQUEST_ACCEPTED, mint()))
    await expect(sendSealedApprovalRequest({ cardUrl, peerDid: slugger.did, payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })).rejects.toThrow("approval request reply rejected")
  })

  it("throws when a model, not the harness, answered", async () => {
    const butler = mint()
    const slugger = mint()
    const fake = peer(slugger, butler, () => fake.sealedReply("Sure, I'll let Ari know!"))
    await expect(sendSealedApprovalRequest({ cardUrl, peerDid: slugger.did, payload: payload(), identity: butler, sodium, fetchImpl: fake.fetchImpl })).rejects.toThrow("didn't take the approval request")
  })
})
