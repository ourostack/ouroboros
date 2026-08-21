import { describe, expect, it, vi } from "vitest"

import { UnraidClient, UnraidClientError } from "../../repertoire/unraid-client"

const DOC = "query SanctuaryContainers { docker { containers(skipCache: true) { id } } }"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("Unraid GraphQL client", () => {
  it("posts the fixed document and variables with the Unraid API-key header", async () => {
    let request: Request | undefined
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init)
      return response({ data: { docker: { containers: [] } } })
    })
    const client = new UnraidClient({ endpoint: "http://127.0.0.1:80/graphql", apiKey: "private-key", fetch })
    await expect(client.read(DOC, { exact: "value" })).resolves.toEqual({ docker: { containers: [] } })
    expect(request?.url).toBe("http://127.0.0.1/graphql")
    expect(request?.method).toBe("POST")
    expect(request?.headers.get("x-api-key")).toBe("private-key")
    expect(request?.headers.get("content-type")).toBe("application/json")
    expect(request?.headers.has("authorization")).toBe(false)
    expect(await request?.json()).toEqual({ query: DOC, variables: { exact: "value" } })
  })

  it("retries reads only for pre-response transport failures and 429/502/503/504", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ error: "busy" }, 503))
      .mockResolvedValueOnce(response({ data: { ok: true } }))
    const sleep = vi.fn(async () => undefined)
    const client = new UnraidClient({ endpoint: "http://127.0.0.1/graphql", apiKey: "key", fetch, sleep })
    await expect(client.read(DOC, {})).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const call of fetch.mock.calls) {
      expect(call).toEqual(["http://127.0.0.1/graphql", expect.objectContaining({
        method: "POST",
        headers: { "x-api-key": "key", "Content-Type": "application/json" },
        body: JSON.stringify({ query: DOC, variables: {} }),
        signal: expect.any(AbortSignal),
      })])
    }
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 1000])
  })

  it("never retries a mutation, including ambiguous transport failure", async () => {
    const fetch = vi.fn(async () => { throw new Error("connection closed") })
    const client = new UnraidClient({ endpoint: "http://127.0.0.1/graphql", apiKey: "write-key", fetch })
    await expect(client.mutate("mutation SanctuaryRestart { docker { restart(id: \"x\") { id } } }", {}))
      .rejects.toMatchObject({ code: "transport", ambiguous: true })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("fails closed on GraphQL errors and redacts credentials", async () => {
    const fetch = vi.fn(async () => response({ errors: [{ message: "forbidden private-key" }] }))
    const client = new UnraidClient({ endpoint: "http://127.0.0.1/graphql", apiKey: "private-key", fetch })
    const error = await client.read(DOC, {}).catch((caught) => caught) as UnraidClientError
    expect(error.code).toBe("graphql")
    expect(error.message).not.toContain("private-key")
    expect(error.message.length).toBeLessThanOrEqual(240)
  })

  it("rejects invalid envelopes and non-prefixed response ids", async () => {
    const client = new UnraidClient({ endpoint: "http://127.0.0.1/graphql", apiKey: "key", fetch: vi.fn(async () => response({ nope: true })) })
    await expect(client.read(DOC, {})).rejects.toMatchObject({ code: "invalid_response" })
    expect(() => UnraidClient.assertPrefixedId("raw-id")).toThrow("prefixed")
    expect(UnraidClient.assertPrefixedId("sanctuary:abc123")).toBe("sanctuary:abc123")
  })

  it("rejects malformed endpoints, blank keys, and oversized or malformed prefixed ids", () => {
    for (const endpoint of ["not a url", "ftp://host/graphql", "http://user:pass@host/graphql", "http://host/graphql?q=1", "http://host/graphql#x"]) {
      expect(() => new UnraidClient({ endpoint, apiKey: "key" })).toThrow("endpoint is invalid")
    }
    expect(() => new UnraidClient({ endpoint: "https://host/graphql", apiKey: "  " })).toThrow("API key is missing")
    expect(() => UnraidClient.assertPrefixedId(`scope:${"x".repeat(251)}`)).toThrow("bounded prefixed ID")
    expect(() => UnraidClient.assertPrefixedId("a:b:c")).toThrow("prefixed ID")
  })

  it("sends an exact mutation request and honors a caller abort signal", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        headers: { "x-api-key": "write-key", "Content-Type": "application/json" },
        body: JSON.stringify({ query: "mutation Restart($id: ID!) { restart(id: $id) { id } }", variables: { id: "Docker:abc" } }),
      })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException("aborted", "AbortError")
    })
    const controller = new AbortController()
    controller.abort()
    const client = new UnraidClient({ endpoint: "https://host/graphql", apiKey: " write-key ", fetch })
    await expect(client.mutate("mutation Restart($id: ID!) { restart(id: $id) { id } }", { id: "Docker:abc" }, controller.signal))
      .rejects.toMatchObject({ code: "transport", ambiguous: true })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "transport"],
  ] as const)("maps HTTP %i to %s without retry", async (status, code) => {
    const fetch = vi.fn(async () => response({ error: "nope" }, status))
    const client = new UnraidClient({ endpoint: "https://host/graphql", apiKey: "key", fetch })
    await expect(client.read(DOC, {})).rejects.toMatchObject({ code })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("fails closed on invalid JSON and invalid envelope shapes", async () => {
    const bodies: Response[] = [
      new Response("not-json", { status: 200 }),
      response(null),
      response([]),
      response({ data: null }),
      response({ data: [] }),
    ]
    const fetch = vi.fn(async () => bodies.shift()!)
    const client = new UnraidClient({ endpoint: "https://host/graphql", apiKey: "key", fetch })
    for (let index = 0; index < 5; index += 1) {
      await expect(client.read(DOC, {})).rejects.toMatchObject({ code: "invalid_response" })
    }
  })

  it("marks timeout failures distinctly and does not retry them", async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true })
      }))
      const client = new UnraidClient({ endpoint: "https://host/graphql", apiKey: "key", fetch, readTimeoutMs: 5 })
      const pending = client.read(DOC, {})
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout", ambiguous: false })
      await vi.advanceTimersByTimeAsync(5)
      await rejected
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses the default retry sleep and exhausts retryable HTTP responses", async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn(async () => response({ error: "busy" }, 429))
      const client = new UnraidClient({ endpoint: "https://host/graphql", apiKey: "key", fetch })
      const pending = client.read(DOC, {})
      const rejected = expect(pending).rejects.toMatchObject({ code: "transport" })
      await vi.advanceTimersByTimeAsync(1_250)
      await rejected
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("constructs with the platform fetch default without making a request", () => {
    expect(new UnraidClient({ endpoint: "https://host/graphql", apiKey: "key" })).toBeInstanceOf(UnraidClient)
  })

  it("bounds long UTF-8 error messages without splitting a character", () => {
    const error = new UnraidClientError("transport", `${"x".repeat(238)}éé`)
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(240)
    expect(error.message).toMatch(/\.\.\.$/)
    expect(error.message).not.toContain("\uFFFD")
  })
})
