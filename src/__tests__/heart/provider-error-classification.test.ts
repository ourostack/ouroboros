import { describe, it, expect, vi } from "vitest"
import type { ProviderRuntime, ProviderErrorClassification } from "../../heart/core"

// ── Helpers ──

function makeHttpError(message: string, status?: number): Error {
  const err = new Error(message) as Error & { status?: number }
  if (status !== undefined) err.status = status
  return err
}

function makeNetworkError(message: string, code: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  return err
}

// ── Type-level: ProviderErrorClassification covers all categories ──

describe("ProviderErrorClassification type", () => {
  it("accepts all defined categories", () => {
    const categories: ProviderErrorClassification[] = [
      "auth-failure",
      "usage-limit",
      "rate-limit",
      "server-error",
      "network-error",
      "unknown",
    ]
    expect(categories).toHaveLength(6)
  })
})

// ── classifyError exists on ProviderRuntime interface ──

describe("ProviderRuntime.classifyError", () => {
  it("is a required method on the ProviderRuntime interface", () => {
    // Type-level assertion: ProviderRuntime must include classifyError.
    // If the method were removed from the interface, this assignment would
    // produce a compile error (classifyError is not optional).
    type HasClassifyError = ProviderRuntime["classifyError"]
    const _typeCheck: HasClassifyError = (_err: Error) => "unknown" as ProviderErrorClassification
    expect(_typeCheck).toBeDefined()
  })
})

// ── Per-provider classification (tested via standalone classifyProviderError) ──
// Each provider will export a classifyProviderError function that classifyError delegates to.
// This allows testing classification without constructing a full provider runtime.

describe("classifyAnthropicError", () => {
  // Import will fail until the function exists — that's the red phase
  let classifyAnthropicError: (error: Error) => ProviderErrorClassification

  it("classifies 401 as auth-failure", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeHttpError("Unauthorized", 401))).toBe("auth-failure")
  })

  it("classifies 403 as auth-failure", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeHttpError("Forbidden", 403))).toBe("auth-failure")
  })

  it("classifies oauth authentication message as auth-failure", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeHttpError("oauth authentication failed"))).toBe("auth-failure")
  })

  it("classifies 429 as rate-limit", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeHttpError("Too many requests", 429))).toBe("rate-limit")
  })

  it("classifies 529 as server-error", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeHttpError("Overloaded", 529))).toBe("server-error")
  })

  it("classifies 500 as server-error", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeHttpError("Internal Server Error", 500))).toBe("server-error")
  })

  it("classifies ECONNRESET as network-error", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(makeNetworkError("connect ECONNRESET", "ECONNRESET"))).toBe("network-error")
  })

  it("classifies unknown errors as unknown", async () => {
    const mod = await import("../../heart/providers/anthropic")
    classifyAnthropicError = (mod as any).classifyAnthropicError
    expect(classifyAnthropicError(new Error("something weird"))).toBe("unknown")
  })
})

describe("classifyOpenAICodexError", () => {
  it("classifies 401 as auth-failure", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(makeHttpError("Unauthorized", 401))).toBe("auth-failure")
  })

  it("classifies 403 as auth-failure", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(makeHttpError("Forbidden", 403))).toBe("auth-failure")
  })

  it("classifies 429 as rate-limit by default", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(makeHttpError("Rate limit exceeded", 429))).toBe("rate-limit")
  })

  it("classifies 429 with usage/quota/limit message as usage-limit", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(makeHttpError("You have exceeded your usage limit", 429))).toBe("usage-limit")
  })

  it("classifies 5xx as server-error", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(makeHttpError("Bad Gateway", 502))).toBe("server-error")
  })

  it("classifies network errors as network-error", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(makeNetworkError("connect ETIMEDOUT", "ETIMEDOUT"))).toBe("network-error")
  })

  it("classifies unknown errors as unknown", async () => {
    const mod = await import("../../heart/providers/openai-codex")
    const classify = (mod as any).classifyOpenAICodexError
    expect(classify(new Error("something weird"))).toBe("unknown")
  })
})

describe("classifyGithubCopilotError", () => {
  it("classifies 401 as auth-failure", async () => {
    const mod = await import("../../heart/providers/github-copilot")
    const classify = (mod as any).classifyGithubCopilotError
    expect(classify(makeHttpError("Unauthorized", 401))).toBe("auth-failure")
  })

  it("classifies 429 as rate-limit", async () => {
    const mod = await import("../../heart/providers/github-copilot")
    const classify = (mod as any).classifyGithubCopilotError
    expect(classify(makeHttpError("Too many", 429))).toBe("rate-limit")
  })

  it("classifies 5xx as server-error", async () => {
    const mod = await import("../../heart/providers/github-copilot")
    const classify = (mod as any).classifyGithubCopilotError
    expect(classify(makeHttpError("Internal Server Error", 500))).toBe("server-error")
  })

  it("classifies network errors as network-error", async () => {
    const mod = await import("../../heart/providers/github-copilot")
    const classify = (mod as any).classifyGithubCopilotError
    expect(classify(makeNetworkError("connect ECONNRESET", "ECONNRESET"))).toBe("network-error")
  })

  it("classifies unknown errors as unknown", async () => {
    const mod = await import("../../heart/providers/github-copilot")
    const classify = (mod as any).classifyGithubCopilotError
    expect(classify(new Error("something weird"))).toBe("unknown")
  })
})

describe("classifyAzureError", () => {
  it("classifies 401 as auth-failure", async () => {
    const mod = await import("../../heart/providers/azure")
    const classify = (mod as any).classifyAzureError
    expect(classify(makeHttpError("Unauthorized", 401))).toBe("auth-failure")
  })

  it("classifies 429 as rate-limit", async () => {
    const mod = await import("../../heart/providers/azure")
    const classify = (mod as any).classifyAzureError
    expect(classify(makeHttpError("Too many requests", 429))).toBe("rate-limit")
  })

  it("classifies 5xx as server-error", async () => {
    const mod = await import("../../heart/providers/azure")
    const classify = (mod as any).classifyAzureError
    expect(classify(makeHttpError("Service Unavailable", 503))).toBe("server-error")
  })

  it("classifies network errors as network-error", async () => {
    const mod = await import("../../heart/providers/azure")
    const classify = (mod as any).classifyAzureError
    expect(classify(makeNetworkError("getaddrinfo ENOTFOUND", "ENOTFOUND"))).toBe("network-error")
  })

  it("classifies unknown errors as unknown", async () => {
    const mod = await import("../../heart/providers/azure")
    const classify = (mod as any).classifyAzureError
    expect(classify(new Error("something weird"))).toBe("unknown")
  })
})

describe("classifyMinimaxError", () => {
  it("classifies 401 as auth-failure", async () => {
    const mod = await import("../../heart/providers/minimax")
    const classify = (mod as any).classifyMinimaxError
    expect(classify(makeHttpError("Unauthorized", 401))).toBe("auth-failure")
  })

  it("classifies 429 as rate-limit", async () => {
    const mod = await import("../../heart/providers/minimax")
    const classify = (mod as any).classifyMinimaxError
    expect(classify(makeHttpError("Too many requests", 429))).toBe("rate-limit")
  })

  it("classifies 5xx as server-error", async () => {
    const mod = await import("../../heart/providers/minimax")
    const classify = (mod as any).classifyMinimaxError
    expect(classify(makeHttpError("Internal Server Error", 500))).toBe("server-error")
  })

  it("classifies network errors as network-error", async () => {
    const mod = await import("../../heart/providers/minimax")
    const classify = (mod as any).classifyMinimaxError
    expect(classify(makeNetworkError("socket hang up", "ECONNRESET"))).toBe("network-error")
  })

  it("classifies unknown errors as unknown", async () => {
    const mod = await import("../../heart/providers/minimax")
    const classify = (mod as any).classifyMinimaxError
    expect(classify(new Error("something weird"))).toBe("unknown")
  })
})

// ── Shared classifier (exercised directly) ──

describe("classifyHttpError (shared)", () => {
  it("maps 401/403 to auth-failure", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    expect(classifyHttpError(makeHttpError("Unauthorized", 401))).toBe("auth-failure")
    expect(classifyHttpError(makeHttpError("Forbidden", 403))).toBe("auth-failure")
  })

  it("maps 429 to rate-limit by default", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    expect(classifyHttpError(makeHttpError("Too many", 429))).toBe("rate-limit")
  })

  it("maps 5xx to server-error", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    expect(classifyHttpError(makeHttpError("ISE", 500))).toBe("server-error")
    expect(classifyHttpError(makeHttpError("Bad GW", 502))).toBe("server-error")
  })

  it("maps SDK 'Request timed out.' to network-error", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    expect(classifyHttpError(new Error("Request timed out."))).toBe("network-error")
  })

  it("maps connection error messages to network-error", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    expect(classifyHttpError(new Error("Connection error."))).toBe("network-error")
    expect(classifyHttpError(new Error("fetch failed"))).toBe("network-error")
    expect(classifyHttpError(makeNetworkError("read ETIMEDOUT", "ETIMEDOUT"))).toBe("network-error")
  })

  it("returns unknown when nothing matches", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    expect(classifyHttpError(new Error("something we have not seen"))).toBe("unknown")
  })

  it("override.isAuthFailure fires before status check", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    // Status is 200 (not normally an auth failure), but override forces it.
    const err = makeHttpError("oauth token expired", 200)
    expect(
      classifyHttpError(err, { isAuthFailure: (e) => e.message.includes("oauth") }),
    ).toBe("auth-failure")
  })

  it("override.isUsageLimit reclassifies 429", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    const err = makeHttpError("You have exceeded your monthly quota", 429)
    expect(
      classifyHttpError(err, { isUsageLimit: (e) => /quota|exceeded/i.test(e.message) }),
    ).toBe("usage-limit")
  })

  it("override.isServerError catches Anthropic 529 (overloaded)", async () => {
    const { classifyHttpError } = await import("../../heart/providers/error-classification")
    const err = makeHttpError("Overloaded", 529)
    expect(
      classifyHttpError(err, { isServerError: (e) => (e as any).status === 529 }),
    ).toBe("server-error")
  })
})

describe("isNetworkError (shared)", () => {
  it("matches Node.js socket/DNS error codes", async () => {
    const { isNetworkError } = await import("../../heart/providers/error-classification")
    for (const code of [
      "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
      "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED",
    ]) {
      expect(isNetworkError(makeNetworkError("net fail", code))).toBe(true)
    }
  })

  it("matches SDK timeout/connection error message strings", async () => {
    const { isNetworkError } = await import("../../heart/providers/error-classification")
    expect(isNetworkError(new Error("Request timed out."))).toBe(true)
    expect(isNetworkError(new Error("request timeout"))).toBe(true)
    expect(isNetworkError(new Error("Connection error."))).toBe(true)
    expect(isNetworkError(new Error("fetch failed"))).toBe(true)
    expect(isNetworkError(new Error("socket hang up"))).toBe(true)
    expect(isNetworkError(new Error("getaddrinfo ENOTFOUND"))).toBe(true)
  })

  it("does not match unrelated messages", async () => {
    const { isNetworkError } = await import("../../heart/providers/error-classification")
    expect(isNetworkError(new Error("invalid request"))).toBe(false)
    expect(isNetworkError(new Error("model not found"))).toBe(false)
  })

  it("handles errors with no message (defensive)", async () => {
    const { isNetworkError } = await import("../../heart/providers/error-classification")
    // An Error whose .message is the empty string — covers the
    // `error.message || ""` defensive branch.
    expect(isNetworkError(new Error())).toBe(false)
    // And an Error with null-ish message after construction.
    const err = new Error("placeholder")
    Object.defineProperty(err, "message", { value: undefined })
    expect(isNetworkError(err)).toBe(false)
  })
})
