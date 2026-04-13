import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderErrorClassification } from "../../heart/core"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  DEFAULT_PROVIDER_ATTEMPT_POLICY,
  ProviderAttemptAbortError,
  runProviderAttempt,
} from "../../heart/provider-attempt"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function errorWithStatus(message: string, status?: number): Error {
  return status === undefined ? new Error(message) : Object.assign(new Error(message), { status })
}

describe("provider attempt runner", () => {
  beforeEach(() => {
    mockEmitNervesEvent.mockClear()
  })

  it("defines the bounded shared provider attempt policy", () => {
    emitTestEvent("provider attempt default policy")

    expect(DEFAULT_PROVIDER_ATTEMPT_POLICY).toEqual({
      maxAttempts: 3,
      baseDelayMs: 2_000,
      backoffMultiplier: 2,
    })
  })

  it.each([
    { label: "auth failure", classification: "auth-failure" as const, error: errorWithStatus("token expired", 401) },
    { label: "400-class failure", classification: "unknown" as const, error: errorWithStatus("bad request", 400) },
    { label: "timeout", classification: "network-error" as const, error: Object.assign(errorWithStatus("Request timed out."), { code: "ETIMEDOUT" }) },
    { label: "network failure", classification: "network-error" as const, error: Object.assign(errorWithStatus("socket hang up"), { code: "ECONNRESET" }) },
    { label: "provider failure", classification: "server-error" as const, error: errorWithStatus("provider overloaded", 503) },
    { label: "SDK failure", classification: "unknown" as const, error: errorWithStatus("SDK exploded") },
  ])("retries $label before succeeding", async ({ classification, error }) => {
    emitTestEvent(`provider attempt retries ${classification}`)
    const run = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("pong")
    const sleep = vi.fn(async () => undefined)

    const result = await runProviderAttempt({
      operation: "ping",
      provider: "minimax",
      model: "MiniMax-M2.5",
      run,
      classifyError: () => classification,
      sleep,
      policy: { maxAttempts: 3, baseDelayMs: 5, backoffMultiplier: 2 },
    })

    expect(result).toEqual({
      ok: true,
      value: "pong",
      attempts: [
        expect.objectContaining({
          attempt: 1,
          ok: false,
          provider: "minimax",
          model: "MiniMax-M2.5",
          operation: "ping",
          classification,
          errorMessage: error.message,
          httpStatus: "status" in error ? (error as Error & { status?: number }).status ?? null : null,
          willRetry: true,
          delayMs: 5,
        }),
        expect.objectContaining({
          attempt: 2,
          ok: false,
          classification,
          willRetry: true,
          delayMs: 10,
        }),
        expect.objectContaining({
          attempt: 3,
          ok: true,
          provider: "minimax",
          model: "MiniMax-M2.5",
          operation: "ping",
          willRetry: false,
        }),
      ],
    })
    expect(run).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 5)
    expect(sleep).toHaveBeenNthCalledWith(2, 10)
  })

  it("returns terminal attempt metadata after bounded failures", async () => {
    emitTestEvent("provider attempt bounded terminal")
    const finalError = errorWithStatus("still unauthorized", 401)
    const run = vi.fn(async () => { throw finalError })
    const sleep = vi.fn(async () => undefined)

    const result = await runProviderAttempt({
      operation: "turn",
      provider: "openai-codex",
      model: "gpt-5.4",
      run,
      classifyError: () => "auth-failure",
      sleep,
      policy: { maxAttempts: 3, baseDelayMs: 1, backoffMultiplier: 3 },
    })

    expect(result).toEqual({
      ok: false,
      error: finalError,
      classification: "auth-failure",
      attempts: [
        expect.objectContaining({ attempt: 1, ok: false, willRetry: true, delayMs: 1 }),
        expect.objectContaining({ attempt: 2, ok: false, willRetry: true, delayMs: 3 }),
        expect.objectContaining({
          attempt: 3,
          ok: false,
          willRetry: false,
          classification: "auth-failure",
          errorMessage: "still unauthorized",
          httpStatus: 401,
        }),
      ],
    })
    expect(run).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("calls onRetry with attempt metadata before sleeping", async () => {
    emitTestEvent("provider attempt onRetry")
    const error = errorWithStatus("provider unavailable", 503)
    const onRetry = vi.fn()
    const sleep = vi.fn(async () => undefined)

    const result = await runProviderAttempt({
      operation: "turn",
      provider: "minimax",
      model: "MiniMax-M2.5",
      run: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok"),
      classifyError: () => "server-error",
      onRetry,
      sleep,
      policy: { maxAttempts: 2, baseDelayMs: 11, backoffMultiplier: 2 },
    })

    expect(result.ok).toBe(true)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      provider: "minimax",
      model: "MiniMax-M2.5",
      operation: "turn",
      classification: "server-error",
      willRetry: true,
      delayMs: 11,
    }), 2)
    expect(sleep).toHaveBeenCalledWith(11)
  })

  it("rethrows provider attempt abort control flow without retrying", async () => {
    emitTestEvent("provider attempt abort")
    const abortError = new ProviderAttemptAbortError("stopped")
    const run = vi.fn(async () => { throw abortError })
    const sleep = vi.fn(async () => undefined)

    await expect(runProviderAttempt({
      operation: "turn",
      provider: "openai-codex",
      model: "gpt-5.4",
      run,
      classifyError: () => "unknown",
      sleep,
    })).rejects.toBe(abortError)

    expect(run).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("classifies non-Error throws as unknown while preserving metadata", async () => {
    emitTestEvent("provider attempt non-error throw")
    const run = vi.fn(async () => { throw "plain string" }) // eslint-disable-line no-throw-literal
    const sleep = vi.fn(async () => undefined)

    const result = await runProviderAttempt({
      operation: "discovery",
      provider: "anthropic",
      model: "claude-opus-4-6",
      run,
      classifyError: () => "server-error",
      sleep,
      policy: { maxAttempts: 1, baseDelayMs: 1, backoffMultiplier: 2 },
    })

    expect(result).toMatchObject({
      ok: false,
      classification: "unknown",
      attempts: [{
        attempt: 1,
        ok: false,
        classification: "unknown",
        errorMessage: "plain string",
        willRetry: false,
      }],
    })
    expect(sleep).not.toHaveBeenCalled()
  })

  it("emits structured nerves events for retries and terminal failure", async () => {
    emitTestEvent("provider attempt nerves events")
    const error = errorWithStatus("provider down", 503)

    await runProviderAttempt({
      operation: "health-check",
      provider: "github-copilot",
      model: "gpt-5.4",
      run: vi.fn(async () => { throw error }),
      classifyError: () => "server-error" as ProviderErrorClassification,
      sleep: vi.fn(async () => undefined),
      policy: { maxAttempts: 2, baseDelayMs: 7, backoffMultiplier: 2 },
    })

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "engine",
      event: "engine.provider_attempt_retry",
      meta: expect.objectContaining({
        provider: "github-copilot",
        model: "gpt-5.4",
        operation: "health-check",
        attempt: 1,
        maxAttempts: 2,
        classification: "server-error",
        delayMs: 7,
      }),
    }))
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "engine",
      event: "engine.provider_attempt_failed",
      meta: expect.objectContaining({
        provider: "github-copilot",
        model: "gpt-5.4",
        operation: "health-check",
        attempt: 2,
        maxAttempts: 2,
        classification: "server-error",
      }),
    }))
  })
})
