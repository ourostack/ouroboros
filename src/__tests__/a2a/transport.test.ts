import { describe, expect, it, vi } from "vitest"
import type { A2AMessage as FriendsA2AMessage } from "@ouro.bot/friends/a2a-client"
import { makeA2ATransport } from "../../a2a/transport"

/** A minimal wrapped friends DataPart message (the shape sendShare/wrapInDataPart produces). */
function dataPartMessage(): FriendsA2AMessage {
  return {
    messageId: "m-1",
    role: "agent",
    parts: [{ kind: "data", data: { v: 1, sealed: { n: "nonce", c: "cipher" } as never, recipientDid: "did:key:zRecipient" } }],
  }
}

describe("A2ATransport (direct rung)", () => {
  it("direct rung POSTs the wrapped message as message/send to the address", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: (calls.at(-1)!.body as { id: string }).id, result: { id: "task-1", contextId: "c", status: { state: "completed", timestamp: "" }, history: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const transport = makeA2ATransport({ fetchImpl })
    const message = dataPartMessage()
    await transport.send({ rung: "direct", address: "https://peer.example/a2a" }, message)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://peer.example/a2a")
    const body = calls[0].body as { method: string; params: { message: FriendsA2AMessage } }
    expect(body.method).toMatch(/message\/send|SendMessage/i)
    // The posted body carries the wrapped DataPart message (the sealed envelope).
    expect(body.params.message.parts[0]).toMatchObject({ kind: "data" })
    expect(body.params.message.parts[0].data.recipientDid).toBe("did:key:zRecipient")
  })

  it("relay rung throws a typed not-wired error (the stubbed seam)", async () => {
    const transport = makeA2ATransport({ fetchImpl: (async () => new Response("{}")) as typeof fetch })
    await expect(transport.send({ rung: "relay", address: "relay-handle" }, dataPartMessage()))
      .rejects.toThrow(/not wired.*friends-relay/i)
  })

  it("mailbox rung throws the same typed not-wired error", async () => {
    const transport = makeA2ATransport({ fetchImpl: (async () => new Response("{}")) as typeof fetch })
    await expect(transport.send({ rung: "mailbox", address: "mailbox-handle" }, dataPartMessage()))
      .rejects.toThrow(/not wired.*friends-relay/i)
  })

  it("retries with SendMessage when the server replies method-not-found to message/send", async () => {
    const methods: string[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: string }
      methods.push(body.method)
      if (body.method === "message/send") {
        // First attempt: the server doesn't speak message/send → -32601.
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } }), { status: 200, headers: { "content-type": "application/json" } })
      }
      // Fallback SendMessage succeeds.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { id: "t", contextId: "c", status: { state: "completed", timestamp: "" }, history: [] } }), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch

    const transport = makeA2ATransport({ fetchImpl })
    await transport.send({ rung: "direct", address: "https://peer.example/a2a" }, dataPartMessage())
    expect(methods).toEqual(["message/send", "SendMessage"])
  })

  it("throws when the server returns a JSON-RPC error (not method-not-found)", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(String(init?.body)) as { id: string }).id, error: { code: -32000, message: "boom" } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
    const transport = makeA2ATransport({ fetchImpl })
    await expect(transport.send({ rung: "direct", address: "https://peer.example/a2a" }, dataPartMessage()))
      .rejects.toThrow(/boom|-32000/i)
  })

  it("surfaces a transport-level POST failure (non-2xx) as a thrown error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503, statusText: "unavailable" })) as typeof fetch
    const transport = makeA2ATransport({ fetchImpl })
    await expect(transport.send({ rung: "direct", address: "https://peer.example/a2a" }, dataPartMessage()))
      .rejects.toThrow(/503|failed/i)
  })
})

describe("A2ATransport (relay fallback, real fetch)", () => {
  // These use Node's real fetch so the fallback rule is proven against real failure shapes, not a mock's.
  const http = require("node:http") as typeof import("node:http")
  const relayMessage = (): FriendsA2AMessage => ({
    messageId: "m-r",
    role: "agent",
    parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct: "c" } as never, recipientDid: "did:key:zPeer" } }],
  })

  async function serve(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as import("node:net").AddressInfo).port
    return { url: `http://127.0.0.1:${port}/a2a`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  /** A peer that answers 200 with `reply(the request's id)`, as the A2A server does. */
  function serveJsonRpc(reply: (id: unknown) => unknown): ReturnType<typeof serve> {
    return serve((req, res) => {
      let raw = ""
      req.on("data", (chunk) => { raw += String(chunk) })
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(reply((JSON.parse(raw) as { id: unknown }).id)))
      })
    })
  }

  async function closedPortUrl(): Promise<string> {
    const s = await serve(() => undefined)
    await s.close()
    return s.url
  }

  it("queues the same message at the relay when the peer's port is closed", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    try {
      relay.registrations.set("h1", { did: "did:key:zPeer", inboxAuth: "ia", sendCredential: "sc", agentCard: {} })
      relay.inbox.set("h1", [])
      const rungs: string[] = []
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "sc" }, onDelivered: (rung) => rungs.push(rung) })
      const message = relayMessage()
      await transport.send({ rung: "direct", address: await closedPortUrl() }, message)
      expect(rungs).toEqual(["relay"])
      expect(relay.inbox.get("h1")!.map((m) => m.message)).toEqual([message])
    } finally {
      await relay.close()
    }
  })

  it("does not fall back when the peer answers 413 with a JSON-RPC body", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    const peer = await serve((_req, res) => { res.writeHead(413, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } })) })
    try {
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "sc" } })
      await expect(transport.send({ rung: "direct", address: peer.url }, relayMessage())).rejects.toThrow(/request body too large/)
      expect(relay.requests).toHaveLength(0)
    } finally {
      await Promise.all([relay.close(), peer.close()])
    }
  })

  it("says the direct copy may have arrived after a reset or a gateway timeout", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    const reset = await serve((req) => req.socket.destroy())
    const gateway = await serve((_req, res) => { res.writeHead(504, { "content-type": "text/html" }); res.end("gateway timeout") })
    const originTimeout = await serve((_req, res) => { res.writeHead(524, { "content-type": "text/html" }); res.end("a timeout occurred") })
    const parked = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>parked</html>") })
    try {
      relay.registrations.set("h1", { did: "did:key:zPeer", inboxAuth: "ia", sendCredential: "sc", agentCard: {} })
      relay.inbox.set("h1", [])
      const details: unknown[] = []
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "sc" }, onDelivered: (_rung, detail) => details.push(detail) })
      await transport.send({ rung: "direct", address: reset.url }, relayMessage())
      await transport.send({ rung: "direct", address: gateway.url }, relayMessage())
      await transport.send({ rung: "direct", address: originTimeout.url }, relayMessage())
      await transport.send({ rung: "direct", address: await closedPortUrl() }, relayMessage())
      await transport.send({ rung: "direct", address: parked.url }, relayMessage())
      expect(details).toEqual([{ directMayHaveArrived: true }, { directMayHaveArrived: true }, { directMayHaveArrived: true }, { directMayHaveArrived: false }, { directMayHaveArrived: false }])
      relay.failNext("send", 503, "busy")
      await expect(transport.send({ rung: "direct", address: gateway.url }, relayMessage())).rejects.toThrow(/relay 503 busy\); the message may not have been delivered/)
      await expect(makeA2ATransport().send({ rung: "direct", address: reset.url }, relayMessage())).rejects.toThrow(/; it may not have been delivered, and the peer has shared no relay contact/)
    } finally {
      await Promise.all([relay.close(), reset.close(), gateway.close(), parked.close()])
    }
  })

  it("marks nothing when the relay refuses and no callback was given", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    try {
      await expect(makeA2ATransport({ relayContact: { url: relay.url, handle: "gone", sendCredential: "sc" } }).send({ rung: "direct", address: await closedPortUrl() }, relayMessage()))
        .rejects.toThrow(/relay 404 unknown_handle/)
    } finally {
      await relay.close()
    }
  })

  it("falls back when the connection is reset and when a tunnel answers with a non-JSON-RPC page", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    const reset = await serve((req) => req.socket.destroy())
    const tunnel = await serve((_req, res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("<html>tunnel offline</html>") })
    const htmlOk = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>parked</html>") })
    try {
      relay.registrations.set("h1", { did: "did:key:zPeer", inboxAuth: "ia", sendCredential: "sc", agentCard: {} })
      relay.inbox.set("h1", [])
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "sc" } })
      await transport.send({ rung: "direct", address: reset.url }, relayMessage())
      await transport.send({ rung: "direct", address: tunnel.url }, relayMessage())
      await transport.send({ rung: "direct", address: htmlOk.url }, relayMessage())
      expect(relay.inbox.get("h1")).toHaveLength(3)
    } finally {
      await Promise.all([relay.close(), reset.close(), tunnel.close(), htmlOk.close()])
    }
  })

  it("falls back when something answers 200 with JSON that is not a JSON-RPC response (another service on the peer's host)", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    const other = await serve((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}") })
    try {
      relay.registrations.set("h1", { did: "did:key:zPeer", inboxAuth: "ia", sendCredential: "sc", agentCard: {} })
      relay.inbox.set("h1", [])
      const deliveries: Array<[string, unknown]> = []
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "sc" }, onDelivered: (rung, detail) => deliveries.push([rung, detail]) })
      await transport.send({ rung: "direct", address: other.url }, relayMessage())
      expect(deliveries).toEqual([["relay", { directMayHaveArrived: false }]])
      expect(relay.inbox.get("h1")).toHaveLength(1)
    } finally {
      await Promise.all([relay.close(), other.close()])
    }
  })

  it("does not fall back when the peer answers with a JSON-RPC error", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    const peer = await serveJsonRpc((id) => ({ jsonrpc: "2.0", id, error: { code: -32003, message: "A2A share rejected: untrusted_source" } }))
    try {
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "sc" } })
      await expect(transport.send({ rung: "direct", address: peer.url }, relayMessage())).rejects.toThrow(/untrusted_source/)
      expect(relay.requests).toHaveLength(0)
    } finally {
      await Promise.all([relay.close(), peer.close()])
    }
  })

  it("reports delivery over direct to the callback", async () => {
    const peer = await serveJsonRpc((id) => ({ jsonrpc: "2.0", id, result: { id: "t" } }))
    try {
      const rungs: string[] = []
      await makeA2ATransport({ onDelivered: (rung) => rungs.push(rung) }).send({ rung: "direct", address: peer.url }, relayMessage())
      expect(rungs).toEqual(["direct"])
    } finally {
      await peer.close()
    }
  })

  it("says the peer shared no relay contact when there is none", async () => {
    await expect(makeA2ATransport().send({ rung: "direct", address: await closedPortUrl() }, relayMessage()))
      .rejects.toThrow(/fetch failed \(ECONNREFUSED\); it was not delivered, and the peer has shared no relay contact/)
    // "localhost" resolves to two addresses, so the refusal arrives as an AggregateError with inner codes.
    await expect(makeA2ATransport().send({ rung: "direct", address: (await closedPortUrl()).replace("127.0.0.1", "localhost") }, relayMessage()))
      .rejects.toThrow(/; it was not delivered, and the peer has shared no relay contact/)
  })

  it("names both causes and marks the contact refused when the relay rejects the credential", async () => {
    const { startFakeRelay } = await import("../test-helpers/fake-relay")
    const relay = await startFakeRelay()
    try {
      relay.registrations.set("h1", { did: "did:key:zPeer", inboxAuth: "ia", sendCredential: "rotated", agentCard: {} })
      let refused = 0
      const transport = makeA2ATransport({ relayContact: { url: relay.url, handle: "h1", sendCredential: "old" }, onRelayContactRefused: () => { refused += 1 } })
      await expect(transport.send({ rung: "direct", address: await closedPortUrl() }, relayMessage()))
        .rejects.toThrow(/not reachable directly \(fetch failed \(ECONNREFUSED\)\) or through its relay \(relay 403 bad_send_credential\); the message was not delivered/)
      expect(refused).toBe(1)
      relay.failNext("send", 503, "busy")
      await expect(transport.send({ rung: "direct", address: await closedPortUrl() }, relayMessage())).rejects.toThrow(/relay 503 busy/)
      expect(refused).toBe(1)
    } finally {
      await relay.close()
    }
  })

  it("names a relay that cannot be reached at all", async () => {
    const transport = makeA2ATransport({ relayContact: { url: (await closedPortUrl()).replace(/\/a2a$/, ""), handle: "h1", sendCredential: "sc" } })
    await expect(transport.send({ rung: "direct", address: await closedPortUrl() }, relayMessage()))
      .rejects.toThrow(/or through its relay \(fetch failed \(ECONNREFUSED\)\)/)
  })
})
