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

function responseWithChoice(choice: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [choice] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
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
    ["openai-compatible", "not a URL"],
    ["openai-compatible", "http://api.z.ai/api/paas/v4/"],
    ["openai-compatible", "https://api.z.ai:443/api/paas/v4/"],
    ["openai-compatible", "https://user@api.z.ai/api/paas/v4/"],
    ["openai-compatible", "https://api.z.ai/"],
    ["openai-compatible", "https://api.z.ai/api/paas/v4/#fragment"],
    ["openai-compatible", "https://api.z.ai/api/paas/v4/extra"],
    ["openai-compatible", "https://api.z.ai.attacker.example/api/paas/v4/"],
    ["openai-compatible-gemini", "https://generativelanguage.googleapis.com/v1beta/openai/?x=1"],
  ] as const)("rejects non-canonical base URLs for %s", (provider, baseUrl) => {
    expect(() => createOpenAICompatibleProviderRuntime(provider, "model", { apiKey: "secret", baseUrl }))
      .toThrow("canonical base URL")
  })

  it("normalizes only redundant trailing slashes on a canonical base URL", () => {
    expect(() => createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret",
      baseUrl: "https://api.z.ai/api/paas/v4////",
    }, { fetch: vi.fn() })).not.toThrow()
  })

  it("redacts the API key from transport failures", async () => {
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret-never-print",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch: vi.fn(async () => { throw new Error("failed with secret-never-print") }) })
    await expect(runtime.ping()).rejects.not.toThrow("secret-never-print")
  })

  it.each([
    ["a non-Error rejection", "secret-never-print", undefined],
    ["an Error with a transport code", Object.assign(new Error("secret-never-print"), { code: "ECONNRESET" }), "ECONNRESET"],
    ["an Error with a non-finite status", Object.assign(new Error("secret-never-print"), { status: Number.NaN }), undefined],
  ])("redacts and safely normalizes %s", async (_label, rejected, expectedCode) => {
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret-never-print",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch: vi.fn(async () => Promise.reject(rejected)) })

    const error = await runtime.ping().catch((caught: unknown) => caught as Error & { code?: string; status?: number })
    expect(error.message).not.toContain("secret-never-print")
    expect(error.code).toBe(expectedCode)
    expect(error.status).toBeUndefined()
  })

  it.each([
    [undefined],
    [""],
    ["   "],
  ])("requires a non-empty API key (%j)", (apiKey) => {
    expect(() => createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: apiKey as string,
      baseUrl: "https://api.z.ai/api/paas/v4/",
    })).toThrow("apiKey is missing")
  })

  it.each([
    [401, "auth-failure"],
    [403, "auth-failure"],
    [429, "rate-limit"],
    [500, "server-error"],
    [503, "server-error"],
  ] as const)("preserves HTTP %i for %s classification after redaction", async (status, classification) => {
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret-classification-key",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch: vi.fn(async () => new Response("failure", { status })) })

    const error = await runtime.ping().catch((caught: unknown) => caught as Error)
    expect(runtime.classifyError(error)).toBe(classification)
    expect((error as Error & { status?: number }).status).toBe(status)
  })

  it("rejects legacy function_call before emitting any response callbacks", async () => {
    const fetch = vi.fn(async () => responseWithChoice({
      finish_reason: "stop",
      message: { role: "assistant", content: "looks fine", function_call: { name: "shell", arguments: "{}" } },
    }))
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch })
    const cb = callbacks()

    await expect(runtime.streamTurn({ messages: [], activeTools: [], callbacks: cb })).rejects.toThrow("legacy function_call")
    expect(cb.onModelStreamStart).not.toHaveBeenCalled()
    expect(cb.onTextChunk).not.toHaveBeenCalled()
  })

  it.each([
    ["missing usage", undefined, undefined],
    ["null usage", null, undefined],
    ["primitive usage", 3, undefined],
    ["array usage", [], undefined],
    ["invalid input tokens", { prompt_tokens: -1, completion_tokens: 2, total_tokens: 5 }, undefined],
    ["invalid output tokens", { prompt_tokens: 3, completion_tokens: 1.5, total_tokens: 5 }, undefined],
    ["invalid total tokens", { prompt_tokens: 3, completion_tokens: 2, total_tokens: "5" }, undefined],
    ["missing token details", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, { input_tokens: 3, output_tokens: 2, reasoning_tokens: 0, total_tokens: 5 }],
    ["null token details", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, completion_tokens_details: null }, { input_tokens: 3, output_tokens: 2, reasoning_tokens: 0, total_tokens: 5 }],
    ["array token details", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, completion_tokens_details: [] }, { input_tokens: 3, output_tokens: 2, reasoning_tokens: 0, total_tokens: 5 }],
    ["invalid reasoning tokens", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, completion_tokens_details: { reasoning_tokens: -0.5 } }, { input_tokens: 3, output_tokens: 2, reasoning_tokens: 0, total_tokens: 5 }],
    ["valid reasoning tokens", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 1 } }, { input_tokens: 3, output_tokens: 2, reasoning_tokens: 1, total_tokens: 5 }],
  ])("normalizes %s", async (_label, usage, expected) => {
    const payload = {
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      ...(usage === undefined ? {} : { usage }),
    }
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) })

    expect((await runtime.streamTurn({ messages: [], activeTools: [], callbacks: callbacks() })).usage).toEqual(expected)
  })

  it("supports a bounded function-tool response and required tool choice", async () => {
    let request: Request | undefined
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init)
      return responseWithChoice({
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "shell", arguments: "{}" } }],
        },
      })
    })
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch })
    const cb = callbacks()

    const result = await runtime.streamTurn({
      messages: [], activeTools: [], callbacks: cb, toolChoiceRequired: true,
    })

    expect(await request?.json()).toMatchObject({ tool_choice: "required" })
    expect(result).toMatchObject({ content: "", toolCalls: [{ id: "call-1", name: "shell", arguments: "{}" }] })
    expect(cb.onModelStreamStart).toHaveBeenCalledOnce()
    expect(cb.onTextChunk).not.toHaveBeenCalled()
    runtime.resetTurnState()
    runtime.appendToolOutput("call-1", "ok")
  })

  it("uses the ambient fetch and package version defaults", async () => {
    const fetch = vi.fn(async () => completion("ambient"))
    vi.stubGlobal("fetch", fetch)
    try {
      const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
        apiKey: "secret",
        baseUrl: "https://api.z.ai/api/paas/v4/",
      })
      expect(await runtime.ping()).toBeUndefined()
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ["null envelope", null],
    ["array envelope", []],
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    ["null choice", { choices: [null] }],
    ["primitive choice", { choices: ["choice"] }],
    ["multiple choices", { choices: [{}, {}] }],
    ["missing message", { choices: [{ finish_reason: "stop" }] }],
    ["array message", { choices: [{ finish_reason: "stop", message: [] }] }],
    ["null reason", { choices: [{ finish_reason: null, message: { content: "x" } }] }],
    ["empty reason", { choices: [{ finish_reason: "", message: { content: "x" } }] }],
    ["length", { choices: [{ finish_reason: "length", message: { content: "x" } }] }],
    ["content filter", { choices: [{ finish_reason: "content_filter", message: { content: "x" } }] }],
    ["stop with empty content", { choices: [{ finish_reason: "stop", message: { content: "" } }] }],
    ["stop with calls", { choices: [{ finish_reason: "stop", message: { content: "x", tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: "{}" } }] } }] }],
    ["non-array calls", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: {} } }] }],
    ["null call", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [null] } }] }],
    ["array call", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [[]] } }] }],
    ["wrong call type", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "custom", function: { name: "shell", arguments: "{}" } }] } }] }],
    ["missing function", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "function" }] } }] }],
    ["array function", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "function", function: [] }] } }] }],
    ["missing call id", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ type: "function", function: { name: "shell", arguments: "{}" } }] } }] }],
    ["empty call id", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: " ", type: "function", function: { name: "shell", arguments: "{}" } }] } }] }],
    ["missing tool name", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "function", function: { arguments: "{}" } }] } }] }],
    ["empty tool name", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: " ", arguments: "{}" } }] } }] }],
    ["missing tool arguments", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "shell" } }] } }] }],
    ["empty tool arguments", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: " " } }] } }] }],
    ["tool reason without calls", { choices: [{ finish_reason: "tool_calls", message: { content: "" } }] }],
    ["tool reason with content", { choices: [{ finish_reason: "tool_calls", message: { content: "x", tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: "{}" } }] } }] }],
    ["nine calls", { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, type: "function", function: { name: "shell", arguments: "{}" } })) } }] }],
  ])("fails closed for %s", async (_label, payload) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    const runtime = createOpenAICompatibleProviderRuntime("openai-compatible", "glm-5.2", {
      apiKey: "secret",
      baseUrl: "https://api.z.ai/api/paas/v4/",
    }, { fetch })
    const cb = callbacks()

    await expect(runtime.streamTurn({ messages: [], activeTools: [], callbacks: cb })).rejects.toThrow()
    expect(cb.onModelStreamStart).not.toHaveBeenCalled()
    expect(cb.onTextChunk).not.toHaveBeenCalled()
  })
})
