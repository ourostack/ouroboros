// Spec for the MiniMax VLM thin client.
//
// Contract:
//   export async function minimaxVlmDescribe(params: {
//     apiKey: string
//     prompt: string
//     imageDataUrl: string              // "data:image/(png|jpeg|webp);base64,..."
//     baseURL: string                   // from minimax provider config
//     fetchImpl?: typeof fetch          // injected for tests
//     timeoutMs?: number                // default 60000
//     attachmentGuid?: string           // nerves meta pass-through
//     mimeType?: string                 // nerves meta pass-through
//     chatModel?: string                // nerves meta pass-through (the chat model that triggered the fallback)
//   }): Promise<string>
//
// Every throw path must produce an AX-2 message: what went wrong AND what to
// try next. Tests assert on the "what to try" half, not just the "what
// went wrong" half. The prompt text is never logged — only promptLength.

import { describe, it, expect, vi, beforeEach } from "vitest"

const { emitNervesEventMock } = vi.hoisted(() => ({
  emitNervesEventMock: vi.fn(),
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: emitNervesEventMock,
}))

import { minimaxVlmDescribe } from "../../../heart/providers/minimax-vlm"

function emitTestEvent(testName: string): void {
  emitNervesEventMock({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8="
const JPEG_DATA_URL = "data:image/jpeg;base64,aGVsbG8="
const WEBP_DATA_URL = "data:image/webp;base64,aGVsbG8="
const GIF_DATA_URL = "data:image/gif;base64,aGVsbG8="

function okResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })
}

function httpErrorResponse(status: number, body: unknown = {}, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("minimaxVlmDescribe", () => {
  beforeEach(() => {
    emitNervesEventMock.mockClear()
  })

  it("happy path: posts to /v1/coding_plan/vlm and returns description", async () => {
    emitTestEvent("happy path")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "This cat is orange.", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    const result = await minimaxVlmDescribe({
      apiKey: "sk-test",
      prompt: "what is in this image?",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
      attachmentGuid: "guid-1",
      mimeType: "image/png",
      chatModel: "MiniMax-M2.5",
    })
    expect(result).toBe("This cat is orange.")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.minimaxi.chat/v1/coding_plan/vlm")
    const headers = init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer sk-test")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers["MM-API-Source"]).toBe("Ouroboros")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ prompt: "what is in this image?", image_url: PNG_DATA_URL })
  })

  it("baseURL with trailing slash still produces the right URL", async () => {
    emitTestEvent("trailing slash")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "ok", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: JPEG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1/",
      fetchImpl,
    })
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.minimaxi.chat/v1/coding_plan/vlm")
  })

  it("baseURL without /v1 still produces /v1/coding_plan/vlm", async () => {
    emitTestEvent("no /v1")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "ok", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: WEBP_DATA_URL,
      baseURL: "https://api.minimax.io",
      fetchImpl,
    })
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.minimax.io/v1/coding_plan/vlm")
  })

  it("missing apiKey throws AX-2 error mentioning credentials and the fix", async () => {
    emitTestEvent("missing apiKey")
    const fetchImpl = vi.fn()
    await expect(
      minimaxVlmDescribe({
        apiKey: "",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/minimax.*api key|credentials/i)
    // AX-2: must say what to do next
    await expect(
      minimaxVlmDescribe({
        apiKey: "",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/ouro auth --agent <agent> --provider minimax|configure|add a minimax key/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("missing prompt throws AX-2 error", async () => {
    emitTestEvent("missing prompt")
    const fetchImpl = vi.fn()
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/prompt.*required|missing prompt/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/targeted question|supply a prompt/i)
  })

  it("missing imageDataUrl throws AX-2 error", async () => {
    emitTestEvent("missing imageDataUrl")
    const fetchImpl = vi.fn()
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: "",
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/image.*required|missing image/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: "",
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/ask the user to resend|verify the attachment/i)
  })

  it("unsupported format (image/gif) throws AX-2 naming the format and the fix", async () => {
    emitTestEvent("unsupported gif")
    const fetchImpl = vi.fn()
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: GIF_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/image\/gif/)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: GIF_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/ask the user to resend|resend as a screenshot|png or jpeg/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("non-data-URL imageDataUrl throws AX-2 error", async () => {
    emitTestEvent("non-data url")
    const fetchImpl = vi.fn()
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: "https://example.com/cat.png",
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/data url|data:image/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("HTTP 401: AX-2 mentions credentials and re-run credential setup", async () => {
    emitTestEvent("http 401")
    const fetchImpl = vi.fn().mockResolvedValue(
      httpErrorResponse(401, { error: "unauthorized" }, { "Trace-Id": "trace-401" }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk-bad",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/401|credentials|api key/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk-bad",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/re-run credential setup|rotate the key|check the minimax key/i)
  })

  it("HTTP 429: AX-2 mentions rate limiting and retry", async () => {
    emitTestEvent("http 429")
    const fetchImpl = vi.fn().mockResolvedValue(httpErrorResponse(429, { error: "rate limited" }))
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/429|rate limit/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/retry in a moment|wait and retry/i)
  })

  it("HTTP 500: AX-2 mentions server error and retry", async () => {
    emitTestEvent("http 500")
    const fetchImpl = vi.fn().mockResolvedValue(httpErrorResponse(500, { error: "boom" }))
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/500|server error/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/retry/i)
  })

  it("network error (fetch rejects): AX-2 mentions network and retry", async () => {
    emitTestEvent("network error")
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/network/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/retry/i)
  })

  it("timeout: AX-2 says 'timed out after Ns — retry or ask the user to resend the image'", async () => {
    emitTestEvent("timeout")
    const abortError = new Error("The operation was aborted.")
    abortError.name = "AbortError"
    const fetchImpl = vi.fn().mockRejectedValue(abortError)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(/timed out after 60s/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(/retry or ask the user to resend/i)
  })

  it("response is not JSON: AX-2 mentions malformed response and the fix", async () => {
    emitTestEvent("non-json response")
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 200, headers: { "content-type": "text/plain" } }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/malformed|not json|invalid response/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/provider bug|surface.*unavailable|retry/i)
  })

  it("base_resp.status_code !== 0: AX-2 includes provider status and action", async () => {
    emitTestEvent("provider status nonzero")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "", base_resp: { status_code: 1009, status_msg: "insufficient balance" } }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/1009/)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/insufficient balance|surface|retry|check the minimax account/i)
  })

  it("content field missing: AX-2 says provider bug and surface 'image understanding unavailable'", async () => {
    emitTestEvent("content missing")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/no description|empty content/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/provider bug|surface.*image understanding is unavailable/i)
  })

  it("content field empty string: AX-2 says provider bug", async () => {
    emitTestEvent("content empty string")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/no description|empty content/i)
  })

  it("Trace-Id header on error is surfaced in the error message or meta", async () => {
    emitTestEvent("trace-id passthrough")
    const fetchImpl = vi.fn().mockResolvedValue(
      httpErrorResponse(500, { error: "boom" }, { "Trace-Id": "trace-xyz" }),
    )
    let caught: Error | undefined
    try {
      await minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
        attachmentGuid: "guid-trace",
        mimeType: "image/png",
      })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    const errorEvent = emitNervesEventMock.mock.calls.find(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_error",
    )
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.[0].meta).toMatchObject({ traceId: "trace-xyz" })
  })

  it("emits senses.bluebubbles_vlm_describe_start before fetch and _end after on success", async () => {
    emitTestEvent("start/end pairing happy")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "a cat", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "what is this",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
      attachmentGuid: "guid-happy",
      mimeType: "image/png",
      chatModel: "MiniMax-M2.5",
    })
    const starts = emitNervesEventMock.mock.calls.filter(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_start",
    )
    const ends = emitNervesEventMock.mock.calls.filter(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_end",
    )
    const errors = emitNervesEventMock.mock.calls.filter(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_error",
    )
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(errors).toHaveLength(0)
    expect(starts[0][0].meta).toMatchObject({
      attachmentGuid: "guid-happy",
      mimeType: "image/png",
      model: "minimax-vlm",
      chatModel: "MiniMax-M2.5",
    })
    expect(starts[0][0].meta.promptLength).toBe("what is this".length)
    // AX-4: prompt itself is NOT in meta — privacy
    expect(starts[0][0].meta.prompt).toBeUndefined()
    expect(ends[0][0].meta).toMatchObject({
      attachmentGuid: "guid-happy",
      descriptionLength: "a cat".length,
      model: "minimax-vlm",
    })
    expect(typeof ends[0][0].meta.latencyMs).toBe("number")
    // End event also must not carry the description content
    expect(ends[0][0].meta.description).toBeUndefined()
    expect(ends[0][0].meta.content).toBeUndefined()
  })

  it("emits start + error event on failure (no _end), with AX-4 meta", async () => {
    emitTestEvent("start/error pairing")
    const fetchImpl = vi.fn().mockResolvedValue(httpErrorResponse(500, { error: "boom" }))
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
        attachmentGuid: "guid-err",
        mimeType: "image/png",
        chatModel: "MiniMax-M2.5",
      }),
    ).rejects.toThrow()
    const starts = emitNervesEventMock.mock.calls.filter(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_start",
    )
    const ends = emitNervesEventMock.mock.calls.filter(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_end",
    )
    const errors = emitNervesEventMock.mock.calls.filter(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_error",
    )
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0][0].meta).toMatchObject({
      attachmentGuid: "guid-err",
      mimeType: "image/png",
      model: "minimax-vlm",
      status: 500,
    })
    expect(typeof errors[0][0].meta.reason).toBe("string")
    expect((errors[0][0].meta.reason as string).length).toBeGreaterThan(0)
    // AX-4: prompt never logged
    expect(errors[0][0].meta.prompt).toBeUndefined()
  })

  it("unexpected transport error (non-network, non-timeout) surfaces AX-2 fallback", async () => {
    emitTestEvent("transport error generic")
    const weirdError = new Error("some weird transport bug")
    const fetchImpl = vi.fn().mockRejectedValue(weirdError)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/unexpected transport error|some weird transport bug/i)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/retry|image understanding is unavailable/i)
  })

  it("HTTP 404 (non-specific !ok status) surfaces AX-2 fallback", async () => {
    emitTestEvent("http 404")
    const fetchImpl = vi.fn().mockResolvedValue(httpErrorResponse(404, { error: "not found" }))
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 404/)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/retry|unavailable/i)
  })

  it("uses default fetch when fetchImpl is not provided (falsy-guard path)", async () => {
    emitTestEvent("default fetch fallback")
    // We can't easily invoke the real network here — instead stub global.fetch
    // so the default-arg path runs. The test restores it via afterEach.
    const originalFetch = global.fetch
    try {
      const stub = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ content: "x", base_resp: { status_code: 0, status_msg: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      ;(global as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch
      const result = await minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
      })
      expect(result).toBe("x")
      expect(stub).toHaveBeenCalledTimes(1)
    } finally {
      ;(global as { fetch: typeof fetch }).fetch = originalFetch
    }
  })

  it("omits AbortSignal entirely when timeoutMs is not provided (no harness-imposed ceiling)", async () => {
    // Regression guard on the "no harness-enforced timeout" decision. When
    // the caller doesn't pass timeoutMs, the fetch call must NOT set a
    // signal — we let undici's defaults (headersTimeout + bodyTimeout) be
    // the ceiling. Same reasoning as PR #322 for LLM providers.
    emitTestEvent("no-timeout no-signal")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "ok", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    const result = await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
      // no timeoutMs
    })
    expect(result).toBe("ok")
    // Verify fetch was called without a signal property at all.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const fetchOptions = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(fetchOptions.signal).toBeUndefined()
  })

  it("layers an AbortSignal only when caller passes explicit timeoutMs", async () => {
    emitTestEvent("explicit timeout gets signal")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "ok", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
      timeoutMs: 30_000,
    })
    const fetchOptions = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(fetchOptions.signal).toBeDefined()
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal)
  })

  it("falsy timeoutMs (0, negative) is treated as 'no timeout' not 'immediate abort'", async () => {
    // Defensive: a caller passing timeoutMs: 0 probably means "no timeout",
    // not "abort immediately". We gate the signal on >0.
    emitTestEvent("falsy timeoutMs bypasses signal")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "ok", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
      timeoutMs: 0,
    })
    const fetchOptions = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(fetchOptions.signal).toBeUndefined()
  })

  it("timeout error message adapts when no timeoutMs was set (stack default ceiling)", async () => {
    // If a caller didn't set timeoutMs but still somehow hits an AbortError
    // (e.g., undici's own headersTimeout fires), the error message should
    // say "underlying stack default" instead of a made-up number.
    emitTestEvent("no-timeout abort message")
    const abortError = new Error("The operation was aborted.")
    abortError.name = "AbortError"
    const fetchImpl = vi.fn().mockRejectedValue(abortError)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
        // no timeoutMs
      }),
    ).rejects.toThrow(/underlying stack default/i)
  })

  it("response without Trace-Id header — error meta traceId is undefined", async () => {
    emitTestEvent("no trace-id header")
    const fetchImpl = vi.fn().mockResolvedValue(httpErrorResponse(500, { error: "boom" }))
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow()
    const errorEvent = emitNervesEventMock.mock.calls.find(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_error",
    )
    expect(errorEvent?.[0].meta.traceId).toBeUndefined()
  })

  it("lowercase trace-id header is also honored", async () => {
    emitTestEvent("lowercase trace-id")
    // Response headers are case-insensitive — but the lowercase-fallback
    // branch must still execute for coverage. We call get("Trace-Id") first,
    // and when the caller sends lowercase, the first get still returns the
    // value (Response headers case-fold on lookup). This test covers both
    // call branches explicitly.
    const fetchImpl = vi.fn().mockResolvedValue(
      httpErrorResponse(500, { error: "boom" }, { "trace-id": "lower-trace" }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow()
    const errorEvent = emitNervesEventMock.mock.calls.find(
      (call) => call[0]?.event === "senses.bluebubbles_vlm_describe_error",
    )
    expect(errorEvent?.[0].meta.traceId).toBe("lower-trace")
  })

  it("non-data URL path that has no recognizable mime prefix still throws with unknown", async () => {
    emitTestEvent("no prefix mime")
    const fetchImpl = vi.fn()
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: "garbage",
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/unknown|data:image/i)
  })

  it("missing status_code in base_resp is treated as 0 (happy path)", async () => {
    emitTestEvent("missing status_code")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "a cat", base_resp: {} }),
    )
    const result = await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
    })
    expect(result).toBe("a cat")
  })

  it("missing base_resp entirely is treated as status 0 (happy path)", async () => {
    emitTestEvent("missing base_resp")
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ content: "ok" }))
    const result = await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: "p",
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
    })
    expect(result).toBe("ok")
  })

  it("base_resp.status_code nonzero without status_msg uses 'unknown' fallback", async () => {
    emitTestEvent("status_msg fallback")
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "x", base_resp: { status_code: 2013 } }),
    )
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/2013.*unknown/)
  })

  it("timeout path with custom timeoutMs reports the right seconds", async () => {
    emitTestEvent("custom timeout seconds")
    const abortError = new Error("The operation was aborted.")
    abortError.name = "AbortError"
    const fetchImpl = vi.fn().mockRejectedValue(abortError)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow(/timed out after 30s/)
  })

  it("thrown non-Error value is coerced to string in error meta", async () => {
    emitTestEvent("non-error throw")
    const fetchImpl = vi.fn().mockRejectedValue(null)
    await expect(
      minimaxVlmDescribe({
        apiKey: "sk",
        prompt: "p",
        imageDataUrl: PNG_DATA_URL,
        baseURL: "https://api.minimaxi.chat/v1",
        fetchImpl,
      }),
    ).rejects.toThrow(/unexpected transport error/)
  })

  it("prompt text is never included in start, end, or error event meta", async () => {
    emitTestEvent("prompt never logged")
    const secretPrompt = "SECRET PII: my SSN is 123-45-6789"
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ content: "a cat", base_resp: { status_code: 0, status_msg: "ok" } }),
    )
    await minimaxVlmDescribe({
      apiKey: "sk",
      prompt: secretPrompt,
      imageDataUrl: PNG_DATA_URL,
      baseURL: "https://api.minimaxi.chat/v1",
      fetchImpl,
      attachmentGuid: "guid-pii",
      mimeType: "image/png",
    })
    for (const call of emitNervesEventMock.mock.calls) {
      const serialized = JSON.stringify(call[0] ?? {})
      expect(serialized).not.toContain("SECRET PII")
      expect(serialized).not.toContain("123-45-6789")
    }
  })
})
