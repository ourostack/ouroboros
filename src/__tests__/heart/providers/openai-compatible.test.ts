import { describe, expect, it, vi } from "vitest"

import { createOpenAICompatibleProviderRuntime } from "../../../heart/providers/openai-compatible"

function callbacks() {
  return {
    onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn(),
  }
}

function completion(content = "pong"): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "wire-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } })
}

describe("generic OpenAI-compatible provider", () => {
  it("sends the exact non-streaming GLM wire contract", async () => {
    let request: Request | undefined
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init)
      return completion()
    })
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret-glm-key",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch })
    const cb = callbacks()

    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "ping" }], activeTools: [], callbacks: cb,
    })

    expect(request?.url).toBe("https://api.z.ai/api/paas/v4/chat/completions")
    expect(request?.headers.get("authorization")).toBe("Bearer secret-glm-key")
    expect(await request?.json()).toEqual({
      model: "glm-5.2",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      stream: false,
      temperature: 0,
    })
    expect(result).toMatchObject({ content: "pong", toolCalls: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })
    expect(cb.onTextChunk).toHaveBeenCalledWith("pong")
  })

  it("omits all sampling controls and adds the Gemini client header", async () => {
    let request: Request | undefined
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init)
      return completion("gemini")
    })
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible-gemini", "gemini-3.6-flash", {
      apiKey: "secret-gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    }, { fetch, packageVersion: "0.1.0-alpha.733" })

    await runtime.streamTurn({ messages: [{ role: "user", content: "ping" }], activeTools: [], callbacks: callbacks() })
    const body = await request?.json() as Record<string, unknown>
    expect(request?.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
    expect(request?.headers.get("x-goog-api-client")).toBe("ouroboros-harness-oai/0.1.0-alpha.733")
    expect(body).not.toHaveProperty("temperature")
    expect(body).not.toHaveProperty("top_p")
    expect(body).not.toHaveProperty("top_k")
    expect(body).not.toHaveProperty("candidate_count")
    expect(body.stream).toBe(false)
  })

  it.each([
    ["openai-compatible", "https://api.z.ai/api/paas/v4/extra"],
    ["openai-compatible", "https://api.z.ai.attacker.example/api/paas/v4/"],
    ["openai-compatible-gemini", "https://generativelanguage.googleapis.com/v1beta/openai/?x=1"],
  ] as const)("rejects non-canonical base URLs for %s", (provider, baseUrl) => {
    expect(() => createOpenAICompatibleProviderRuntime(provider, "model", { apiKey: "secret", baseUrl }))
      .toThrow("canonical base URL")
  })

  it("redacts the API key from transport failures", async () => {
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret-never-print",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch: vi.fn(async () => { throw new Error("failed with secret-never-print") }) })
    await expect(runtime.ping()).rejects.not.toThrow("secret-never-print")
  })
})
