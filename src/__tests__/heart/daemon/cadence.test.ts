import { describe, expect, it } from "vitest"

import {
  parseCadenceToCron,
  parseCadenceToMs,
  DEFAULT_CADENCE_MS,
} from "../../../heart/daemon/cadence"

describe("parseCadenceToCron", () => {
  it("converts minutes shorthand to cron", () => {
    expect(parseCadenceToCron("30m")).toBe("*/30 * * * *")
    expect(parseCadenceToCron("1m")).toBe("*/1 * * * *")
    expect(parseCadenceToCron("15m")).toBe("*/15 * * * *")
  })

  it("converts hours shorthand to cron", () => {
    expect(parseCadenceToCron("1h")).toBe("0 */1 * * *")
    expect(parseCadenceToCron("2h")).toBe("0 */2 * * *")
    expect(parseCadenceToCron("6h")).toBe("0 */6 * * *")
  })

  it("converts days shorthand to cron", () => {
    expect(parseCadenceToCron("1d")).toBe("0 0 */1 * *")
    expect(parseCadenceToCron("2d")).toBe("0 0 */2 * *")
    expect(parseCadenceToCron("7d")).toBe("0 0 */7 * *")
  })

  it("passes through valid cron strings unchanged", () => {
    expect(parseCadenceToCron("*/15 * * * *")).toBe("*/15 * * * *")
    expect(parseCadenceToCron("0 */2 * * *")).toBe("0 */2 * * *")
    expect(parseCadenceToCron("0 0 1 * *")).toBe("0 0 1 * *")
  })

  it("returns null for invalid input", () => {
    expect(parseCadenceToCron("nonsense")).toBeNull()
    expect(parseCadenceToCron("")).toBeNull()
    expect(parseCadenceToCron("0m")).toBeNull()
    expect(parseCadenceToCron("-5m")).toBeNull()
    expect(parseCadenceToCron("abc")).toBeNull()
  })

  it("returns null for non-string input", () => {
    expect(parseCadenceToCron(null as unknown as string)).toBeNull()
    expect(parseCadenceToCron(undefined as unknown as string)).toBeNull()
    expect(parseCadenceToCron(42 as unknown as string)).toBeNull()
  })

  it("handles whitespace in input", () => {
    expect(parseCadenceToCron("  30m  ")).toBe("*/30 * * * *")
    expect(parseCadenceToCron("  ")).toBeNull()
  })
})

describe("parseCadenceToMs", () => {
  it("converts minutes to milliseconds", () => {
    expect(parseCadenceToMs("30m")).toBe(30 * 60 * 1000)
    expect(parseCadenceToMs("1m")).toBe(60 * 1000)
  })

  it("converts hours to milliseconds", () => {
    expect(parseCadenceToMs("1h")).toBe(60 * 60 * 1000)
    expect(parseCadenceToMs("2h")).toBe(2 * 60 * 60 * 1000)
  })

  it("converts days to milliseconds", () => {
    expect(parseCadenceToMs("1d")).toBe(24 * 60 * 60 * 1000)
    expect(parseCadenceToMs("7d")).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it("returns null for invalid strings", () => {
    expect(parseCadenceToMs("nonsense")).toBeNull()
    expect(parseCadenceToMs("")).toBeNull()
    expect(parseCadenceToMs("0m")).toBeNull()
    expect(parseCadenceToMs("-5m")).toBeNull()
  })

  it("returns null for non-string input", () => {
    expect(parseCadenceToMs(null as unknown as string)).toBeNull()
    expect(parseCadenceToMs(undefined as unknown as string)).toBeNull()
    expect(parseCadenceToMs(42 as unknown as string)).toBeNull()
  })

  it("handles whitespace in input", () => {
    expect(parseCadenceToMs("  30m  ")).toBe(30 * 60 * 1000)
    expect(parseCadenceToMs("  ")).toBeNull()
  })
})

describe("DEFAULT_CADENCE_MS", () => {
  it("is 30 minutes in milliseconds", () => {
    expect(DEFAULT_CADENCE_MS).toBe(30 * 60 * 1000)
  })
})
