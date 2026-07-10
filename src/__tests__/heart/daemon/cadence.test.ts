import { describe, expect, it } from "vitest"

import {
  parseCadenceToCron,
  parseCadenceToMs,
  cadenceFallbackDelayMs,
  DEFAULT_CADENCE_MS,
  evaluateCadenceDue,
  nextCadenceRunAt,
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

describe("fixed-time cadence helpers", () => {
  it("computes next local run times for fixed daily cron cadences", () => {
    const beforeTen = new Date(2026, 6, 9, 9, 30, 0, 0).getTime()
    const afterTen = new Date(2026, 6, 9, 10, 30, 0, 0).getTime()

    expect(nextCadenceRunAt("0 10 * * *", beforeTen)).toBe(new Date(2026, 6, 9, 10, 0, 0, 0).toISOString())
    expect(nextCadenceRunAt("0 10 * * *", afterTen)).toBe(new Date(2026, 6, 10, 10, 0, 0, 0).toISOString())
    expect(cadenceFallbackDelayMs("0 10 * * *", beforeTen)).toBe(30 * 60 * 1000)
  })

  it("detects fixed daily overdue windows using the civil occurrence, not elapsed intervals", () => {
    const now = new Date(2026, 6, 9, 10, 5, 0, 0).getTime()
    const occurrence = new Date(2026, 6, 9, 10, 0, 0, 0).toISOString()

    expect(evaluateCadenceDue("0 10 * * *", null, now)).toEqual({
      due: true,
      elapsedMs: Infinity,
      occurrenceId: `fixed-daily:${occurrence}:cadence:0 10 * * *`,
    })
    expect(evaluateCadenceDue("0 10 * * *", new Date(2026, 6, 9, 9, 59, 0, 0).toISOString(), now)).toEqual({
      due: true,
      elapsedMs: 5 * 60 * 1000,
      occurrenceId: `fixed-daily:${occurrence}:cadence:0 10 * * *`,
    })
    expect(evaluateCadenceDue("0 10 * * *", new Date(2026, 6, 9, 10, 1, 0, 0).toISOString(), now)).toEqual({
      due: false,
      elapsedMs: 5 * 60 * 1000,
      occurrenceId: null,
    })
  })

  it("reuses interval semantics for next-run, fallback, and overdue helpers", () => {
    const start = new Date("2026-07-09T12:00:00.000Z")

    expect(nextCadenceRunAt("30m", start)).toBe("2026-07-09T12:30:00.000Z")
    expect(cadenceFallbackDelayMs("30m", start.getTime())).toBe(30 * 60 * 1000)
    expect(evaluateCadenceDue("30m", null, start.getTime())).toEqual({
      due: true,
      elapsedMs: Infinity,
      occurrenceId: "overdue:first-run:30m",
    })
    expect(evaluateCadenceDue("30m", "not-a-date", start.getTime())).toEqual({
      due: false,
      elapsedMs: 0,
      occurrenceId: null,
    })
    expect(evaluateCadenceDue("30m", "2026-07-09T11:00:00.000Z", start.getTime())).toEqual({
      due: true,
      elapsedMs: 60 * 60 * 1000,
      occurrenceId: "overdue:last-run:2026-07-09T11:00:00.000Z:cadence:30m",
    })
    expect(evaluateCadenceDue("30m", "2026-07-09T11:45:00.000Z", start.getTime())).toEqual({
      due: false,
      elapsedMs: 15 * 60 * 1000,
      occurrenceId: null,
    })
  })

  it("rejects invalid fixed daily cron shapes in timing helpers", () => {
    const now = new Date(2026, 6, 9, 9, 30, 0, 0)

    expect(nextCadenceRunAt(null as never, now)).toBeNull()
    expect(nextCadenceRunAt("nonsense", now.toISOString())).toBeNull()
    expect(nextCadenceRunAt("0 10 1 * *", now.getTime())).toBeNull()
    expect(nextCadenceRunAt("*/10 10 * * *", now.getTime())).toBeNull()
    expect(nextCadenceRunAt("0 x * * *", now.getTime())).toBeNull()
    expect(nextCadenceRunAt("60 10 * * *", now.getTime())).toBeNull()
    expect(nextCadenceRunAt("0 24 * * *", now.getTime())).toBeNull()
    expect(nextCadenceRunAt("0 10 * * *", "bad-date")).toBeNull()
    expect(cadenceFallbackDelayMs("not-cron", now.getTime())).toBeNull()
    expect(evaluateCadenceDue("not-cron", null, now.getTime())).toBeNull()
  })

  it("uses the previous local fixed occurrence before today's configured time", () => {
    const beforeTen = new Date(2026, 6, 9, 9, 5, 0, 0).getTime()
    const previousOccurrence = new Date(2026, 6, 8, 10, 0, 0, 0).toISOString()

    expect(evaluateCadenceDue("0 10 * * *", new Date(2026, 6, 8, 9, 59, 0, 0).toISOString(), beforeTen)).toEqual({
      due: true,
      elapsedMs: beforeTen - new Date(previousOccurrence).getTime(),
      occurrenceId: `fixed-daily:${previousOccurrence}:cadence:0 10 * * *`,
    })
    expect(evaluateCadenceDue("0 10 * * *", null, beforeTen)).toEqual({
      due: false,
      elapsedMs: Infinity,
      occurrenceId: null,
    })
  })
})

describe("DEFAULT_CADENCE_MS", () => {
  it("is 30 minutes in milliseconds", () => {
    expect(DEFAULT_CADENCE_MS).toBe(30 * 60 * 1000)
  })
})
