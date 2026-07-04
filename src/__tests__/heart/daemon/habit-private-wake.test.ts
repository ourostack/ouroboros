import { describe, expect, it } from "vitest"

import {
  buildHabitPrivateWakeCommand,
  habitMessageFromPrivateWakeCommand,
} from "../../../heart/daemon/habit-private-wake"

describe("habit private wake helpers", () => {
  it("builds canonical habit private wake commands", () => {
    expect(buildHabitPrivateWakeCommand({
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "manual",
      sourceRef: { kind: "daemon-command", id: "habit.poke" },
      occurrenceId: "manual-request-1",
      now: () => new Date("2026-07-04T08:00:00.000Z"),
    })).toEqual({
      kind: "private.wake",
      agent: "slugger",
      reason: "habit heartbeat fired by manual",
      triggerSource: "habit-manual",
      budgetClass: "scheduled",
      idempotencyKey: "habit:slugger:heartbeat:manual:manual-request-1",
      originRefs: [
        { kind: "habit", id: "heartbeat" },
        { kind: "habit-trigger", id: "manual" },
        { kind: "habit-occurrence", id: "manual-request-1" },
        { kind: "daemon-command", id: "habit.poke" },
      ],
    })
  })

  it("recovers habit worker messages from canonical private wake commands", () => {
    const command = buildHabitPrivateWakeCommand({
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "launchd",
      sourceRef: { kind: "daemon-entry", id: "habit-scheduler" },
      now: () => new Date("2026-07-04T08:05:00.000Z"),
    })

    expect(habitMessageFromPrivateWakeCommand(command)).toEqual({
      habitName: "heartbeat",
      trigger: "launchd",
    })
  })

  it("ignores non-habit private wake commands", () => {
    expect(habitMessageFromPrivateWakeCommand({ kind: "inner.wake", agent: "slugger" })).toBeNull()
    expect(habitMessageFromPrivateWakeCommand({
      kind: "private.wake",
      agent: "slugger",
      triggerSource: "manual",
      originRefs: [
        { kind: "habit", id: "heartbeat" },
        { kind: "habit-trigger", id: "cron" },
      ],
    })).toBeNull()
  })

  it("ignores malformed habit private wake origin refs", () => {
    expect(habitMessageFromPrivateWakeCommand({
      kind: "private.wake",
      agent: "slugger",
      triggerSource: "habit-cron",
      originRefs: [{ kind: "habit-trigger", id: "cron" }],
    })).toBeNull()
    expect(habitMessageFromPrivateWakeCommand({
      kind: "private.wake",
      agent: "slugger",
      triggerSource: "habit-cron",
      originRefs: [{ kind: "habit", id: "heartbeat" }],
    })).toBeNull()
    expect(habitMessageFromPrivateWakeCommand({
      kind: "private.wake",
      agent: "slugger",
      triggerSource: "habit-cron",
      originRefs: [
        { kind: "habit", id: "  " },
        { kind: "habit-trigger", id: "cron" },
      ],
    })).toBeNull()
  })

  it("ignores invalid or mismatched habit trigger provenance", () => {
    expect(habitMessageFromPrivateWakeCommand({
      kind: "private.wake",
      agent: "slugger",
      triggerSource: "habit-cron",
      originRefs: [
        { kind: "habit", id: "heartbeat" },
        { kind: "habit-trigger", id: "banana" },
      ],
    })).toBeNull()
    expect(habitMessageFromPrivateWakeCommand({
      kind: "private.wake",
      agent: "slugger",
      triggerSource: "habit-cron",
      originRefs: [
        { kind: "habit", id: "heartbeat" },
        { kind: "habit-trigger", id: "manual" },
      ],
    })).toBeNull()
  })
})
