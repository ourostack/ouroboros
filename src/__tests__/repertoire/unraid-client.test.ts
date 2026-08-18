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
    expect(request?.headers.get("x-api-key")).toBe("private-key")
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
})
