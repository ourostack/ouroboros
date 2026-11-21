import { describe, expect, it } from "vitest"
import { wilsonInterval } from "../../../eval/domain/stats"
import { wilsonInterval as shepherdWilsonInterval } from "../../../senses/shepherd/judge-evaluation"

describe("wilsonInterval", () => {
  it("gives the 95% interval for 10 of 10", () => {
    const interval = wilsonInterval(10, 10)
    expect(interval.n).toBe(10)
    expect(Number(interval.low!.toFixed(4))).toBe(0.7225)
    // Floating point gives 0.9999999999999999; the function moved unchanged, so the test rounds like the low bound.
    expect(Number(interval.high!.toFixed(4))).toBe(1)
  })

  it("returns null bounds for no runs and rejects impossible counts", () => {
    expect(wilsonInterval(0, 0)).toEqual({ n: 0, low: null, high: null })
    expect(() => wilsonInterval(3, 2)).toThrow("Invalid interval counts")
    expect(() => wilsonInterval(1.5, 2)).toThrow("Invalid interval counts")
  })

  it("is the same function Shepherd's evaluation exports", () => {
    expect(shepherdWilsonInterval).toBe(wilsonInterval)
  })
})
