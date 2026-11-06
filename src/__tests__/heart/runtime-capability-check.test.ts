import { describe, expect, it, vi } from "vitest"

import {
  verifyEmbeddingsCapability,
  verifyPerplexityCapability,
} from "../../heart/runtime-capability-check"

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  } as Response
}

describe("runtime capability live checks", () => {
  it("verifies Perplexity search with a lightweight live probe", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ title: "ping", url: "https://example.com", snippet: "pong" }],
    }))

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(true)
    expect(result.summary).toContain("live check passed")
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("surfaces Perplexity HTTP failures clearly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: { message: "bad key" },
    }, {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }))

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("401")
  })

  it("surfaces string-style Perplexity HTTP failures clearly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: "rate limited",
    }, {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    }))

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("429 rate limited")
  })

  it("surfaces Perplexity empty-result payloads clearly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("no search results")
  })

  it("surfaces thrown Perplexity probe failures cleanly", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "perplexity timeout"
    })

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("perplexity timeout")
  })

  it("sanitizes thrown HTML-shaped Perplexity failures down to the HTTP status", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("403 <html>forbidden</html>")
    })

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("HTTP 403")
  })

  it("extracts JSON error messages from thrown Perplexity failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('401 {"error":{"message":"bad session"}}')
    })

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("401 bad session")
  })

  it("falls back to the HTTP status when a thrown Perplexity JSON body is malformed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('502 {"error":')
    })

    const result = await verifyPerplexityCapability("pplx-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("HTTP 502")
  })

  it("verifies OpenAI embeddings with a lightweight live probe", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }))

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(true)
    expect(result.summary).toContain("live check passed")
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("surfaces invalid embeddings payloads clearly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }))

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("missing expected vectors")
  })

  it("surfaces embeddings HTTP failures clearly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: { message: "bad embeddings key" },
    }, {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }))

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("401")
    expect(result.summary).toContain("bad embeddings key")
  })

  it("surfaces top-level message embeddings HTTP failures clearly", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      message: "refresh required",
    }, {
      ok: false,
      status: 403,
      statusText: "Forbidden",
    }))

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("403 refresh required")
  })

  it("falls back to the HTTP status when a top-level embeddings message is blank", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      message: "   ",
    }, {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }))

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("500 Internal Server Error")
  })

  it("falls back to the HTTP status when an embeddings error object has no usable message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: {},
    }, {
      ok: false,
      status: 418,
      statusText: "I'm a teapot",
    }))

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toBe("418 I'm a teapot")
  })

  it("surfaces thrown embeddings probe failures without leaking raw objects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "embeddings network went away"
    })

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("embeddings network went away")
  })

  it("surfaces thrown embeddings Error failures cleanly", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("embeddings handshake reset")
    })

    const result = await verifyEmbeddingsCapability("emb-test", fetchImpl)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("embeddings handshake reset")
  })
})
