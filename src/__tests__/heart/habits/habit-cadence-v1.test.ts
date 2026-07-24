import { CronExpressionParser } from "cron-parser"
import { describe, expect, it, vi } from "vitest"

import {
  occurrenceIdentityForScheduledSlot,
  parseHabitCadenceV1,
  parseScheduleProvenanceV1,
  reconcileScheduleProvenanceV1,
  scheduledSlotAtOrBefore,
} from "../../../heart/habits/habit-cadence-v1"

describe("habit cadence v1", () => {
  it("accepts positive interval shorthand and strict portable numeric five-field cron", () => {
    expect(parseHabitCadenceV1("30m", {
      created: "2026-07-01T00:00:00.000Z",
      cadenceTimezone: null,
      machineTimezone: "America/Los_Angeles",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toEqual({
      version: 1,
      kind: "interval",
      intervalMs: 1_800_000,
      anchorUtc: "2026-07-01T00:00:00.000Z",
      anchorSource: "habit-created",
    })
    expect(parseHabitCadenceV1("*/30 * * * *", {
      created: null,
      cadenceTimezone: "America/New_York",
      machineTimezone: "America/Los_Angeles",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toEqual({
      version: 1,
      kind: "cron",
      expression: "*/30 * * * *",
      timezone: "America/New_York",
      timezoneSource: "declared",
    })
  })

  it.each([
    "0m",
    "01m",
    "H * * * *",
    "0 L * * *",
    "0 0 W * *",
    "0 0 * * 1#2",
    "0 0 ? * *",
    "0 0 * JAN *",
    "@daily",
    "0 0 0 * * *",
    "0\u00a00 * * *",
    "0 0 * *",
    "0 0 * * * trailing",
    "61 * * * *",
    "0 0 1 * 1",
  ])("rejects nonportable or invalid cadence %s", (cadence) => {
    expect(() => parseHabitCadenceV1(cadence, {
      created: null,
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow()
  })

  it("persists first-seen anchors and machine timezone across reconciliation", () => {
    const first = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "morning",
      cadence: "2h",
      cadenceTimezone: null,
      created: null,
      machineTimezone: "America/Los_Angeles",
      now: "2026-07-24T01:02:03.000Z",
    })
    expect(first.normalized).toMatchObject({
      kind: "interval",
      anchorUtc: "2026-07-24T01:02:03.000Z",
      anchorSource: "schedule-state-first-seen",
    })
    const stable = reconcileScheduleProvenanceV1({
      prior: first,
      agent: "slugger",
      habitId: "morning",
      cadence: "2h",
      cadenceTimezone: null,
      created: null,
      machineTimezone: "Europe/London",
      now: "2026-07-25T01:02:03.000Z",
    })
    expect(stable).toEqual(first)

    const cron = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "daily",
      cadence: "0 10 * * *",
      cadenceTimezone: null,
      created: null,
      machineTimezone: "America/Los_Angeles",
      now: "2026-07-24T01:02:03.000Z",
    })
    const changed = reconcileScheduleProvenanceV1({
      prior: cron,
      agent: "slugger",
      habitId: "daily",
      cadence: "30 10 * * *",
      cadenceTimezone: null,
      created: null,
      machineTimezone: "Europe/London",
      now: "2026-07-25T01:02:03.000Z",
    })
    expect(changed.normalized).toMatchObject({ timezone: "America/Los_Angeles", timezoneSource: "machine-first-seen" })
    expect(changed.scheduleRevision).not.toBe(cron.scheduleRevision)
    expect(changed.recordVersion).toBe(2)
  })

  it("computes canonical interval and cron slots without lastRun", () => {
    const interval = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "pulse",
      cadence: "30m",
      cadenceTimezone: null,
      created: "2026-07-24T00:00:00.000Z",
      machineTimezone: "UTC",
      now: "2026-07-24T00:00:00.000Z",
    })
    const intervalSlot = scheduledSlotAtOrBefore(interval, "2026-07-24T01:29:59.999Z")
    expect(intervalSlot?.scheduledAtUtc).toBe("2026-07-24T01:00:00.000Z")
    expect(occurrenceIdentityForScheduledSlot("slugger", "pulse", intervalSlot!)).toMatchObject({
      occurrenceId: expect.stringMatching(/^occ_[A-Za-z0-9_-]{43}$/),
      slotKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })

    const folded = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "folded",
      cadence: "30 1 * * *",
      cadenceTimezone: "America/Los_Angeles",
      created: null,
      machineTimezone: "UTC",
      now: "2026-10-01T00:00:00.000Z",
    })
    expect(scheduledSlotAtOrBefore(folded, "2026-11-01T08:45:00.000Z")?.scheduledAtUtc).toBe("2026-11-01T08:30:00.000Z")
    expect(scheduledSlotAtOrBefore(folded, "2026-11-01T09:45:00.000Z")?.scheduledAtUtc).toBe("2026-11-01T09:30:00.000Z")

    const gap = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "gap",
      cadence: "30 2 * * *",
      cadenceTimezone: "America/Los_Angeles",
      created: null,
      machineTimezone: "UTC",
      now: "2026-02-01T00:00:00.000Z",
    })
    expect(scheduledSlotAtOrBefore(gap, "2026-03-08T10:45:00.000Z")?.scheduledAtUtc).toBe("2026-03-07T10:30:00.000Z")
  })

  it("locks canonical revision and slot identity fixtures", () => {
    const schedule = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "fixture-agent",
      habitId: "fixture-habit",
      cadence: "30m",
      cadenceTimezone: null,
      created: "2026-07-24T00:00:00.000Z",
      machineTimezone: "UTC",
      now: "2026-07-24T00:00:00.000Z",
    })
    expect(schedule.scheduleRevision).toBe("bWnlwqgGU_Bm9g92iZQZtkBZDJIsoPuvtjWRmnk1TTo")
    expect(scheduledSlotAtOrBefore(schedule, "2026-07-24T01:29:59.999Z")).toEqual({
      kind: "scheduled",
      slotKey: "2rQzzdLcwofBAYtx-GD8hYfK23Wn-VSG7Rw0Aq8-xH0",
      scheduleRevision: "bWnlwqgGU_Bm9g92iZQZtkBZDJIsoPuvtjWRmnk1TTo",
      scheduledAtUtc: "2026-07-24T01:00:00.000Z",
    })
  })

  it("rejects every malformed persisted schedule provenance class", () => {
    const interval = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "pulse",
      cadence: "30m",
      cadenceTimezone: null,
      created: "2026-07-24T00:00:00.000Z",
      machineTimezone: "UTC",
      now: "2026-07-24T00:00:00.000Z",
    })
    const cron = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "daily",
      cadence: "0 10 * * *",
      cadenceTimezone: "UTC",
      created: null,
      machineTimezone: "UTC",
      now: "2026-07-24T00:00:00.000Z",
    })
    const mutations: unknown[] = [
      null,
      { ...interval, unexpected: true },
      { ...interval, schemaVersion: 2 },
      { ...interval, normalized: { ...interval.normalized, intervalMs: 0 } },
      { ...interval, normalized: { ...interval.normalized, kind: "other" } },
      { ...cron, normalized: { ...cron.normalized, timezoneSource: "other" } },
      { ...cron, normalized: { ...cron.normalized, expression: "0 0 32 * *" } },
      { ...cron, definitionSha256: "bad" },
      { ...cron, cadenceText: "" },
      { ...cron, cadenceTimezone: "Mars/Olympus" },
      { ...cron, firstSeenAt: "bad" },
      { ...cron, updatedAt: "2026-07-23T23:59:59.000Z" },
    ]
    for (const value of mutations) expect(() => parseScheduleProvenanceV1(value)).toThrow()
    vi.spyOn(CronExpressionParser, "parse").mockImplementationOnce(() => { throw "parser-failed" })
    expect(() => parseScheduleProvenanceV1(cron)).toThrow(/parse failed/)
    expect(() => reconcileScheduleProvenanceV1({
      prior: interval,
      agent: "another-agent",
      habitId: "pulse",
      cadence: "30m",
      cadenceTimezone: null,
      created: "2026-07-24T00:00:00.000Z",
      machineTimezone: "UTC",
      now: "2026-07-24T00:00:00.000Z",
    })).toThrow(/another habit/)
  })

  it("rejects invalid dates and IANA zones", () => {
    expect(() => parseHabitCadenceV1("1h", {
      created: "not-a-date",
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/created/)
    expect(() => parseHabitCadenceV1("0 10 * * *", {
      created: null,
      cadenceTimezone: "Mars/Olympus",
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/timezone/)
  })

  it("covers interval boundaries, inherited anchors, and pre-anchor selection", () => {
    expect(parseHabitCadenceV1("1d", {
      created: "2026-07-24T00:00:00.000Z",
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toMatchObject({ kind: "interval", intervalMs: 86_400_000 })
    expect(() => parseHabitCadenceV1("999999999999999999999999999m", {
      created: null,
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/safe range/)
    expect(() => parseHabitCadenceV1(30 as never, {
      created: null,
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/string/)
    expect(() => parseHabitCadenceV1("", {
      created: null,
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/empty/)
    expect(() => parseHabitCadenceV1("0 10 * * *", {
      created: null,
      cadenceTimezone: "",
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/timezone/)

    const prior = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "interval",
      cadence: "1h",
      cadenceTimezone: null,
      created: null,
      machineTimezone: "UTC",
      now: "2026-07-24T10:00:00.000Z",
    })
    expect(parseHabitCadenceV1("2h", {
      created: null,
      cadenceTimezone: null,
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T11:00:00.000Z",
      prior,
    })).toMatchObject({ anchorUtc: "2026-07-24T10:00:00.000Z", anchorSource: "schedule-state-first-seen" })
    expect(scheduledSlotAtOrBefore(prior, "2026-07-24T09:59:59.999Z")).toBeNull()
  })

  it("normalizes non-Error parser failures and rejects a null cron predecessor", () => {
    vi.spyOn(CronExpressionParser, "parse").mockImplementationOnce(() => { throw "parser-failed" })
    expect(() => parseHabitCadenceV1("0 10 * * *", {
      created: null,
      cadenceTimezone: "UTC",
      machineTimezone: "UTC",
      firstSeenAt: "2026-07-24T00:00:00.000Z",
    })).toThrow(/parse failed/)

    const schedule = reconcileScheduleProvenanceV1({
      prior: null,
      agent: "slugger",
      habitId: "daily",
      cadence: "0 10 * * *",
      cadenceTimezone: "UTC",
      created: null,
      machineTimezone: "UTC",
      now: "2026-07-24T00:00:00.000Z",
    })
    vi.spyOn(CronExpressionParser, "parse").mockReturnValueOnce({
      prev: () => ({ toISOString: () => null }),
    } as never)
    expect(() => scheduledSlotAtOrBefore(schedule, "2026-07-24T10:00:00.000Z")).toThrow(/prior slot/)
  })
})
