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
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { id: "task-1", contextId: "c", status: { state: "completed", timestamp: "" }, history: [] } }), {
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

  it("surfaces a transport-level POST failure (non-2xx) as a thrown error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503, statusText: "unavailable" })) as typeof fetch
    const transport = makeA2ATransport({ fetchImpl })
    await expect(transport.send({ rung: "direct", address: "https://peer.example/a2a" }, dataPartMessage()))
      .rejects.toThrow(/503|failed/i)
  })
})
