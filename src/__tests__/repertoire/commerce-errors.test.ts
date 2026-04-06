import { describe, it, expect, vi } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import {
  CommerceError,
  PaymentError,
  BookingError,
  ProfileError,
  retryOnce,
  priceChangeGuard,
  partialFailureReport,
} from "../../repertoire/commerce-errors"

describe("CommerceError", () => {
  it("extends Error with code and meta", () => {
    const err = new CommerceError("test error", "COMMERCE_GENERIC", { detail: "info" })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("test error")
    expect(err.code).toBe("COMMERCE_GENERIC")
    expect(err.meta).toEqual({ detail: "info" })
    expect(err.name).toBe("CommerceError")
  })

  it("has correct stack trace", () => {
    const err = new CommerceError("stacktrace test", "COMMERCE_GENERIC")
    expect(err.stack).toContain("CommerceError")
  })
})

describe("PaymentError", () => {
  it("extends CommerceError", () => {
    const err = new PaymentError("payment failed", "PAYMENT_DECLINED", { amount: 100 })
    expect(err).toBeInstanceOf(CommerceError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("PAYMENT_DECLINED")
    expect(err.name).toBe("PaymentError")
  })
})

describe("BookingError", () => {
  it("extends CommerceError", () => {
    const err = new BookingError("booking failed", "BOOKING_UNAVAILABLE", { flightId: "123" })
    expect(err).toBeInstanceOf(CommerceError)
    expect(err.code).toBe("BOOKING_UNAVAILABLE")
    expect(err.name).toBe("BookingError")
  })
})

describe("ProfileError", () => {
  it("extends CommerceError", () => {
    const err = new ProfileError("profile missing", "PROFILE_NOT_FOUND")
    expect(err).toBeInstanceOf(CommerceError)
    expect(err.code).toBe("PROFILE_NOT_FOUND")
    expect(err.name).toBe("ProfileError")
  })
})

describe("retryOnce", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("success")
    const result = await retryOnce(fn)
    expect(result).toBe("success")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries once on transient error then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new CommerceError("timeout", "COMMERCE_TRANSIENT"))
      .mockResolvedValueOnce("retry-success")
    const result = await retryOnce(fn)
    expect(result).toBe("retry-success")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("throws on second failure after retry", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new CommerceError("timeout", "COMMERCE_TRANSIENT"))
      .mockRejectedValueOnce(new CommerceError("timeout again", "COMMERCE_TRANSIENT"))
    await expect(retryOnce(fn)).rejects.toThrow("timeout again")
  })

  it("does not retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new PaymentError("declined", "PAYMENT_DECLINED"))
    await expect(retryOnce(fn)).rejects.toThrow("declined")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("does not retry non-CommerceError errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("random error"))
    await expect(retryOnce(fn)).rejects.toThrow("random error")
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("priceChangeGuard", () => {
  it("passes when price is unchanged", () => {
    expect(() => priceChangeGuard(100, 100)).not.toThrow()
  })

  it("passes when price change is within 5%", () => {
    expect(() => priceChangeGuard(100, 104)).not.toThrow()
    expect(() => priceChangeGuard(100, 96)).not.toThrow()
  })

  it("throws when price increased more than 5%", () => {
    expect(() => priceChangeGuard(100, 106)).toThrow(PaymentError)
    expect(() => priceChangeGuard(100, 106)).toThrow(/price changed/)
  })

  it("throws when price decreased more than 5%", () => {
    expect(() => priceChangeGuard(100, 94)).toThrow(PaymentError)
  })

  it("handles exactly 5% boundary (passes)", () => {
    expect(() => priceChangeGuard(100, 105)).not.toThrow()
    expect(() => priceChangeGuard(100, 95)).not.toThrow()
  })

  it("handles zero approved price", () => {
    expect(() => priceChangeGuard(0, 0)).not.toThrow()
    expect(() => priceChangeGuard(0, 1)).toThrow(PaymentError)
  })
})

describe("partialFailureReport", () => {
  it("formats all-success report", () => {
    const report = partialFailureReport([
      { service: "flight", status: "success" },
      { service: "hotel", status: "success" },
    ])
    expect(report).toContain("flight")
    expect(report).toContain("hotel")
    expect(report).toContain("success")
  })

  it("formats partial failure report", () => {
    const report = partialFailureReport([
      { service: "flight", status: "success" },
      { service: "hotel", status: "failed", error: "no availability" },
    ])
    expect(report).toContain("flight")
    expect(report).toContain("success")
    expect(report).toContain("hotel")
    expect(report).toContain("failed")
    expect(report).toContain("no availability")
  })

  it("formats all-failure report", () => {
    const report = partialFailureReport([
      { service: "flight", status: "failed", error: "API error" },
      { service: "hotel", status: "failed", error: "timeout" },
    ])
    expect(report).toContain("API error")
    expect(report).toContain("timeout")
  })

  it("handles empty service list", () => {
    const report = partialFailureReport([])
    expect(report).toContain("no services")
  })
})
