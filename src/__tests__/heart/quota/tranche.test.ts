import { describe, expect, it } from "vitest"
import { DEFAULT_TRANCHE_CAPS, pickByTranche, trancheCap, usedPct, type QuotaReading } from "../../../heart/quota/tranche"

const reading = (key: string, usedPct: number | null, overageOk = false): QuotaReading => ({
  key,
  leftPct: usedPct === null ? null : 100 - usedPct,
  burnPerH: null,
  dryAt: null,
  overageOk,
  at: "2026-11-10T02:00:00.000Z",
})

const A = "a@msft.ghe.com"
const B = "a@microsoft.ghe.com"
const C = "a_microsoft@github.com"

describe("trancheCap", () => {
  it("uses the default 30/60/90/100 caps", () => {
    expect(DEFAULT_TRANCHE_CAPS).toEqual([30, 60, 90, 100])
  })

  it("is the lowest cap some eligible account is still below", () => {
    expect(trancheCap([reading(A, 5), reading(B, 71)], [A, B])).toBe(30)
  })

  it("rises only when every eligible account has reached it", () => {
    expect(trancheCap([reading(A, 30), reading(B, 71)], [A, B])).toBe(60)
    expect(trancheCap([reading(A, 59), reading(B, 71)], [A, B])).toBe(60)
    expect(trancheCap([reading(A, 60), reading(B, 71)], [A, B])).toBe(90)
  })

  it("ignores accounts that are not eligible", () => {
    expect(trancheCap([reading(A, 95), reading(C, 0)], [A])).toBe(100)
  })

  it("stays at the last cap once every account is spent", () => {
    expect(trancheCap([reading(A, 100), reading(B, 100)], [A, B])).toBe(100)
  })

  it("counts only accounts with a reading, like the app balancer", () => {
    expect(trancheCap([reading(A, 95), reading(B, null)], [A, B])).toBe(100)
    expect(trancheCap([reading(A, 45)], [A, B])).toBe(60)
    expect(trancheCap([], [A, B])).toBe(100)
  })

  it("accepts custom caps", () => {
    expect(trancheCap([reading(A, 55)], [A], [50, 100])).toBe(100)
  })
})

describe("pickByTranche", () => {
  const order = [A, B, C]

  it("stays on the current account below the cap", () => {
    const readings = [reading(A, 10), reading(B, 20)]
    expect(pickByTranche(B, readings, [A, B], order, 30)).toBe(B)
  })

  it("moves at the cap to the next account in order that is below it", () => {
    const readings = [reading(A, 30), reading(B, 20)]
    expect(pickByTranche(A, readings, [A, B], order, 30)).toBe(B)
  })

  it("starts on the first account in order that is below the cap", () => {
    const readings = [reading(A, 40), reading(B, 20)]
    expect(pickByTranche(null, readings, [A, B], order, 30)).toBe(B)
  })

  it("leaves an account that is no longer eligible", () => {
    const readings = [reading(A, 10), reading(B, 10)]
    expect(pickByTranche(A, readings, [B], order, 30)).toBe(B)
  })

  it("takes accounts outside the order after it, in eligible order", () => {
    const readings = [reading(A, 50), reading("x@github.com", 0)]
    expect(pickByTranche(null, readings, [A, "x@github.com"], [A], 30)).toBe("x@github.com")
  })

  it("never picks an account without a reading", () => {
    expect(pickByTranche(A, [reading(B, 10)], [A, B], order, 30)).toBe(B)
    expect(pickByTranche(A, [reading(A, null)], [A], order, 30)).toBeNull()
  })

  it("returns null once every account is spent: that means enterprise overage", () => {
    const spent = [reading(A, 100, true), reading(B, 100, true)]
    expect(pickByTranche(A, spent, [A, B], order, 100)).toBeNull()
    expect(pickByTranche(null, [], [], order, 30)).toBeNull()
  })
})

describe("usedPct", () => {
  it("is null without a reading and clamps to 0-100", () => {
    expect(usedPct(undefined)).toBeNull()
    expect(usedPct(reading(A, null))).toBeNull()
    expect(usedPct(reading(A, 25))).toBe(25)
    expect(usedPct({ ...reading(A, 0), leftPct: 120 })).toBe(0)
    expect(usedPct({ ...reading(A, 0), leftPct: -5 })).toBe(100)
  })
})
