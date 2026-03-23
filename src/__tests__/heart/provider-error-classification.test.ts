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
