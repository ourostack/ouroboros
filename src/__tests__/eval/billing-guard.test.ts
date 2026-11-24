import { expect, it } from "vitest"
import { billingRefusal, MIN_LEFT_PCT } from "../../eval/billing-guard"
import type { QuotaSnapshot } from "../../eval/targets"

const reading = (leftPct: number) => ({ leftPct }) as NonNullable<QuotaSnapshot["reading"]>

it("refuses a null reading", () => {
  expect(billingRefusal("shadow", { tokenBased: null, reading: null })).toBe("no quota reading for shadow")
  expect(billingRefusal("shadow", { tokenBased: true, reading: null })).toBe("no quota reading for shadow")
  expect(billingRefusal("shadow", { tokenBased: false, reading: { leftPct: null } as never })).toBe("no quota reading for shadow")
})

it("refuses a reading under 20% left, token-based or not", () => {
  expect(MIN_LEFT_PCT).toBe(20)
  expect(billingRefusal("shadow", { tokenBased: false, reading: reading(19.9) })).toBe("shadow has 19.9% of its quota left, under 20%")
  expect(billingRefusal("shadow", { tokenBased: false, reading: reading(0) })).toMatch(/0% of its quota left/)
  expect(billingRefusal("shadow", { tokenBased: true, reading: reading(5) })).toMatch(/5% of its quota left/)
})

it("allows 20% or more, and an unlimited token-based account, which reads as 100% left", () => {
  expect(billingRefusal("shadow", { tokenBased: false, reading: reading(20) })).toBeUndefined()
  expect(billingRefusal("shadow", { tokenBased: true, reading: reading(100) })).toBeUndefined()
})
