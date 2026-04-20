import { describe, expect, it, vi } from "vitest"

import {
  createProviderPingProgressReporter,
  formatProviderAttemptProgress,
  formatProviderRetryProgress,
} from "../../../heart/daemon/provider-ping-progress"
import type { ProviderAttemptRecord } from "../../../heart/provider-attempt"

function retryRecord(
  overrides: Partial<ProviderAttemptRecord> = {},
): ProviderAttemptRecord {
  return {
    attempt: 1,
    provider: "minimax",
    model: "MiniMax-M2.5",
    operation: "ping",
    ok: false,
    classification: "server-error",
    errorMessage: "provider busy",
    httpStatus: 529,
    willRetry: true,
    delayMs: 0,
    ...overrides,
  }
}

describe("provider ping progress", () => {
  it("formats attempt progress with and without a model label", () => {
    expect(formatProviderAttemptProgress({ provider: "minimax", model: "MiniMax-M2.5" }, 1, 3)).toBe(
      "checking minimax / MiniMax-M2.5 (attempt 1 of 3)...",
    )
    expect(formatProviderAttemptProgress({ provider: "anthropic" }, 2, 3)).toBe(
      "checking anthropic (attempt 2 of 3)...",
    )
  })

  it.each([
    ["auth-failure", undefined, "credentials were rejected"],
    ["usage-limit", undefined, "usage limit hit"],
    ["rate-limit", undefined, "provider asked us to slow down"],
    ["server-error", 529, "provider is busy right now"],
    ["server-error", 503, "provider is having trouble right now"],
    ["network-error", undefined, "network connection dropped"],
    ["unknown", undefined, "last check failed"],
  ] as const)("formats retry progress for %s", (classification, httpStatus, reason) => {
    const message = formatProviderRetryProgress({
      provider: "minimax",
      model: "MiniMax-M2.5",
    }, retryRecord({
      classification,
      httpStatus,
    }), 3)

    expect(message).toBe(`minimax / MiniMax-M2.5: ${reason}; retrying now (attempt 2 of 3)`)
  })

  it("falls back to a generic retry reason for unexpected classifications", () => {
    const message = formatProviderRetryProgress({
      provider: "minimax",
      model: "MiniMax-M2.5",
    }, retryRecord({
      classification: "mystery" as never,
    }), 3)

    expect(message).toBe("minimax / MiniMax-M2.5: last check failed; retrying now (attempt 2 of 3)")
  })

  it("formats retry timing when a non-zero retry delay is present", () => {
    const message = formatProviderRetryProgress({
      provider: "anthropic",
      model: "",
    }, retryRecord({
      provider: "anthropic",
      model: "",
      classification: "network-error",
      delayMs: 1_500,
      attempt: 2,
    }), 3)

    expect(message).toBe("anthropic: network connection dropped; retrying in 1.5s (attempt 3 of 3)")
  })

  it("formats integer-second retry delays without a decimal tail", () => {
    const message = formatProviderRetryProgress({
      provider: "minimax",
      model: "MiniMax-M2.5",
    }, retryRecord({
      delayMs: 2_000,
    }), 3)

    expect(message).toBe("minimax / MiniMax-M2.5: provider is busy right now; retrying in 2s (attempt 2 of 3)")
  })

  it("includes the subject when the retry belongs to a specific agent lane", () => {
    const message = formatProviderRetryProgress({
      provider: "openai-codex",
      model: "gpt-5.4",
      subject: "slugger (chat)",
    }, retryRecord({
      provider: "openai-codex",
      model: "gpt-5.4",
      classification: "rate-limit",
      httpStatus: 429,
    }), 3)

    expect(message).toBe(
      "slugger (chat): provider asked us to slow down; retrying now (attempt 2 of 3) while checking openai-codex / gpt-5.4",
    )
  })

  it("builds reporter callbacks that emit shared attempt and retry lines", async () => {
    const report = vi.fn()
    const reporter = createProviderPingProgressReporter(
      { provider: "openai-codex", model: "gpt-5.4" },
      report,
    )

    await reporter.onAttemptStart?.(1, 3)
    await reporter.onRetry?.(retryRecord({
      provider: "openai-codex",
      model: "gpt-5.4",
      classification: "rate-limit",
      httpStatus: 429,
    }), 3)

    expect(report).toHaveBeenNthCalledWith(1, "checking openai-codex / gpt-5.4 (attempt 1 of 3)...")
    expect(report).toHaveBeenNthCalledWith(2, "openai-codex / gpt-5.4: provider asked us to slow down; retrying now (attempt 2 of 3)")
  })

  it("covers reporter fallback metadata when model or classification is absent", async () => {
    const report = vi.fn()
    const reporter = createProviderPingProgressReporter(
      { provider: "anthropic" },
      report,
    )

    await reporter.onAttemptStart?.(2, 3)
    await reporter.onRetry?.(retryRecord({
      provider: "anthropic",
      model: "",
      classification: undefined,
    }), 3)

    expect(report).toHaveBeenNthCalledWith(1, "checking anthropic (attempt 2 of 3)...")
    expect(report).toHaveBeenNthCalledWith(2, "anthropic: last check failed; retrying now (attempt 2 of 3)")
  })
})
