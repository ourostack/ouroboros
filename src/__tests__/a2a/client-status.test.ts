import { describe, expect, it } from "vitest"
import { A2AHttpStatusError, A2ARpcError, postJsonRpc } from "../../a2a/client"

const request = { jsonrpc: "2.0" as const, id: "1", method: "message/send", params: {} }

describe("postJsonRpc on a non-2xx reply", () => {
  it("returns a JSON-RPC answer carried on an error status (the peer decided)", async () => {
    const body = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } }
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 413 })) as typeof fetch
    expect(await postJsonRpc("https://peer/a2a", request, fetchImpl)).toEqual(body)
    const result = { jsonrpc: "2.0", id: "1", result: { ok: true } }
    expect(await postJsonRpc("https://peer/a2a", request, (async () => new Response(JSON.stringify(result), { status: 500 })) as typeof fetch)).toEqual(result)
  })

  it("throws a status error when something other than the agent answered", async () => {
    for (const text of ["<html>tunnel offline</html>", "null", JSON.stringify({ jsonrpc: "1.0", error: {} }), JSON.stringify({ jsonrpc: "2.0" })]) {
      const error = await postJsonRpc("https://peer/a2a", request, (async () => new Response(text, { status: 404, statusText: "Not Found" })) as typeof fetch).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(A2AHttpStatusError)
      expect(error).not.toBeInstanceOf(A2ARpcError)
      expect(error).toMatchObject({ status: 404, message: "A2A JSON-RPC request failed (404 Not Found)" })
    }
  })

  it("treats an unreadable error body as not an answer", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 502, statusText: "Bad Gateway", text: () => Promise.reject(new Error("aborted")) })) as unknown as typeof fetch
    await expect(postJsonRpc("https://peer/a2a", request, fetchImpl)).rejects.toMatchObject({ status: 502 })
  })
})
